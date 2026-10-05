import ignore from "ignore";

/**
 * One source of patterns. Order in the array is precedence, lowest first:
 * later sources win, exactly like later lines in a .gitignore.
 */
export type PatternSource = {
  /** Shown to the user, e.g. "preset:swift" or ".github/review-ignore". */
  name: string;
  patterns: string[];
};

export type MatchResult = {
  path: string;
  hidden: boolean;
  /** The pattern that produced the final decision, null if nothing matched. */
  rule: string | null;
  /** The source that pattern came from. */
  source: string | null;
};

/** Strip comments and blank lines; keep everything else verbatim. */
export function parsePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
}

type FlatRule = { pattern: string; source: string };

function flatten(sources: PatternSource[]): FlatRule[] {
  const out: FlatRule[] = [];
  for (const s of sources) for (const p of s.patterns) out.push({ pattern: p, source: s.name });
  return out;
}

/**
 * Decide hidden/not for every path, and attribute the decision to a rule.
 *
 * Two passes on purpose. The decision comes from a single `ignore` instance
 * holding every pattern in precedence order, so cross-source negation follows
 * real gitignore semantics — including the rule that a file cannot be
 * re-included with `!` once a parent directory has been excluded.
 *
 * Attribution is then recovered by replaying cumulative prefixes of the same
 * rule list and finding the last rule that changed the verdict. Deciding
 * per-source instead would get negation across sources wrong.
 */
export function matchPaths(sources: PatternSource[], paths: string[]): MatchResult[] {
  const rules = flatten(sources);

  // Cumulative prefix matchers, built once and reused for every path.
  // prefixes[i] holds rules[0..i].
  const prefixes = rules.map((_, i) =>
    ignore().add(rules.slice(0, i + 1).map((r) => r.pattern)),
  );
  const all = prefixes.length ? prefixes[prefixes.length - 1]! : ignore();

  return paths.map((path) => {
    const hidden = safeIgnores(all, path);
    if (rules.length === 0) return { path, hidden: false, rule: null, source: null };

    // Walk forward, remembering the last rule that flipped the verdict.
    let prev = false;
    let decidedAt = -1;
    for (let i = 0; i < prefixes.length; i++) {
      const now = safeIgnores(prefixes[i]!, path);
      if (now !== prev) decidedAt = i;
      prev = now;
    }
    if (decidedAt === -1) return { path, hidden, rule: null, source: null };
    return { path, hidden, rule: rules[decidedAt]!.pattern, source: rules[decidedAt]!.source };
  });
}

/** `ignore` throws on absolute paths and on "."; treat those as not-hidden. */
function safeIgnores(ig: ReturnType<typeof ignore>, path: string): boolean {
  try {
    return ig.ignores(path);
  } catch {
    return false;
  }
}

/** Group results by the rule that hid them, for the CLI summary. */
export function groupByRule(results: MatchResult[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of results) {
    if (!r.hidden) continue;
    const key = r.source && r.rule ? `${r.source}: ${r.rule}` : "unattributed";
    const list = out.get(key) ?? [];
    list.push(r.path);
    out.set(key, list);
  }
  return out;
}
