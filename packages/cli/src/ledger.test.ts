import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  appendLedger,
  clearLedger,
  ledgerPath,
  ledgerStore,
  readLedger,
  type LedgerEntry,
} from "./ledger.ts";

const roots: string[] = [];
async function tempRoot() {
  const d = await mkdtemp(`${tmpdir()}/skim-ledger-`);
  roots.push(d);
  return d;
}
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const entry = (path: string): LedgerEntry => ({
  path,
  sha: "abc123",
  rule: "**/__Snapshots__/**",
  markedAt: "2026-09-19T00:00:00.000Z",
});

describe("ledger", () => {
  test("path is namespaced per owner, repo and PR", () => {
    expect(ledgerPath("o", "r", 12, "/root")).toBe("/root/o/r/12.json");
  });

  test("an unknown PR reads as empty rather than throwing", async () => {
    const root = await tempRoot();
    expect(await readLedger("o", "r", 1, root)).toEqual({
      owner: "o",
      repo: "r",
      pr: 1,
      entries: [],
    });
  });

  test("append persists immediately, so a crash keeps what was written", async () => {
    const root = await tempRoot();
    const l = await readLedger("o", "r", 1, root);
    await appendLedger(l, [entry("a.txt"), entry("b.txt")], root);
    // Re-read from disk rather than trusting the in-memory object.
    expect((await readLedger("o", "r", 1, root)).entries.map((e) => e.path)).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  test("appending in several batches accumulates", async () => {
    const root = await tempRoot();
    const l = await readLedger("o", "r", 1, root);
    await appendLedger(l, [entry("a.txt")], root);
    await appendLedger(l, [entry("b.txt")], root);
    expect((await readLedger("o", "r", 1, root)).entries).toHaveLength(2);
  });

  test("the same path twice is recorded once", async () => {
    const root = await tempRoot();
    const l = await readLedger("o", "r", 1, root);
    await appendLedger(l, [entry("a.txt")], root);
    await appendLedger(l, [entry("a.txt")], root);
    expect((await readLedger("o", "r", 1, root)).entries).toHaveLength(1);
  });

  test("entries keep the rule that hid the file, so a mark can be audited", async () => {
    const root = await tempRoot();
    const l = await readLedger("o", "r", 1, root);
    await appendLedger(l, [entry("a.txt")], root);
    const back = await readLedger("o", "r", 1, root);
    expect(back.entries[0]!.rule).toBe("**/__Snapshots__/**");
    expect(back.entries[0]!.sha).toBe("abc123");
  });

  test("clear removes the file and clearing nothing is not an error", async () => {
    const root = await tempRoot();
    const l = await readLedger("o", "r", 1, root);
    await appendLedger(l, [entry("a.txt")], root);
    await clearLedger("o", "r", 1, root);
    expect((await readLedger("o", "r", 1, root)).entries).toEqual([]);
    await clearLedger("o", "r", 1, root);
  });

  test("different PRs do not share a ledger", async () => {
    const root = await tempRoot();
    await appendLedger(await readLedger("o", "r", 1, root), [entry("a.txt")], root);
    await appendLedger(await readLedger("o", "r", 2, root), [entry("b.txt")], root);
    expect((await readLedger("o", "r", 1, root)).entries.map((e) => e.path)).toEqual(["a.txt"]);
    expect((await readLedger("o", "r", 2, root)).entries.map((e) => e.path)).toEqual(["b.txt"]);
  });
});

describe("ledgerStore", () => {
  const meta = { sha: "abc", ruleFor: (p: string) => (p.endsWith(".lock") ? "*.lock" : null) };

  test("records with the sha and rule, and reads them back", async () => {
    const root = await tempRoot();
    const store = await ledgerStore("o", "r", 1, meta, root);
    await store.record(["yarn.lock", "a.txt"]);
    expect(store.recorded()).toEqual(["yarn.lock", "a.txt"]);
    const l = await readLedger("o", "r", 1, root);
    expect(l.entries.map((e) => [e.path, e.sha, e.rule])).toEqual([
      ["yarn.lock", "abc", "*.lock"],
      ["a.txt", "abc", null],
    ]);
  });

  test("forgetting everything removes the file", async () => {
    const root = await tempRoot();
    const store = await ledgerStore("o", "r", 1, meta, root);
    await store.record(["a", "b"]);
    await store.forget(["a"]);
    expect((await readLedger("o", "r", 1, root)).entries.map((e) => e.path)).toEqual(["b"]);
    await store.forget(["b"]);
    expect(await Bun.file(ledgerPath("o", "r", 1, root)).exists()).toBe(false);
  });
});
