import { describe, expect, test } from "bun:test";
import { groupByRule, matchPaths, parsePatterns, type PatternSource } from "./matcher.ts";

const src = (name: string, text: string): PatternSource => ({
  name,
  patterns: parsePatterns(text),
});

describe("parsePatterns", () => {
  test("drops comments and blank lines, keeps everything else", () => {
    expect(parsePatterns("# a comment\n\n**/x/**\n   \n!keep.txt\n")).toEqual([
      "**/x/**",
      "!keep.txt",
    ]);
  });

  test("keeps a pattern with a trailing comment-looking fragment", () => {
    expect(parsePatterns("a#b.txt")).toEqual(["a#b.txt"]);
  });
});

describe("matchPaths", () => {
  test("hides what a preset matches and leaves the rest alone", () => {
    const r = matchPaths(
      [src("preset:swift", "**/__Snapshots__/**")],
      ["Tests/AppTests/__Snapshots__/HomeTests/a.txt", "Sources/App/Home.swift"],
    );
    expect(r[0]!.hidden).toBe(true);
    expect(r[0]!.rule).toBe("**/__Snapshots__/**");
    expect(r[0]!.source).toBe("preset:swift");
    expect(r[1]!.hidden).toBe(false);
    expect(r[1]!.rule).toBeNull();
  });

  test("no sources means nothing is hidden", () => {
    const r = matchPaths([], ["a/b.txt"]);
    expect(r[0]!.hidden).toBe(false);
    expect(r[0]!.source).toBeNull();
  });

  /**
   * Git's own rule: it cannot re-include a file with `!`
   * once a PARENT DIRECTORY is excluded. `dir/` excludes the directory itself,
   * so git never descends into it and the negation is dead. `dir/**` excludes
   * the contents, so a negation on one file still works.
   *
   * This is why every shipped preset must use `dir/**` and never `dir/`.
   */
  describe("parent-directory negation", () => {
    const paths = ["Generated/keep.swift", "Generated/other.swift"];

    test("dir/** lets a later ! re-include one file — the escape hatch works", () => {
      const r = matchPaths(
        [
          src("preset:swift", "**/Generated/**"),
          src(".github/review-ignore", "!**/Generated/keep.swift"),
        ],
        paths,
      );
      expect(r[0]!.hidden).toBe(false);
      expect(r[0]!.rule).toBe("!**/Generated/keep.swift");
      expect(r[0]!.source).toBe(".github/review-ignore");
      expect(r[1]!.hidden).toBe(true);
    });

    test("dir/ excludes the directory itself, so the ! silently does nothing", () => {
      const r = matchPaths(
        [
          src("preset:broken", "Generated/"),
          src(".github/review-ignore", "!Generated/keep.swift"),
        ],
        paths,
      );
      // Both stay hidden: this is the bug the dir/** convention prevents.
      expect(r[0]!.hidden).toBe(true);
      expect(r[1]!.hidden).toBe(true);
    });

    test("every shipped preset pattern that names a directory uses /**", async () => {
      for (const name of ["swift", "node", "go", "python"]) {
        const text = await Bun.file(
          new URL(`../presets/${name}.gitignore`, import.meta.url),
        ).text();
        for (const p of parsePatterns(text)) {
          expect(p.endsWith("/"), `${name}: "${p}" ends with / and would kill negation`).toBe(
            false,
          );
        }
      }
    });
  });

  describe("precedence", () => {
    // Lowest priority first. review-ignore is appended last so it wins.
    test("review-ignore beats a preset for a file directly under the excluded tree", () => {
      const r = matchPaths(
        [
          src("preset:swift", "**/__Snapshots__/**"),
          src(".github/review-ignore", "!**/__Snapshots__/critical.txt"),
        ],
        ["Tests/__Snapshots__/critical.txt", "Tests/__Snapshots__/other.txt"],
      );
      expect(r[0]!.hidden).toBe(false);
      expect(r[0]!.source).toBe(".github/review-ignore");
      expect(r[1]!.hidden).toBe(true);
    });

    /**
     * Re-including a whole SUBDIRECTORY takes two lines, and this trips people
     * up. `**\/__Snapshots__/**` matches the intermediate directory
     * `Tests/__Snapshots__/Critical` as well as its contents. Once that
     * directory is excluded, git never descends into it, so negating only the
     * contents does nothing. The directory has to be un-ignored first.
     */
    test("un-ignoring a subdirectory needs the directory line too", () => {
      const paths = ["Tests/__Snapshots__/Critical/a.txt", "Tests/__Snapshots__/Other/a.txt"];

      const contentsOnly = matchPaths(
        [
          src("preset:swift", "**/__Snapshots__/**"),
          src(".github/review-ignore", "!**/__Snapshots__/Critical/**"),
        ],
        paths,
      );
      expect(contentsOnly[0]!.hidden).toBe(true); // the trap

      const both = matchPaths(
        [
          src("preset:swift", "**/__Snapshots__/**"),
          src(
            ".github/review-ignore",
            "!**/__Snapshots__/Critical\n!**/__Snapshots__/Critical/**",
          ),
        ],
        paths,
      );
      expect(both[0]!.hidden).toBe(false);
      expect(both[1]!.hidden).toBe(true);
    });

    test("review-ignore beats .gitattributes linguist-generated", () => {
      const r = matchPaths(
        [
          src("preset:node", "# nothing"),
          src(".gitattributes linguist-generated", "src/api/**"),
          src(".github/review-ignore", "!src/api/handwritten.ts"),
        ],
        ["src/api/handwritten.ts", "src/api/gen.ts"],
      );
      expect(r[0]!.hidden).toBe(false);
      expect(r[0]!.source).toBe(".github/review-ignore");
      expect(r[1]!.hidden).toBe(true);
      expect(r[1]!.source).toBe(".gitattributes linguist-generated");
    });

    test("linguist-generated beats a preset negation", () => {
      const r = matchPaths(
        [
          src("preset:node", "!src/api/gen.ts"),
          src(".gitattributes linguist-generated", "src/api/**"),
        ],
        ["src/api/gen.ts"],
      );
      expect(r[0]!.hidden).toBe(true);
      expect(r[0]!.source).toBe(".gitattributes linguist-generated");
    });
  });

  test("attributes the decision to the LAST rule that changed it", () => {
    const r = matchPaths(
      [src("a", "**/*.txt\n!keep.txt"), src("b", "keep.txt")],
      ["keep.txt"],
    );
    expect(r[0]!.hidden).toBe(true);
    expect(r[0]!.source).toBe("b");
    expect(r[0]!.rule).toBe("keep.txt");
  });

  test("tolerates paths the ignore library rejects", () => {
    const r = matchPaths([src("a", "**/*.txt")], ["/absolute/x.txt", "."]);
    expect(r[0]!.hidden).toBe(false);
    expect(r[1]!.hidden).toBe(false);
  });
});

describe("groupByRule", () => {
  test("groups hidden paths under source: rule and ignores visible ones", () => {
    const r = matchPaths(
      [src("preset:swift", "**/__Snapshots__/**\n**/*.generated.swift")],
      [
        "Tests/__Snapshots__/a.txt",
        "Tests/__Snapshots__/b.txt",
        "Sources/API.generated.swift",
        "Sources/Home.swift",
      ],
    );
    const g = groupByRule(r);
    expect(g.get("preset:swift: **/__Snapshots__/**")).toHaveLength(2);
    expect(g.get("preset:swift: **/*.generated.swift")).toEqual(["Sources/API.generated.swift"]);
    expect([...g.values()].flat()).not.toContain("Sources/Home.swift");
  });
});
