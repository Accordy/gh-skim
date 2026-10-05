import type { GitHubClient } from "@skim/github";
import { needsLanguages, resolveRules, REVIEW_IGNORE_PATH, type ResolvedRules } from "@skim/rules";

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
