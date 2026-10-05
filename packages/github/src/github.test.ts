import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BATCH_SIZE, GitHubClient, MAX_RESET_WAIT_MS, retryDelayMs } from "./github.ts";

type Call = { query: string; variables: Record<string, unknown> };

/** Replace global fetch with a scripted sequence of responses. */
function stubFetch(responses: { status?: number; headers?: Record<string, string>; body: any }[]) {
  const calls: Call[] = [];
  let i = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      status: r.status ?? 200,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(r.body),
    };
  }) as any;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const ok = { body: { data: {} } };
const paths = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.txt`);

describe("setViewed batching", () => {
  test("splits into one request per BATCH_SIZE paths", async () => {
    const s = stubFetch([ok]);
    restore = s.restore;
    const out = await new GitHubClient("t").setViewed("PR", paths(120), "mark");
    expect(s.calls).toHaveLength(Math.ceil(120 / BATCH_SIZE));
    expect(out.succeeded).toHaveLength(120);
    expect(out.failed).toHaveLength(0);
  });

  test("uses variables, so a path with quotes cannot break the query", async () => {
    const s = stubFetch([ok]);
    restore = s.restore;
    await new GitHubClient("t").setViewed("PR", ['a"b\\c.txt'], "mark");
    expect(s.calls[0]!.variables.p0).toBe('a"b\\c.txt');
    expect(s.calls[0]!.query).not.toContain('a"b');
  });

  test("unmark uses the unmark mutation", async () => {
    const s = stubFetch([ok]);
    restore = s.restore;
    await new GitHubClient("t").setViewed("PR", paths(1), "unmark");
    expect(s.calls[0]!.query).toContain("unmarkFileAsViewed");
  });
});

describe("per-alias failures under HTTP 200", () => {
  /**
   * Measured against the real API: past 76 aliases GitHub answers 200 and reports the
   * failures only inside errors[]. A client that trusts the status would
   * report far more files marked than it marked.
   */
  test("onBatch only ever receives paths that actually succeeded", async () => {
    const s = stubFetch([{ body: { data: {}, errors: [{ path: ["a1"], message: "nope" }] } }]);
    restore = s.restore;
    const seen: string[][] = [];
    await new GitHubClient("t").setViewed("PR", paths(3), "mark", (ok) => void seen.push(ok));
    expect(seen).toEqual([["f0.txt", "f2.txt"]]);
  });

  test("a response with no data at all fails every path in the batch", async () => {
    const s = stubFetch([{ status: 502, body: { message: "Bad gateway" } }]);
    restore = s.restore;
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined as any);
    const out = await new GitHubClient("t").setViewed("PR", paths(2), "mark");
    expect(out.succeeded).toEqual([]);
    expect(out.failed.map((f) => f.path)).toEqual(["f0.txt", "f1.txt"]);
    sleep.mockRestore();
  });
});

describe("secondary rate limit", () => {
  test("honours retry-after and re-sends the same batch", async () => {
    const s = stubFetch([
      { status: 403, headers: { "retry-after": "60" }, body: { message: "rate limited" } },
      { status: 200, body: { data: {} } },
    ]);
    restore = s.restore;
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined as any);

    const logs: string[] = [];
    const out = await new GitHubClient("t", (m) => logs.push(m)).setViewed("PR", paths(2), "mark");

    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(s.calls).toHaveLength(2);
    expect(out.succeeded).toHaveLength(2);
    expect(logs[0]).toContain("rate limited");
    sleep.mockRestore();
  });

  test("queries retry too, not only mutations", async () => {
    const s = stubFetch([
      { status: 403, headers: { "retry-after": "5" }, body: {} },
      {
        status: 200,
        body: {
          data: {
            repository: { languages: { nodes: [{ name: "Swift" }] } },
          },
        },
      },
    ]);
    restore = s.restore;
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined as any);
    const langs = await new GitHubClient("t").getLanguages("o", "r");
    expect(langs).toEqual(["Swift"]);
    expect(s.calls).toHaveLength(2);
    sleep.mockRestore();
  });

  test("gives up after 5 retries rather than looping forever", async () => {
    const s = stubFetch([{ status: 403, headers: { "retry-after": "1" }, body: {} }]);
    restore = s.restore;
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined as any);
    const out = await new GitHubClient("t").setViewed("PR", paths(1), "mark");
    expect(s.calls).toHaveLength(6);
    expect(out.failed).toHaveLength(1);
    sleep.mockRestore();
  });
});

describe("what is retried", () => {
  const reply = (over: Partial<Parameters<typeof retryDelayMs>[0]>) => ({
    status: 200,
    retryAfter: null,
    remaining: null,
    reset: null,
    body: { data: {} },
    ...over,
  });
  const NOW = 1_000_000_000_000;
  const resetIn = (ms: number) => (NOW + ms) / 1000;

  test("a success is never retried, even with a retry-after or nothing left", () => {
    expect(retryDelayMs(reply({ retryAfter: 30, remaining: 0 }), 0, NOW)).toBeNull();
  });

  test("the secondary limit honours retry-after, then backs off", () => {
    expect(retryDelayMs(reply({ status: 403, retryAfter: 60, body: {} }), 0, NOW)).toBe(60_000);
    expect(retryDelayMs(reply({ status: 429, body: {} }), 1, NOW)).toBe(10_000);
  });

  test("a used-up hourly limit waits for its reset when it is close", () => {
    const graphql = reply({ body: { errors: [{ type: "RATE_LIMITED" }] }, reset: resetIn(30_000) });
    expect(retryDelayMs(graphql, 0, NOW)).toBe(31_000);
    const rest = reply({ status: 403, remaining: 0, reset: resetIn(30_000), body: null });
    expect(retryDelayMs(rest, 0, NOW)).toBe(31_000);
  });

  test("a used-up hourly limit fails at once when the reset is far off or unknown", () => {
    const far = reply({ status: 403, remaining: 0, reset: resetIn(MAX_RESET_WAIT_MS), body: null });
    expect(retryDelayMs(far, 0, NOW)).toBeNull();
    expect(retryDelayMs(reply({ status: 403, remaining: 0, body: null }), 0, NOW)).toBeNull();
  });

  test("an error that would come back the same way is not retried", () => {
    const rejected = reply({ body: { errors: [{ message: 'Parse error on "}"' }] } });
    expect(retryDelayMs(rejected, 0, NOW)).toBeNull();
    expect(retryDelayMs(reply({ status: 401, body: {} }), 0, NOW)).toBeNull();
  });

  test("a 5xx and a 200 that is not JSON are retried, up to the limit", () => {
    expect(retryDelayMs(reply({ status: 502, body: {} }), 0, NOW)).toBe(5_000);
    expect(retryDelayMs(reply({ body: { raw: "<html>" } }), 0, NOW)).toBe(5_000);
    expect(retryDelayMs(reply({ status: 502, body: {} }), 5, NOW)).toBeNull();
  });

  test("a query GitHub rejects fails on the first answer, without waiting", async () => {
    const s = stubFetch([{ body: { errors: [{ message: "Field 'nope' doesn't exist" }] } }]);
    restore = s.restore;
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined as any);
    await expect(new GitHubClient("t").getLanguages("o", "r")).rejects.toThrow(/doesn't exist/);
    expect(s.calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    sleep.mockRestore();
  });

  test("a client waits out a close reset and carries on", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 20);
    const s = stubFetch([
      { headers: { "x-ratelimit-reset": reset }, body: { errors: [{ type: "RATE_LIMITED" }] } },
      { body: { data: { repository: { languages: { nodes: [{ name: "Go" }] } } } } },
    ]);
    restore = s.restore;
    const sleep = spyOn(Bun, "sleep").mockResolvedValue(undefined as any);
    expect(await new GitHubClient("t").getLanguages("o", "r")).toEqual(["Go"]);
    const waited = sleep.mock.calls[0]![0] as number;
    expect(waited).toBeGreaterThan(15_000);
    expect(waited).toBeLessThanOrEqual(21_000);
    sleep.mockRestore();
  });
});

describe("pagination", () => {
  test("follows endCursor across pages and merges the files", async () => {
    const page = (n: number, hasNext: boolean, cursor: string | null) => ({
      body: {
        data: {
          repository: {
            pullRequest: {
              id: "PR_1",
              headRefOid: "abc",
              files: {
                pageInfo: { hasNextPage: hasNext, endCursor: cursor },
                nodes: Array.from({ length: n }, (_, i) => ({
                  path: `p${cursor ?? "last"}${i}.txt`,
                  viewerViewedState: "UNVIEWED",
                })),
              },
            },
          },
        },
      },
    });
    const threads = {
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ path: "p1.txt" }, { path: null }],
              },
            },
          },
        },
      },
    };
    const s = stubFetch([page(100, true, "c1"), page(12, false, null), threads]);
    restore = s.restore;
    const pr = await new GitHubClient("t").getPullRequest("o", "r", 1);
    expect(pr.files).toHaveLength(112);
    expect(pr.headRefOid).toBe("abc");
    expect(pr.reviewThreadPaths).toEqual(new Set(["p1.txt"]));
  });

  test("a missing PR is reported clearly", async () => {
    const s = stubFetch([{ body: { data: { repository: null } } }]);
    restore = s.restore;
    await expect(new GitHubClient("t").getPullRequest("o", "r", 9)).rejects.toThrow(
      /o\/r#9 not found/,
    );
  });
});

describe("searchReviewRequested", () => {
  test("maps the search payload to targets for watch", async () => {
    const s = stubFetch([
      {
        body: {
          data: {
            search: {
              nodes: [{ number: 7, repository: { name: "r", owner: { login: "o" } } }, {}],
            },
          },
        },
      },
    ]);
    restore = s.restore;
    const out = await new GitHubClient("t").searchReviewRequested();
    expect(out).toEqual([{ owner: "o", repo: "r", number: 7 }]);
    expect(s.calls[0]!.variables.q).toContain("review-requested:@me");
  });
});
