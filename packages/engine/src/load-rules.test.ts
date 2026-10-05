import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "@skim/github";
import { loadRules } from "./load-rules.ts";

/** Stand-in for GitHubClient: serves files from a map and records what was asked for. */
function stubClient(files: Record<string, string>, languages: string[] = []) {
  const asked: string[] = [];
  const client = {
    async getFileAtRef(_o: string, _r: string, ref: string, path: string) {
      asked.push(`${ref}:${path}`);
      return files[path] ?? null;
    },
    async getLanguages() {
      asked.push("languages");
      return languages;
    },
  } as unknown as GitHubClient;
  return { client, asked };
}

describe("loadRules", () => {
  test("reads both config files from the ref it is given", async () => {
    // Callers pass the PR's head, so review-ignore applies to the branch that
    // contains it, the way .gitignore does.
    const { client, asked } = stubClient({}, ["Swift"]);
    const c = await loadRules(client, "o", "r", "deadbeef", null);
    expect(asked).toEqual(["deadbeef:.github/review-ignore", "deadbeef:.gitattributes", "languages"]);
    expect(c.presets).toEqual(["swift"]);
  });

  test("does not ask for languages when the presets are already chosen", async () => {
    const { client, asked } = stubClient({ ".github/review-ignore": "# preset: go\n" });
    const c = await loadRules(client, "o", "r", "main", null);
    expect(asked).not.toContain("languages");
    expect(c.presetOrigin).toBe("directive");
  });
});
