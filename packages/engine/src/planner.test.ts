import { describe, expect, test } from "bun:test";
import { plan } from "./planner.ts";
import { parsePatterns, type PatternSource } from "@skim/rules";
import type { ChangedFile, FileViewedState } from "@skim/github";

const file = (
  path: string,
  viewerViewedState: FileViewedState = "UNVIEWED",
  additions = 1,
  deletions = 1,
): ChangedFile => ({ path, changeType: "MODIFIED", additions, deletions, viewerViewedState });

const snapshots = (n: number, state: FileViewedState = "UNVIEWED") =>
  Array.from({ length: n }, (_, i) => file(`Tests/__Snapshots__/T/case${i}.txt`, state));

const swift: PatternSource = {
  name: "preset:swift",
  patterns: parsePatterns("**/__Snapshots__/**"),
};

describe("plan", () => {
  test("marks matching files and leaves real code alone", () => {
    const files = [...snapshots(10), file("Sources/App/Home.swift")];
    const p = plan(files, [swift], new Set());
    expect(p.toMark).toHaveLength(10);
    expect(p.toMark).not.toContain("Sources/App/Home.swift");
    expect(p.remaining).toBe(1);
    expect(p.allNoise).toBe(false);
  });

  test("never touches a file that already has review comments", () => {
    const files = snapshots(10);
    const p = plan(files, [swift], new Set(["Tests/__Snapshots__/T/case3.txt"]));
    expect(p.toMark).toHaveLength(9);
    expect(p.toMark).not.toContain("Tests/__Snapshots__/T/case3.txt");
    expect(p.skipped).toContainEqual({
      path: "Tests/__Snapshots__/T/case3.txt",
      reason: "has-review-thread",
    });
  });

  test("skips files already VIEWED — we did not set those and will not claim them", () => {
    const files = [...snapshots(6), ...snapshots(4).map((f) => ({ ...f, viewerViewedState: "VIEWED" as const, path: f.path + ".dup" }))];
    const p = plan(files, [swift], new Set());
    expect(p.toMark).toHaveLength(6);
    expect(p.skipped.filter((s) => s.reason === "already-viewed")).toHaveLength(4);
  });

  test("includes DISMISSED files — the file changed since it was last viewed", () => {
    const files = snapshots(10, "DISMISSED");
    const p = plan(files, [swift], new Set());
    expect(p.toMark).toHaveLength(10);
  });

  test("honours linguist-generated from .gitattributes as noise", () => {
    const files = [file("src/api/client.ts"), file("src/app.ts")];
    const p = plan(
      files,
      [{ name: ".gitattributes linguist-generated", patterns: ["src/api/**"] }],
      new Set(),
    );
    expect(p.toMark).toEqual(["src/api/client.ts"]);
    expect(p.matches.find((m) => m.path === "src/api/client.ts")!.source).toBe(
      ".gitattributes linguist-generated",
    );
  });

  test("acts on a small match set; there is no minimum", () => {
    // Removed deliberately: a PR with one lock file is exactly the case where
    // hiding it costs nothing, and a threshold only makes behaviour harder to
    // predict.
    const p = plan(snapshots(1), [swift], new Set());
    expect(p.toMark).toHaveLength(1);
  });

  describe("all-noise PR", () => {
    test("default marks everything and flags it", () => {
      const p = plan(snapshots(10), [swift], new Set());
      expect(p.allNoise).toBe(true);
      expect(p.toMark).toHaveLength(10);
      expect(p.remaining).toBe(0);
    });

    test("an all-noise PR marks every file; nothing is held back", () => {
      const p = plan(snapshots(9), [swift], new Set());
      expect(p.allNoise).toBe(true);
      expect(p.toMark).toHaveLength(9);
    });
  });

  test("a PR with nothing matching is not an all-noise PR", () => {
    const p = plan([file("Sources/App/Home.swift")], [swift], new Set());
    expect(p.allNoise).toBe(false);
    expect(p.toMark).toEqual([]);
  });

  test("the bench shape: 1800 snapshots + 12 swift files", () => {
    const files = [
      ...Array.from({ length: 1800 }, (_, i) =>
        file(`Tests/AppTests/__Snapshots__/T${i % 12}/case${i}.txt`),
      ),
      ...Array.from({ length: 12 }, (_, i) => file(`Sources/App/File${i}.swift`)),
    ];
    const p = plan(files, [swift], new Set());
    expect(p.toMark).toHaveLength(1800);
    expect(p.remaining).toBe(12);
    expect(p.toMark.some((x) => x.startsWith("Sources/App/"))).toBe(false);
  });
});
