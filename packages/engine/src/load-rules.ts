import type { GitHubClient } from "@skim/github";
import {
  CODEOWNERS_PATHS,
  identitiesFor,
  needsLanguages,
  parseCodeowners,
  resolveRules,
  REVIEW_IGNORE_PATH,
  type Codeowners,
  type ResolvedRules,
} from "@skim/rules";

/**
 * Read the config files for a PR from GitHub and resolve them into rules.
 *
 * Both config files are read from the ref you pass, which is the PR's head.
 * That is what makes the file behave like `.gitignore`: the rules you see in
 * the branch are the rules that apply to it, and a PR that adds a generated
 * directory can add the rule for it in the same PR.
 *
 * The cost is that a PR can add a rule that hides its own changes. The check
 * run and the CLI both name every rule that hid something, so it shows up,
 * but it is not prevented.
 */
export async function loadRules(
  client: GitHubClient,
  owner: string,
  repo: string,
  ref: string,
  presetOverride: string[] | null,
): Promise<ResolvedRules> {
  const reviewIgnore = await client.getFileAtRef(owner, repo, ref, REVIEW_IGNORE_PATH);
  const gitattributes = await client.getFileAtRef(owner, repo, ref, ".gitattributes");
  const languages = needsLanguages({ reviewIgnore, presetOverride })
    ? await client.getLanguages(owner, repo)
    : [];
  return resolveRules({ reviewIgnore, gitattributes, presetOverride, languages });
}

/**
 * The repository's CODEOWNERS, from the first place GitHub looks, or null.
 * Pass the base branch, as GitHub does: read from the head, a pull request
 * could reassign its own files and hide them from their owners.
 */
export async function loadCodeowners(
  client: GitHubClient,
  owner: string,
  repo: string,
  baseRef: string,
): Promise<{ path: string; codeowners: Codeowners } | null> {
  for (const path of CODEOWNERS_PATHS) {
    const text = await client.getFileAtRef(owner, repo, baseRef, path);
    if (text !== null) return { path, codeowners: parseCodeowners(text) };
  }
  return null;
}

/**
 * How a reviewer is named in CODEOWNERS: their login, and their teams in the
 * organizations that own files through a team. A team list that cannot be read
 * is left out and reported, so team-owned files stay visible to them.
 */
export async function reviewerIdentities(
  client: GitHubClient,
  login: string,
  codeowners: Codeowners,
): Promise<{ identities: Set<string>; teamsUnreadable: string[] }> {
  const teams: { org: string; slug: string }[] = [];
  const teamsUnreadable: string[] = [];
  for (const org of codeowners.teamOrgs) {
    try {
      for (const slug of await client.teamsOf(org, login)) teams.push({ org, slug });
    } catch {
      teamsUnreadable.push(org);
    }
  }
  return { identities: identitiesFor(login, teams), teamsUnreadable };
}
