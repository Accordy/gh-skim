import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "@skim/github";
import { loadCodeowners, loadRules, reviewerIdentities } from "./load-rules.ts";
import { parseCodeowners } from "@skim/rules";

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
    expect(asked).toEqual([
      "deadbeef:.github/review-ignore",
      "deadbeef:.gitattributes",
      "languages",
    ]);
    expect(c.presets).toEqual(["swift"]);
  });

  test("does not ask for languages when the presets are already chosen", async () => {
    const { client, asked } = stubClient({ ".github/review-ignore": "# preset: go\n" });
    const c = await loadRules(client, "o", "r", "main", null);
    expect(asked).not.toContain("languages");
    expect(c.presetOrigin).toBe("directive");
  });
});

describe("CODEOWNERS", () => {
  test("is read from the first place GitHub looks that has one", async () => {
    const { client, asked } = stubClient({ CODEOWNERS: "* @amy", "docs/CODEOWNERS": "* @bob" });
    const found = await loadCodeowners(client, "o", "r", "main");
    expect(found?.path).toBe("CODEOWNERS");
    expect(found?.codeowners.ownersOf("x")).toEqual(["@amy"]);
    expect(asked).toEqual(["main:.github/CODEOWNERS", "main:CODEOWNERS"]);
  });

  test("a reviewer's teams count, and an unreadable team list is reported, not fatal", async () => {
    const codeowners = parseCodeowners("/a/ @acme/web\n/b/ @other/ops\n");
    const client = {
      async teamsOf(org: string) {
        if (org === "other") throw new Error("Resource not accessible by integration");
        return ["web"];
      },
    } as unknown as GitHubClient;
    const { identities, teamsUnreadable } = await reviewerIdentities(client, "Amy", codeowners);
    expect([...identities]).toEqual(["@amy", "@acme/web"]);
    expect(teamsUnreadable).toEqual(["other"]);
  });
});
