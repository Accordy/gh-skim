import { describe, expect, test } from "bun:test";
import { needsLanguages, resolveRules, type RuleInputs } from "./resolve.ts";
import { matchPaths } from "./matcher.ts";
import { UnknownPresetError } from "./presets.ts";

const fixture = (name: string) => Bun.file(new URL(`../fixtures/${name}`, import.meta.url)).text();

const inputs = (over: Partial<RuleInputs> = {}): RuleInputs => ({
  reviewIgnore: null,
  gitattributes: null,
  presetOverride: null,
  languages: [],
  ...over,
});

const BENCH_PATHS = [
  "Sources/App/HomeView.swift",
  "Sources/App/Generated/API.generated.swift",
  "Tests/AppTests/__Snapshots__/HomeViewTests/a.txt",
  "Tests/AppTests/__Snapshots__/ChallengeTests/b.txt",
  "Package.resolved",
];

describe("resolveRules", () => {
  test("falls back to language detection with no review-ignore", () => {
    const c = resolveRules(inputs({ languages: ["Swift", "Haskell"] }));
    expect(c.presets).toEqual(["swift"]);
    expect(c.presetOrigin).toBe("detected");
    expect(c.hasReviewIgnore).toBe(false);
  });

  test("the directive in review-ignore overrides detection", async () => {
    const c = resolveRules(
      inputs({ reviewIgnore: await fixture("review-ignore-swift"), languages: ["Go"] }),
    );
    expect(c.presets).toEqual(["swift"]);
    expect(c.presetOrigin).toBe("directive");
  });

  test("--preset overrides both the directive and detection", async () => {
    const c = resolveRules(
      inputs({
        reviewIgnore: await fixture("review-ignore-swift"),
        languages: ["Go"],
        presetOverride: ["node"],
      }),
    );
    expect(c.presets).toEqual(["node"]);
    expect(c.presetOrigin).toBe("flag");
  });

  test("'# preset: none' loads no presets at all", async () => {
    const c = resolveRules(
      inputs({ reviewIgnore: await fixture("review-ignore-none"), languages: ["Swift"] }),
    );
    expect(c.presets).toEqual([]);
    expect(c.sources.map((s) => s.name)).toEqual([".github/review-ignore"]);

    const r = matchPaths(c.sources, BENCH_PATHS);
    expect(r.find((x) => x.path === "Package.resolved")!.hidden).toBe(true);
    // Snapshots are NOT hidden: the swift preset was never loaded.
    expect(r.find((x) => x.path.includes("__Snapshots__"))!.hidden).toBe(false);
  });

  test("an unknown preset in the directive is refused, not silently skipped", () => {
    expect(() => resolveRules(inputs({ reviewIgnore: "# preset: kotlin\n" }))).toThrow(
      UnknownPresetError,
    );
  });

  describe("precedence: presets, then linguist-generated, then review-ignore", () => {
    test("sources are ordered lowest priority first", async () => {
      const c = resolveRules(
        inputs({
          reviewIgnore: await fixture("review-ignore-swift"),
          gitattributes: await fixture("gitattributes-linguist"),
        }),
      );
      expect(c.sources.map((s) => s.name)).toEqual([
        "preset:swift",
        ".gitattributes linguist-generated",
        ".github/review-ignore",
      ]);
    });

    test("linguist-generated adds noise the preset did not cover", async () => {
      const c = resolveRules(
        inputs({
          reviewIgnore: await fixture("review-ignore-swift"),
          gitattributes: await fixture("gitattributes-linguist"),
        }),
      );
      const r = matchPaths(c.sources, BENCH_PATHS);
      const gen = r.find((x) => x.path === "Sources/App/Generated/API.generated.swift")!;
      expect(gen.hidden).toBe(true);
      expect(r.find((x) => x.path === "Sources/App/HomeView.swift")!.hidden).toBe(false);
    });

    test("review-ignore wins: its ! pulls a directory back out of the preset", async () => {
      const c = resolveRules(inputs({ reviewIgnore: await fixture("review-ignore-escape-hatch") }));
      const r = matchPaths(c.sources, BENCH_PATHS);

      const challenge = r.find((x) => x.path.includes("ChallengeTests"))!;
      expect(challenge.hidden).toBe(false);
      expect(challenge.source).toBe(".github/review-ignore");

      const home = r.find((x) => x.path.includes("HomeViewTests"))!;
      expect(home.hidden).toBe(true);
      expect(home.source).toBe("preset:swift");
    });
  });

  test("the bench repo's config hides snapshots, generated code and locks, and nothing else", async () => {
    const c = resolveRules(
      inputs({
        reviewIgnore: await fixture("review-ignore-swift"),
        gitattributes: "# no linguist rules here on purpose\n* text=auto\n",
      }),
    );
    const paths = (await fixture("bench-files.txt")).trim().split("\n");
    const r = matchPaths(c.sources, paths);
    const hidden = r.filter((x) => x.hidden).map((x) => x.path);
    expect(hidden).toEqual([
      "Sources/App/Generated/API.generated.swift",
      "Tests/AppTests/__Snapshots__/HomeViewTests/testHome.light.iPhone15.1.txt",
      "Tests/AppTests/__Snapshots__/HomeViewTests/testHome.dark.iPadPro.2.txt",
      "Tests/AppTests/__Snapshots__/ChallengeTests/testChallenge.light.iPhone15.1.txt",
      "Package.resolved",
    ]);
    expect(hidden).not.toContain("Sources/App/HomeView.swift");
  });
});

describe("needsLanguages", () => {
  test("only when presets are detected", async () => {
    expect(needsLanguages({ reviewIgnore: null, presetOverride: null })).toBe(true);
    expect(needsLanguages({ reviewIgnore: "dist/\n", presetOverride: null })).toBe(true);
    expect(
      needsLanguages({ reviewIgnore: await fixture("review-ignore-swift"), presetOverride: null }),
    ).toBe(false);
    expect(needsLanguages({ reviewIgnore: "# preset: none\n", presetOverride: null })).toBe(false);
    expect(needsLanguages({ reviewIgnore: null, presetOverride: ["go"] })).toBe(false);
  });
});
