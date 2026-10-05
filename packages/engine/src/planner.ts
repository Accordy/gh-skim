import { matchPaths, type MatchResult, type PatternSource } from "@skim/rules";
import type { ChangedFile } from "@skim/github";

export type SkipReason = "already-viewed" | "has-review-thread";

export type Plan = {
  /** Paths to mark viewed. */
  toMark: string[];
  /** Why each considered-but-skipped path was skipped. */
  skipped: { path: string; reason: SkipReason }[];
  /** Full matcher output, for the grouped summary. */
  matches: MatchResult[];
  /** Files left for the reviewer to actually read. */
  remaining: number;
  /** True when every changed file matched. */
  allNoise: boolean;
};

/**
 * Decide what to mark.
 *
 * Rules, in order:
 *  - a file with a review thread is never touched, whatever it matches
 *  - a file already VIEWED is left alone; we did not set it and will not claim it
 *  - a DISMISSED file (changed since it was last viewed) is marked again
 */
export function plan(
  files: ChangedFile[],
  sources: PatternSource[],
  reviewThreadPaths: Set<string>,
): Plan {
  const matches = matchPaths(
    sources,
    files.map((f) => f.path),
  );
  const byPath = new Map(matches.map((m) => [m.path, m]));

  const matched = files.filter((f) => byPath.get(f.path)?.hidden);
  const allNoise = matched.length > 0 && matched.length === files.length;

  const skipped: { path: string; reason: SkipReason }[] = [];
  const candidates: ChangedFile[] = [];

  for (const f of matched) {
    if (reviewThreadPaths.has(f.path)) {
      skipped.push({ path: f.path, reason: "has-review-thread" });
      continue;
    }
    if (f.viewerViewedState === "VIEWED") {
      skipped.push({ path: f.path, reason: "already-viewed" });
      continue;
    }
    // UNVIEWED and DISMISSED both get marked. DISMISSED means the file changed
    // since it was last viewed, which is exactly when a re-mark is wanted.
    candidates.push(f);
  }

  const remaining = files.length - matched.length;

  return {
    toMark: candidates.map((c) => c.path),
    skipped,
    matches,
    remaining,
    allNoise,
  };
}
