import { describe, expect, test } from "bun:test";
import { plan } from "./planner.ts";
import { parsePatterns, type PatternSource } from "@skim/rules";
import type { ChangedFile, FileViewedState } from "@skim/github";

const file = (path: string, viewerViewedState: FileViewedState = "UNVIEWED"): ChangedFile => ({
  path,
  viewerViewedState,
});

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
    const files = [
      ...snapshots(6),
      ...snapshots(4).map((f) => ({
        ...f,
        viewerViewedState: "VIEWED" as const,
        path: f.path + ".dup",
      })),
    ];
    const p = plan(files, [swift], new Set());
    expect(p.toMark).toHaveLength(6);
    expect(p.skipped.filter((s) => s.reason === "already-viewed")).toHaveLength(4);
  });

  test("includes DISMISSED files — the file changed since it was last viewed", () => {
    const files = snapshots(10, "DISMISSED");
    const p = plan(files, [swift], new Set());
    expect(p.toMark).toHaveLength(10);
  });

  test("an all-noise PR marks every file and flags it", () => {
    const p = plan(snapshots(10), [swift], new Set());
    expect(p.allNoise).toBe(true);
    expect(p.toMark).toHaveLength(10);
    expect(p.remaining).toBe(0);
  });

  test("a PR with nothing matching is not an all-noise PR", () => {
    const p = plan([file("Sources/App/Home.swift")], [swift], new Set());
    expect(p.allNoise).toBe(false);
    expect(p.toMark).toEqual([]);
  });
});
