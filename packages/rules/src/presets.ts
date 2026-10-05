import swiftText from "../presets/swift.gitignore" with { type: "text" };
import nodeText from "../presets/node.gitignore" with { type: "text" };
import goText from "../presets/go.gitignore" with { type: "text" };
import pythonText from "../presets/python.gitignore" with { type: "text" };
import jvmText from "../presets/jvm.gitignore" with { type: "text" };
import rubyText from "../presets/ruby.gitignore" with { type: "text" };
import rustText from "../presets/rust.gitignore" with { type: "text" };
import dotnetText from "../presets/dotnet.gitignore" with { type: "text" };

import { parsePatterns, type PatternSource } from "./matcher.ts";

/**
 * Presets are embedded at build time so the compiled single-file binary has
 * no runtime dependency on the repo.
 */
const BUILT_IN: Record<string, string> = {
  swift: swiftText,
  node: nodeText,
  go: goText,
  python: pythonText,
  jvm: jvmText,
  ruby: rubyText,
  rust: rustText,
  dotnet: dotnetText,
};

export const PRESET_NAMES = Object.keys(BUILT_IN);

/** GitHub's linguist language names mapped to the presets we ship. */
const LANGUAGE_TO_PRESET: Record<string, string> = {
  swift: "swift",
  "objective-c": "swift",
  "objective-c++": "swift",
  typescript: "node",
  javascript: "node",
  tsx: "node",
  vue: "node",
  svelte: "node",
  go: "go",
  python: "python",
  kotlin: "jvm",
  java: "jvm",
  scala: "jvm",
  groovy: "jvm",
  ruby: "ruby",
  rust: "rust",
  "c#": "dotnet",
  "f#": "dotnet",
  "visual basic .net": "dotnet",
};

export class UnknownPresetError extends Error {
  constructor(public readonly name: string) {
    super(
      `unknown preset "${name}". Known presets: ${PRESET_NAMES.join(", ")}. ` +
        `Use "# preset: none" to start from nothing.`,
    );
  }
}

export function loadPreset(name: string): string {
  const text = BUILT_IN[name];
  if (text === undefined) throw new UnknownPresetError(name);
  return text;
}

export function presetSources(
  names: string[],
): PatternSource[] {
  return names.map((n) => ({
    name: `preset:${n}`,
    patterns: parsePatterns(loadPreset(n)),
  }));
}

/** Map repository languages (from GraphQL) to preset names, deduplicated. */
export function detectPresets(languages: string[]): string[] {
  const out: string[] = [];
  for (const l of languages) {
    const p = LANGUAGE_TO_PRESET[l.toLowerCase()];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

export type PresetDirective =
  | { kind: "none" }
  | { kind: "explicit"; names: string[] }
  | { kind: "absent" };

/**
 * `# preset: swift, node` on the FIRST line of a review-ignore file picks the
 * presets. `# preset: none` starts from nothing. Anything else means the file
 * says nothing about presets and detection applies.
 *
 * It has to be the first line so the file stays valid gitignore and other
 * tools keep treating it as a comment.
 */
export function parsePresetDirective(
  text: string,
): PresetDirective {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  const m = /^#\s*preset:\s*(.*)$/i.exec(first);
  if (!m) return { kind: "absent" };
  const body = m[1]!.trim();
  if (body.toLowerCase() === "none") return { kind: "none" };
  const names = body
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return { kind: "none" };
  for (const n of names) {
    if (!(n in BUILT_IN)) throw new UnknownPresetError(n);
  }
  return { kind: "explicit", names };
}

/** Paths marked `linguist-generated` in a .gitattributes file. */
export function linguistGeneratedPatterns(gitattributes: string): string[] {
  const out: string[] = [];
  for (const raw of gitattributes.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const pattern = parts[0]!;
    const attrs = parts.slice(1);
    const on = attrs.some(
      (a) => a === "linguist-generated" || a === "linguist-generated=true",
    );
    const off = attrs.some((a) => a === "-linguist-generated" || a === "linguist-generated=false");
    if (on && !off) out.push(pattern);
  }
  return out;
}
