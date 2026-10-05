/**
 * GitHub GraphQL client.
 *
 * Two things here were measured against the real API and are not optional:
 *
 * 1. A batch of aliased mutations is capped at 76. Past that GitHub returns
 *    HTTP 200 with per-alias RESOURCE_LIMITS_EXCEEDED entries in `errors[]`,
 *    so a client that only looks at the status silently marks fewer files than
 *    it reports. We batch at 50 and always read `errors[]`.
 * 2. The secondary rate limit answers with 403 plus `retry-after`, and it hits
 *    plain queries issued right after a burst of mutations, not just the
 *    mutations. Every request goes through the same retry wrapper.
 *
 * The hourly (primary) limit is different: once used up, GraphQL answers 200
 * with a RATE_LIMITED error and REST answers 403 with `x-ratelimit-remaining:
 * 0`. Backing off for seconds cannot help, so we wait for `x-ratelimit-reset`
 * when it is close and fail at once when it is not.
 */

export const BATCH_SIZE = 50;
/** Measured against the real API: alias 76 onward fails. Never go above this. */
export const MAX_ALIASES_PER_REQUEST = 76;

const ENDPOINT = "https://api.github.com/graphql";
export const USER_AGENT = "gh-skim";
const MAX_RETRIES = 5;
/** Longest wait for the hourly limit to reset; further off, the request fails instead. */
export const MAX_RESET_WAIT_MS = 5 * 60_000;

/** What decides a retry, read from one response. */
type Reply = {
  status: number;
  retryAfter: number | null;
  /** `x-ratelimit-remaining`. */
  remaining: number | null;
  /** `x-ratelimit-reset`, epoch seconds. */
  reset: number | null;
  body: any;
};

const numberHeader = (headers: { get(k: string): string | null }, name: string) => {
  const v = headers.get(name);
  return v === null || v === "" ? null : Number(v);
};

/**
 * How long to wait before sending a request again, or null to stop and let the
 * caller report the response.
 *
 * Retried: the secondary limit (403/429, honouring `retry-after`), 5xx, and a
 * 200 whose body is not JSON. Not retried: anything else, such as a query
 * GitHub rejected, which would fail the same way every time.
 */
export function retryDelayMs(r: Reply, attempt: number, now = Date.now()): number | null {
  if (attempt >= MAX_RETRIES) return null;

  const hourlyLimit =
    r.retryAfter === null &&
    (((r.status === 403 || r.status === 429) && r.remaining === 0) ||
      (r.body?.errors ?? []).some((e: any) => e?.type === "RATE_LIMITED"));
  if (hourlyLimit) {
    if (r.reset === null) return null;
    const wait = Math.max(0, r.reset * 1000 - now) + 1000;
    return wait <= MAX_RESET_WAIT_MS ? wait : null;
  }

  const throttled =
    r.status === 403 || r.status === 429 || (r.retryAfter !== null && r.status >= 400);
  const transient = r.status >= 500 || (r.status === 200 && r.body?.raw !== undefined);
  if (!throttled && !transient) return null;
  return (r.retryAfter ?? Math.min(60, 5 * (attempt + 1))) * 1000;
}

export type FileViewedState = "VIEWED" | "UNVIEWED" | "DISMISSED";

export type ChangedFile = {
  path: string;
  viewerViewedState: FileViewedState;
};

export type PullRequestInfo = {
  id: string;
  headRefOid: string;
  files: ChangedFile[];
  /** Paths that already carry review threads; never touched. */
  reviewThreadPaths: Set<string>;
};

export type BatchOutcome = {
  succeeded: string[];
  failed: { path: string; message: string }[];
};

