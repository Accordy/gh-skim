export type Target = { owner: string; repo: string; number: number };

/**
 * Accept the three ways a person refers to a PR:
 *   https://github.com/owner/repo/pull/123   (any trailing path is ignored)
 *   owner/repo#123
 *   123                                      (needs `repoHint` from -R or the cwd)
 */
export function parseTarget(input: string, repoHint?: string): Target {
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(input);
  if (url) return { owner: url[1]!, repo: url[2]!, number: Number(url[3]) };

  const shorthand = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(input.trim());
  if (shorthand) {
    return { owner: shorthand[1]!, repo: shorthand[2]!, number: Number(shorthand[3]) };
  }

  const bare = /^#?(\d+)$/.exec(input.trim());
  if (bare) {
    if (!repoHint) {
      throw new Error(
        `"${input}" is just a number; pass -R owner/repo, or run inside the repository, ` +
          `or give the full PR URL`,
      );
    }
    const [owner, repo] = repoHint.split("/");
    if (!owner || !repo) throw new Error(`could not read "${repoHint}" as owner/repo`);
    return { owner, repo, number: Number(bare[1]) };
  }

  throw new Error(`could not read "${input}" as a pull request`);
}
