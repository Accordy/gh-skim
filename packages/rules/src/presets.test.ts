import { matchPaths } from "./matcher.ts";
import { describe, expect, test } from "bun:test";
import {
  UnknownPresetError,
  detectPresets,
  linguistGeneratedPatterns,
  loadPreset,
  parsePresetDirective,
  presetSources,
} from "./presets.ts";

describe("preset directive on the first line", () => {
  test("reads a single preset", () => {
    expect(parsePresetDirective("# preset: swift\n**/x/**")).toEqual({
      kind: "explicit",
      names: ["swift"],
    });
  });

  test("reads a comma separated list with loose spacing", () => {
    expect(parsePresetDirective("#preset:  swift ,node  \n")).toEqual({
      kind: "explicit",
      names: ["swift", "node"],
    });
  });

  test("'none' starts from nothing", () => {
    expect(parsePresetDirective("# preset: none\n**/x/**")).toEqual({ kind: "none" });
    expect(parsePresetDirective("# PRESET: NONE")).toEqual({ kind: "none" });
  });

  test("an empty list is the same as none", () => {
    expect(parsePresetDirective("# preset:\n")).toEqual({ kind: "none" });
  });

  test("only the FIRST line counts, so the file stays valid gitignore", () => {
    expect(parsePresetDirective("**/x/**\n# preset: swift")).toEqual({ kind: "absent" });
  });

  test("no directive at all means detection applies", () => {
    expect(parsePresetDirective("**/x/**\n")).toEqual({ kind: "absent" });
    expect(parsePresetDirective("# just a comment\n")).toEqual({ kind: "absent" });
  });

  test("an unknown preset is reported, never silently ignored", () => {
    expect(() => parsePresetDirective("# preset: swift, cobol")).toThrow(UnknownPresetError);
    expect(() => parsePresetDirective("# preset: cobol")).toThrow(/unknown preset "cobol"/);
  });
});

describe("language detection", () => {
  test("maps GitHub language names to presets, deduplicated and in order", () => {
    expect(detectPresets(["Swift", "Objective-C", "Ruby"])).toEqual(["swift", "ruby"]);
    expect(detectPresets(["Kotlin", "Java", "Rust", "C#"])).toEqual(["jvm", "rust", "dotnet"]);
    expect(detectPresets(["TypeScript", "JavaScript", "Go"])).toEqual(["node", "go"]);
    expect(detectPresets(["Haskell"])).toEqual([]);
  });
});

describe("loading", () => {
  test("unknown preset throws", () => {
    expect(() => loadPreset("cobol")).toThrow(UnknownPresetError);
  });

  test("presetSources names each source after its preset", () => {
    const s = presetSources(["swift"]);
    expect(s[0]!.name).toBe("preset:swift");
    expect(s[0]!.patterns).toContain("**/__Snapshots__/**");
    expect(s[0]!.patterns.some((p) => p.startsWith("#"))).toBe(false);
  });
});

describe("linguist-generated in .gitattributes", () => {
  test("picks up both spellings and ignores everything else", () => {
    const text = [
      "# comment",
      "* text=auto",
      "src/api/** linguist-generated",
      "schema.json linguist-generated=true",
      "docs/** linguist-documentation",
      "*.png binary",
    ].join("\n");
    expect(linguistGeneratedPatterns(text)).toEqual(["src/api/**", "schema.json"]);
  });

  test("an explicit false turns it off", () => {
    expect(linguistGeneratedPatterns("src/** linguist-generated=false")).toEqual([]);
    expect(linguistGeneratedPatterns("src/** -linguist-generated")).toEqual([]);
  });

  test("a .gitattributes with no linguist rules yields nothing", () => {
    expect(linguistGeneratedPatterns("* text=auto\n")).toEqual([]);
  });
});

describe("preset contents", () => {
  const hidden = (preset: string, paths: string[]) =>
    matchPaths(presetSources([preset]), paths).filter((m) => m.hidden).map((m) => m.path);

  test("jvm hides the Gradle wrapper and locks, but not the wrapper version", () => {
    expect(
      hidden("jvm", [
        "gradle/wrapper/gradle-wrapper.jar",
        "gradle/wrapper/gradle-wrapper.properties",
        "gradlew",
        "app/gradle.lockfile",
        "app/src/main/kotlin/Main.kt",
        "app/build.gradle.kts",
      ]),
    ).toEqual(["gradle/wrapper/gradle-wrapper.jar", "gradlew", "app/gradle.lockfile"]);
  });

  test("ruby hides Gemfile.lock and generated RBI, never the schema", () => {
    expect(
      hidden("ruby", [
        "Gemfile.lock",
        "Gemfile",
        "sorbet/rbi/gems/rack@3.0.rbi",
        "db/schema.rb",
        "vendor/bundle/ruby/3.3/gems/x.rb",
        "app/models/user.rb",
      ]),
    ).toEqual(["Gemfile.lock", "sorbet/rbi/gems/rack@3.0.rbi", "vendor/bundle/ruby/3.3/gems/x.rb"]);
  });

  test("rust hides Cargo.lock but not Cargo.toml", () => {
    expect(hidden("rust", ["Cargo.lock", "Cargo.toml", "src/main.rs"])).toEqual(["Cargo.lock"]);
  });

  test("dotnet hides designer output and obj/, never bin/ scripts or migrations", () => {
    expect(
      hidden("dotnet", [
        "src/App/packages.lock.json",
        "src/App/Form1.Designer.cs",
        "src/App/Form1.cs",
        "src/App/obj/project.assets.json",
        "bin/deploy.sh",
        "src/Data/Migrations/20260101_AddUsers.cs",
      ]),
    ).toEqual(["src/App/packages.lock.json", "src/App/Form1.Designer.cs", "src/App/obj/project.assets.json"]);
  });
});
