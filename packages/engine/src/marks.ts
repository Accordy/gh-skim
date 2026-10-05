import type { BatchOutcome, ChangedFile, GitHubClient } from "@skim/github";

/**
 * Where one reviewer's marks on one PR are recorded. Undo only ever reverses
 * what is recorded here, because after the fact our mark cannot be told apart
 * from one the reviewer set by hand. The CLI keeps it in a JSON file; a server
 * would keep it in its database.
 */
export interface MarkStore {
  recorded(): string[] | Promise<string[]>;
  record(paths: string[]): void | Promise<void>;
  forget(paths: string[]): void | Promise<void>;
}

export type PullRequestRef = { owner: string; repo: string; number: number };

export type MarkOutcome = BatchOutcome & {
  /** Failures as GitHub first reported them, before reconciling. */
  reported: BatchOutcome["failed"];
  /** Reported as failed, but GitHub had applied them. */
  appliedDespiteError: string[];
  /** Really not applied the first time, so sent once more. */
  retried: string[];
};

/**
 * Mark paths viewed for the reviewer behind `client`, recording every mark as
 * it lands.
 *
 * Reported failures are not trusted. Under sustained load GitHub answers an
 * aliased mutation with `Resource limits for this query exceeded` for the tail
 * of the request *after having applied it*. Believing the error would leave
 * those paths out of the store, and undo can only reverse what the store
 * knows about. So on any failure, ask GitHub what is actually true, record
 * what landed, and retry the rest once.
 */
export async function markFiles(
  client: GitHubClient,
  pr: PullRequestRef,
  prId: string,
  paths: string[],
  store: MarkStore,
): Promise<MarkOutcome> {
  const out = await client.setViewed(prId, paths, "mark", (ok) => store.record(ok));
  const result: MarkOutcome = {
    succeeded: out.succeeded,
    failed: out.failed,
    reported: out.failed,
    appliedDespiteError: [],
    retried: [],
  };
  if (out.failed.length === 0) return result;

  const reread = new Map(
    (await client.getPullRequest(pr.owner, pr.repo, pr.number)).files.map((f) => [
      f.path,
      f.viewerViewedState,
    ]),
  );
  const { landed, stillTodo } = reconcileFailures(out.failed, reread);
  if (landed.length) await store.record(landed);
  result.succeeded = [...out.succeeded, ...landed];
  result.appliedDespiteError = landed;
  result.retried = stillTodo;
  result.failed = [];
  if (stillTodo.length) {
    const retry = await client.setViewed(prId, stillTodo, "mark", (ok) => store.record(ok));
    result.succeeded.push(...retry.succeeded);
    result.failed = retry.failed;
  }
  return result;
}

/**
 * Split reported failures into the ones GitHub actually applied and the ones
 * that really need retrying.
 *
 * GitHub was measured applying the tail mutation of an aliased request and still
 * reporting `Resource limits for this query exceeded` for it: 36 of 1800 paths
 * came back failed and all 36 read `VIEWED` moments later.
 */
export function reconcileFailures(
  failed: readonly { path: string }[],
  state: ReadonlyMap<string, string | null | undefined>,
): { landed: string[]; stillTodo: string[] } {
  const landed: string[] = [];
  const stillTodo: string[] = [];
  for (const f of failed) {
    (state.get(f.path) === "VIEWED" ? landed : stillTodo).push(f.path);
  }
  return { landed, stillTodo };
}

/**
 * What undo should touch: recorded paths that are still VIEWED. A file the
 * reviewer has since unmarked, or that changed and went DISMISSED, is left
 * alone, and its record is stale.
 */
export function planUndo(
  files: readonly ChangedFile[],
  recorded: readonly string[],
): { toUndo: string[]; stale: string[] } {
  const stillViewed = new Set(
    files.filter((f) => f.viewerViewedState === "VIEWED").map((f) => f.path),
  );
  return {
    toUndo: recorded.filter((p) => stillViewed.has(p)),
    stale: recorded.filter((p) => !stillViewed.has(p)),
  };
}

export type UndoOutcome = BatchOutcome & { recorded: number; toUndo: number; stale: number };

/**
 * Unmark what was recorded for the reviewer behind `client`. Unmarked paths
 * and stale records are both forgotten, so a second undo does not keep
 * reporting work that no longer exists. With `dryRun`, nothing changes.
 */
export async function undoMarks(
  client: GitHubClient,
  pr: PullRequestRef,
  store: MarkStore,
  opts: { dryRun?: boolean } = {},
): Promise<UndoOutcome> {
  const recorded = await store.recorded();
  const empty = { recorded: 0, toUndo: 0, stale: 0, succeeded: [], failed: [] };
  if (recorded.length === 0) return empty;

  const info = await client.getPullRequest(pr.owner, pr.repo, pr.number);
  const { toUndo, stale } = planUndo(info.files, recorded);
  const counts = { recorded: recorded.length, toUndo: toUndo.length, stale: stale.length };
  if (opts.dryRun) return { ...counts, succeeded: [], failed: [] };

  const out = await client.setViewed(info.id, toUndo, "unmark");
  await store.forget([...out.succeeded, ...stale]);
  return { ...counts, ...out };
}