export class GitHubClient {
  constructor(
    private readonly token: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private async request(query: string, variables: Record<string, unknown>): Promise<Reply> {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `bearer ${this.token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify({ query, variables }),
    });
    const text = await r.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 400) };
    }
    return {
      status: r.status,
      retryAfter: numberHeader(r.headers, "retry-after"),
      remaining: numberHeader(r.headers, "x-ratelimit-remaining"),
      reset: numberHeader(r.headers, "x-ratelimit-reset"),
      body,
    };
  }

  /** Used for queries and mutations alike; see `retryDelayMs` for what is retried. */
  private async requestWithRetry(
    query: string,
    variables: Record<string, unknown>,
    label: string,
  ): Promise<Reply> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.request(query, variables);
      const wait = retryDelayMs(res, attempt);
      if (wait === null) return res;
      this.log(
        `rate limited on ${label} (http ${res.status}), waiting ${Math.ceil(wait / 1000)}s before retry ${attempt + 1}`,
      );
      await Bun.sleep(wait);
    }
  }

  private async query<T>(
    query: string,
    variables: Record<string, unknown>,
    label: string,
  ): Promise<T> {
    const res = await this.requestWithRetry(query, variables, label);
    if (res.body?.errors?.length) {
      throw new Error(`${label} failed: ${JSON.stringify(res.body.errors).slice(0, 400)}`);
    }
    if (!res.body?.data) {
      throw new Error(
        `${label} failed: http ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`,
      );
    }
    return res.body.data as T;
  }

  /**
   * PR metadata plus every changed file, paginated.
   *
   * `viewedState: false` drops `viewerViewedState` from the query. Use it with
   * a GitHub App *installation* token: the "viewer" there is the app itself,
   * whose viewed state is meaningless. Read real viewed state per reviewer,
   * with the reviewer's own token.
   */
  async getPullRequest(
    owner: string,
    repo: string,
    number: number,
    opts: { viewedState?: boolean } = {},
  ): Promise<PullRequestInfo> {
    const viewedField = opts.viewedState === false ? "" : "viewerViewedState";
    const files: ChangedFile[] = [];
    const reviewThreadPaths = new Set<string>();
    let cursor: string | null = null;
    let id = "";
    let headRefOid = "";

    for (;;) {
      const data: any = await this.query<any>(
        `query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){
           repository(owner:$owner,name:$repo){
             pullRequest(number:$pr){
               id headRefOid
               files(first:100, after:$cursor){
                 pageInfo{ hasNextPage endCursor }
                 nodes{ path ${viewedField} }
               }
             }
           }
         }`,
        { owner, repo, pr: number, cursor },
        "pull request files",
      );
      const p: any = data.repository?.pullRequest;
      if (!p) throw new Error(`${owner}/${repo}#${number} not found, or no access to it`);
      id = p.id;
      headRefOid = p.headRefOid;
      for (const n of p.files.nodes) {
        files.push({ viewerViewedState: "UNVIEWED", ...n });
      }
      if (!p.files.pageInfo.hasNextPage) break;
      cursor = p.files.pageInfo.endCursor;
    }

    // Review threads are a separate connection; paginate it too.
    let tCursor: string | null = null;
    for (;;) {
      const data: any = await this.query<any>(
        `query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){
           repository(owner:$owner,name:$repo){
             pullRequest(number:$pr){
               reviewThreads(first:100, after:$cursor){
                 pageInfo{ hasNextPage endCursor }
                 nodes{ path }
               }
             }
           }
         }`,
        { owner, repo, pr: number, cursor: tCursor },
        "review threads",
      );
      const t: any = data.repository.pullRequest.reviewThreads;
      for (const n of t.nodes) if (n.path) reviewThreadPaths.add(n.path);
      if (!t.pageInfo.hasNextPage) break;
      tCursor = t.pageInfo.endCursor;
    }

