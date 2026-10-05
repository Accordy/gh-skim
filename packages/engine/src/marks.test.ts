import { describe, expect, test } from "bun:test";
import type { GitHubClient } from "@skim/github";
import { markFiles, reconcileFailures, undoMarks, type MarkStore } from "./marks.ts";

describe("reconcileFailures", () => {
  test("only a re-read VIEWED counts as landed; everything else is retried, in order", () => {
    // The measured case: the tail of an aliased batch errors with "Resource
    // limits for this query exceeded" but reads VIEWED moments later.
    // DISMISSED means the file changed again, and a path missing from the
    // re-read is never assumed done.
    const out = reconcileFailures(
      [{ path: "1" }, { path: "2" }, { path: "3" }, { path: "4" }, { path: "gone" }],
      new Map([
        ["1", "VIEWED"],
        ["2", "UNVIEWED"],
        ["3", "VIEWED"],
        ["4", "DISMISSED"],
      ]),
    );
    expect(out.landed).toEqual(["1", "3"]);
    expect(out.stillTodo).toEqual(["2", "4", "gone"]);
  });
});

/**
 * Stand-in for GitHubClient. `viewed` is GitHub's truth for this reviewer.
 * `reportFailed` paths are applied but reported as failed on the first try,
 * the measured GitHub behaviour; `reject` paths really fail every time.
 */
function stubGitHub(opts: {
  files: string[];
  viewed?: string[];
  reportFailed?: string[];
  reject?: string[];
}) {
  const viewed = new Set(opts.viewed ?? []);
  const calls: { op: string; paths: string[] }[] = [];
  let first = true;
  const client = {
    async getPullRequest() {
      return {
        id: "PR_1",
        files: opts.files.map((path) => ({
          path,
          viewerViewedState: viewed.has(path) ? "VIEWED" : "UNVIEWED",
        })),
      };
    },
    async setViewed(
      _id: string,
      paths: string[],
      op: "mark" | "unmark",
      onBatch?: (ok: string[]) => unknown,
    ) {
      calls.push({ op, paths });
      const failed: { path: string; message: string }[] = [];
      const succeeded: string[] = [];
      for (const p of paths) {
        if (opts.reject?.includes(p)) {
          failed.push({ path: p, message: "nope" });
          continue;
        }
        op === "mark" ? viewed.add(p) : viewed.delete(p);
        if (op === "mark" && first && opts.reportFailed?.includes(p))
          failed.push({ path: p, message: "Resource limits" });
        else succeeded.push(p);
      }
      first = false;
      if (onBatch && succeeded.length) await onBatch(succeeded);
      return { succeeded, failed };
    },
  } as unknown as GitHubClient;
  return { client, calls, viewed };
}

function memoryStore(initial: string[] = []): MarkStore & { paths: string[] } {
  const s = {
    paths: [...initial],
    recorded: () => s.paths,
    record: (p: string[]) => void s.paths.push(...p),
    forget: (p: string[]) => void (s.paths = s.paths.filter((x) => !p.includes(x))),
  };
  return s;
}

const pr = { owner: "o", repo: "r", number: 1 };

describe("markFiles", () => {
  test("records a mark GitHub applied despite reporting it failed, and does not resend it", async () => {
    const { client, calls } = stubGitHub({ files: ["a", "b", "c"], reportFailed: ["c"] });
    const store = memoryStore();
    const out = await markFiles(client, pr, "PR_1", ["a", "b", "c"], store);
    expect(out.succeeded.sort()).toEqual(["a", "b", "c"]);
    expect(out.reported.map((f) => f.path)).toEqual(["c"]);
    expect(out.appliedDespiteError).toEqual(["c"]);
    expect(out.failed).toEqual([]);
    expect(store.paths.sort()).toEqual(["a", "b", "c"]);
    expect(calls).toHaveLength(1);
  });

  test("retries a real failure once and reports what still failed", async () => {
    const { client, calls } = stubGitHub({ files: ["a", "b"], reject: ["b"] });
    const store = memoryStore();
    const out = await markFiles(client, pr, "PR_1", ["a", "b"], store);
    expect(out.retried).toEqual(["b"]);
    expect(out.failed.map((f) => f.path)).toEqual(["b"]);
    expect(store.paths).toEqual(["a"]);
    expect(calls.map((c) => c.paths)).toEqual([["a", "b"], ["b"]]);
  });
});

describe("undoMarks", () => {
  test("unmarks recorded paths still viewed, and forgets them and the stale ones", async () => {
    // "mine" was unmarked by the reviewer since; "theirs" they marked by hand.
    const { client, viewed } = stubGitHub({
      files: ["a", "mine", "theirs"],
      viewed: ["a", "theirs"],
    });
    const store = memoryStore(["a", "mine"]);
    const out = await undoMarks(client, pr, store);
    expect(out).toMatchObject({ recorded: 2, toUndo: 1, stale: 1, succeeded: ["a"] });
    expect([...viewed]).toEqual(["theirs"]);
    expect(store.paths).toEqual([]);
  });

  test("a dry run changes nothing", async () => {
    const { client, calls } = stubGitHub({ files: ["a"], viewed: ["a"] });
    const store = memoryStore(["a"]);
    const out = await undoMarks(client, pr, store, { dryRun: true });
    expect(out.toUndo).toBe(1);
    expect(calls).toEqual([]);
    expect(store.paths).toEqual(["a"]);
  });

  test("nothing recorded asks GitHub nothing", async () => {
    const { client, calls } = stubGitHub({ files: ["a"], viewed: ["a"] });
    expect((await undoMarks(client, pr, memoryStore())).recorded).toBe(0);
    expect(calls).toEqual([]);
  });
});
