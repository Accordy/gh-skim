import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { MarkStore } from "@skim/engine";

/**
 * What we marked, per PR. After the fact we cannot tell our mark from one the
 * reviewer set by hand, so undo only ever touches paths recorded here.
 */
export type LedgerEntry = {
  path: string;
  /** Head sha at the time of marking; a later push invalidates the mark anyway. */
  sha: string;
  /** The rule that hid it, kept so the reviewer can audit the decision. */
  rule: string | null;
  markedAt: string;
};

export type Ledger = {
  owner: string;
  repo: string;
  pr: number;
  entries: LedgerEntry[];
};

/** ~/.config/gh-skim, holding personal rules and the ledgers. */
export function configDir(): string {
  return `${process.env.XDG_CONFIG_HOME ?? `${homedir()}/.config`}/gh-skim`;
}

export function ledgerPath(owner: string, repo: string, pr: number, root?: string): string {
  const base = root ?? configDir();
  return `${base}/${owner}/${repo}/${pr}.json`;
}

export async function readLedger(
  owner: string,
  repo: string,
  pr: number,
  root?: string,
): Promise<Ledger> {
  const file = ledgerPath(owner, repo, pr, root);
  try {
    return JSON.parse(await readFile(file, "utf8")) as Ledger;
  } catch {
    return { owner, repo, pr, entries: [] };
  }
}

export async function writeLedger(ledger: Ledger, root?: string): Promise<void> {
  const file = ledgerPath(ledger.owner, ledger.repo, ledger.pr, root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(ledger, null, 1), "utf8");
}

/**
 * Add entries and persist immediately. Called once per mutation batch so a
 * crash halfway through leaves an accurate record of what did get marked,
 * rather than none.
 */
export async function appendLedger(
  ledger: Ledger,
  entries: LedgerEntry[],
  root?: string,
): Promise<Ledger> {
  const known = new Set(ledger.entries.map((e) => e.path));
  for (const e of entries) if (!known.has(e.path)) ledger.entries.push(e);
  await writeLedger(ledger, root);
  return ledger;
}

export async function clearLedger(
  owner: string,
  repo: string,
  pr: number,
  root?: string,
): Promise<void> {
  try {
    await unlink(ledgerPath(owner, repo, pr, root));
  } catch {
    /* nothing recorded for this PR */
  }
}

/**
 * The ledger for one PR as the engine's MarkStore. `ruleFor` and `sha` are
 * written next to each new entry so a mark can be audited later.
 */
export async function ledgerStore(
  owner: string,
  repo: string,
  pr: number,
  meta: { sha: string; ruleFor: (path: string) => string | null },
  root?: string,
): Promise<MarkStore> {
  const ledger = await readLedger(owner, repo, pr, root);
  return {
    recorded: () => ledger.entries.map((e) => e.path),
    record: async (paths) => {
      const markedAt = new Date().toISOString();
      await appendLedger(
        ledger,
        paths.map((path) => ({ path, sha: meta.sha, rule: meta.ruleFor(path), markedAt })),
        root,
      );
    },
    forget: async (paths) => {
      const gone = new Set(paths);
      ledger.entries = ledger.entries.filter((e) => !gone.has(e.path));
      if (ledger.entries.length === 0) await clearLedger(owner, repo, pr, root);
      else await writeLedger(ledger, root);
    },
  };
}