    return { id, headRefOid, files, reviewThreadPaths };
  }

  /** A text file from a ref, or null when it does not exist. */
  async getFileAtRef(
    owner: string,
    repo: string,
    ref: string,
    path: string,
  ): Promise<string | null> {
    // REST, not GraphQL: a GitHub App can be granted only the "single file"
    // permission on the two config files, and that permission covers the
    // contents endpoint. It leaves the rest of the repository unreadable.
    const url =
      `https://api.github.com/repos/${owner}/${repo}/contents/` +
      `${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, {
        headers: {
          authorization: `bearer ${this.token}`,
          accept: "application/vnd.github.raw+json",
          "user-agent": USER_AGENT,
        },
      });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
      const wait = retryDelayMs(
        {
          status: r.status,
          retryAfter: numberHeader(r.headers, "retry-after"),
          remaining: numberHeader(r.headers, "x-ratelimit-remaining"),
          reset: numberHeader(r.headers, "x-ratelimit-reset"),
          body: null,
        },
        attempt,
      );
      if (wait === null) {
        throw new Error(
          `read ${path} at ${ref} failed: http ${r.status} ${(await r.text()).slice(0, 200)}`,
        );
      }
      this.log(
        `rate limited on read ${path} (http ${r.status}), waiting ${Math.ceil(wait / 1000)}s`,
      );
      await Bun.sleep(wait);
    }
  }

  /** Who this token belongs to. */
  async viewer(): Promise<{ login: string; databaseId: number }> {
    const data = await this.query<any>(`query{ viewer{ login databaseId } }`, {}, "viewer");
    return { login: data.viewer.login, databaseId: data.viewer.databaseId };
  }

  async getLanguages(owner: string, repo: string): Promise<string[]> {
    const data = await this.query<any>(
      `query($owner:String!,$repo:String!){
         repository(owner:$owner,name:$repo){
           languages(first:10, orderBy:{field:SIZE, direction:DESC}){ nodes{ name } }
         }
       }`,
      { owner, repo },
      "repository languages",
    );
    return (data.repository?.languages?.nodes ?? []).map((n: any) => n.name);
  }

  /** PRs where the viewer is a requested reviewer, for `watch`. */
  async searchReviewRequested(
    limit = 20,
  ): Promise<{ owner: string; repo: string; number: number }[]> {
    const data = await this.query<any>(
      `query($q:String!,$n:Int!){
         search(query:$q, type:ISSUE, first:$n){
           nodes{ ... on PullRequest {
             number
             repository{ name owner{ login } }
           } }
         }
       }`,
      { q: "is:open is:pr review-requested:@me", n: limit },
      "review-requested search",
    );
    return (data.search?.nodes ?? [])
      .filter((n: any) => n?.repository)
      .map((n: any) => ({
        owner: n.repository.owner.login,
        repo: n.repository.name,
        number: n.number,
      }));
  }

  /**
   * Mark or unmark, one request per `BATCH_SIZE` paths.
   * `onBatch` fires after each request with the paths that actually
   * succeeded, so the caller can persist a ledger as it goes rather than
   * only at the end.
   */
  async setViewed(
    prId: string,
    paths: string[],
    op: "mark" | "unmark",
    onBatch?: (succeeded: string[]) => Promise<void> | void,
  ): Promise<BatchOutcome> {
    const field = op === "mark" ? "markFileAsViewed" : "unmarkFileAsViewed";
    const outcome: BatchOutcome = { succeeded: [], failed: [] };

    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const slice = paths.slice(i, i + BATCH_SIZE);
      const decls = slice.map((_, j) => `$p${j}:String!`).join(",");
      const body = slice
        .map((_, j) => `a${j}:${field}(input:{pullRequestId:$pid,path:$p${j}}){clientMutationId}`)
        .join(" ");
      const variables: Record<string, unknown> = { pid: prId };
      slice.forEach((p, j) => (variables[`p${j}`] = p));

      const res = await this.requestWithRetry(
        `mutation($pid:ID!,${decls}){${body}}`,
        variables,
        `${op} batch at ${i}`,
      );

      const verdict = verifyAliasBatch(slice, res.status, res.body);
      outcome.succeeded.push(...verdict.succeeded);
      outcome.failed.push(...verdict.failed);
      if (onBatch && verdict.succeeded.length) await onBatch(verdict.succeeded);
    }

    return outcome;
  }
}

/**
 * Decide, for one aliased-mutation request, which paths actually changed.
 *
 * This is the single most important piece of the client. Measurement showed that a
 * request carrying more than 76 aliases still returns **HTTP 200** and reports
 * the overflow only as per-alias `RESOURCE_LIMITS_EXCEEDED` entries in
 * `errors[]`. Anything that trusts the status code reports more marks than it
 * made, and the ledger then lies about what can be undone.
 *
 * `slice` is the paths sent, in alias order: alias `aN` is `slice[N]`.
 */
export function verifyAliasBatch(slice: string[], status: number, body: any): BatchOutcome {
  const failed: BatchOutcome["failed"] = [];
  const failedIdx = new Set<number>();

  for (const e of body?.errors ?? []) {
    const alias = Array.isArray(e.path) ? String(e.path[0] ?? "") : "";
    const m = /^a(\d+)$/.exec(alias);
    if (m) {
      const j = Number(m[1]);
      if (j < slice.length && !failedIdx.has(j)) {
        failedIdx.add(j);
        failed.push({ path: slice[j]!, message: e.message ?? "unknown error" });
      }
    }
  }

  // A whole-request failure (no `data`, no per-alias errors) fails every path.
  if (!body?.data && (body?.errors ?? []).length === 0) {
    for (let j = 0; j < slice.length; j++) {
      if (failedIdx.has(j)) continue;
      failedIdx.add(j);
      failed.push({
        path: slice[j]!,
        message: `http ${status}: ${JSON.stringify(body).slice(0, 160)}`,
      });
    }
  }

  return { succeeded: slice.filter((_, j) => !failedIdx.has(j)), failed };
}
