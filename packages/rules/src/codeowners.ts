import ignore from "ignore";

/** Where GitHub looks for CODEOWNERS, in the order it looks. The first one found is used. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

export type OwnerRule = { pattern: string; owners: string[] };

export type Codeowners = {
  rules: OwnerRule[];
  /**
   * The owners on the last line that matches the path, as GitHub decides,
   * lowercased. Empty when that line names nobody, which makes the path
   * unowned on purpose; null when no line matches.
   */
  ownersOf(path: string): string[] | null;
  /** Organizations whose teams own something, so team membership is only looked up when needed. */
  teamOrgs: string[];
};

/**
 * Parse a CODEOWNERS file. Patterns follow gitignore, except that GitHub
 * ignores `!` lines, so they are dropped here too.
 */
export function parseCodeowners(text: string): Codeowners {
  const rules: OwnerRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw
      .replace(/\r$/, "")
      .replace(/(^|\s)#.*$/, "")
      .trim();
    if (!line || line.startsWith("!")) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern: pattern!, owners: owners.map((o) => o.toLowerCase()) });
  }
  const matchers = rules.map((r) => ignore().add(r.pattern));
  const teamOrgs = new Set<string>();
  for (const r of rules) {
    for (const o of r.owners) {
      if (o.startsWith("@") && o.includes("/")) teamOrgs.add(o.slice(1, o.indexOf("/")));
    }
  }
  return {
    rules,
    teamOrgs: [...teamOrgs],
    ownersOf(path) {
      for (let i = rules.length - 1; i >= 0; i--) {
        if (safeIgnores(matchers[i]!, path)) return rules[i]!.owners;
      }
      return null;
    },
  };
}

function safeIgnores(ig: ReturnType<typeof ignore>, path: string): boolean {
  try {
    return ig.ignores(path);
  } catch {
    return false;
  }
}

/** How a reviewer is named in CODEOWNERS: `@login` and `@org/team` for each of their teams. */
export function identitiesFor(
  login: string,
  teams: { org: string; slug: string }[] = [],
): Set<string> {
  return new Set([
    `@${login}`.toLowerCase(),
    ...teams.map((t) => `@${t.org}/${t.slug}`.toLowerCase()),
  ]);
}

/**
 * For one reviewer, the paths owned by someone else. A path nobody owns stays
 * visible. Null when the reviewer owns none of the paths: then they were asked
 * to review for some other reason, and hiding everything would hide the whole
 * pull request from them.
 */
export function ownedByOthers(
  codeowners: Codeowners,
  paths: string[],
  identities: Set<string>,
): string[] | null {
  const others: string[] = [];
  let mine = 0;
  for (const path of paths) {
    const owners = codeowners.ownersOf(path);
    if (!owners || owners.length === 0) continue;
    if (owners.some((o) => identities.has(o))) mine++;
    else others.push(path);
  }
  return mine === 0 ? null : others;
}

/**
 * `# codeowners: on` on any line of a review-ignore file turns on CODEOWNERS
 * filtering: each reviewer sees only the files they own. Off unless asked for,
 * since it hides real code.
 */
export function parseCodeownersDirective(reviewIgnore: string | null): boolean {
  if (reviewIgnore === null) return false;
  return reviewIgnore.split("\n").some((l) => /^#\s*codeowners:\s*on\s*$/i.test(l.trim()));
}
