#!/usr/bin/env bun
import { loadRules, markFiles, plan, undoMarks } from "@skim/engine";
import { GitHubClient, parseTarget, type Target } from "@skim/github";
import { groupByRule, parsePatterns } from "@skim/rules";
import { configDir, ledgerPath, ledgerStore } from "./ledger.ts";

const USAGE = `gh skim — mark noise files as viewed so a review shows what matters

  gh skim <pr-url|owner/repo#N|N> [options]
  gh skim watch [options]

Options
  --dry-run            print the plan and change nothing
  --undo               unmark everything this tool marked on the PR
  --preset a,b         use these presets instead of detection or the config file
  --rules FILE         also apply this local ignore file, on top of the repo's rules
                       (default: ~/.config/gh-skim/rules/<owner>/<repo>, if it exists)
  -R, --repo O/R       repository, when the PR is given as a bare number
  --interval N         watch: minutes between polls (default 5)
  --once               watch: one pass, then exit
  --verbose            list every path and the rule that hid it
  -h, --help           this text

The token comes from \`gh auth token\`. Nothing is stored but the ledger of
what was marked, under ~/.config/gh-skim/.`;

type Flags = {
  dryRun: boolean;
  undo: boolean;
  presets: string[] | null;
  rules: string | null;
  repo: string | null;
  interval: number;
  once: boolean;
  verbose: boolean;
  help: boolean;
  positional: string[];
};

function parseFlags(argv: string[]): Flags {
  const f: Flags = {
    dryRun: false,
    undo: false,
    presets: null,
    rules: null,
    repo: null,
    interval: 5,
    once: false,
    verbose: false,
    help: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--dry-run":
        f.dryRun = true;
        break;
      case "--undo":
        f.undo = true;
        break;
      case "--verbose":
        f.verbose = true;
        break;
      case "--once":
        f.once = true;
        break;
      case "-h":
      case "--help":
        f.help = true;
        break;
      case "--rules":
        f.rules = argv[++i] ?? null;
        break;
      case "--preset":
        f.presets = (argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "-R":
      case "--repo":
        f.repo = argv[++i] ?? null;
        break;
      case "--interval": {
        const n = Number(argv[++i]);
        if (!(n > 0)) throw new Error("--interval needs a number of minutes above 0");
        f.interval = n;
        break;
      }
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
        f.positional.push(a);
    }
  }
  return f;
}

function token(): string {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const r = Bun.spawnSync(["gh", "auth", "token"]);
  const t = new TextDecoder().decode(r.stdout).trim();
  if (!t) {
    throw new Error("no token: run `gh auth login`, or set GH_TOKEN");
  }
  return t;
}

/** `gh repo view` when the PR was given as a bare number and no -R was passed. */
function repoFromCwd(): string | undefined {
  const r = Bun.spawnSync([
    "gh",
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  const s = new TextDecoder().decode(r.stdout).trim();
  return s || undefined;
}

/**
 * Personal rules for one repository, kept outside the repo. Lets you use the
 * tool on a repo that has no .github/review-ignore yet, and lets watch mode
 * apply different rules to different repos.
 */
async function localRulesFor(owner: string, repo: string): Promise<string | null> {
  const path = `${configDir()}/rules/${owner}/${repo}`;
  return (await Bun.file(path).exists()) ? path : null;
}

async function runOne(target: Target, flags: Flags, log: (s: string) => void): Promise<number> {
  const client = new GitHubClient(token(), (m) => log(`  ${m}`));
  const label = `${target.owner}/${target.repo}#${target.number}`;

  if (flags.undo) {
    const noMeta = { sha: "", ruleFor: () => null };
    const store = await ledgerStore(target.owner, target.repo, target.number, noMeta);
    const out = await undoMarks(client, target, store, { dryRun: flags.dryRun });
    if (out.recorded === 0) {
      log(`${label}: nothing recorded, so nothing to undo`);
      return 0;
    }
    log(`${label}: unmarking ${out.toUndo} of ${out.recorded} recorded files`);
    if (flags.dryRun) {
      log("dry run, nothing changed");
      return 0;
    }
    log(
      `unmarked ${out.succeeded.length}${out.failed.length ? `, ${out.failed.length} failed` : ""}` +
        (out.stale ? `, dropped ${out.stale} record(s) of files no longer viewed` : ""),
    );
    for (const f of out.failed.slice(0, 5)) log(`  failed ${f.path}: ${f.message}`);
    return out.failed.length ? 1 : 0;
  }

  const pr = await client.getPullRequest(target.owner, target.repo, target.number);

  const config = await loadRules(client, target.owner, target.repo, pr.headRefOid, flags.presets);

  // A local rules file is the last, highest-precedence source, so it can both
  // add rules and `!` un-hide what the repo or preset hides. It lets you try
  // rules on a real pull request before committing them to the repo.
  const rulesPath = flags.rules ?? (await localRulesFor(target.owner, target.repo));
  if (rulesPath) {
    const text = await Bun.file(rulesPath).text();
    config.sources.push({
      name: rulesPath.replace(process.env.HOME ?? "~", "~"),
      patterns: parsePatterns(text),
    });
  }

  const p = plan(pr.files, config.sources, pr.reviewThreadPaths);

  const presetLabel = config.presets.length ? config.presets.join(", ") : "none";
  log(
    `${label}: ${pr.files.length} files changed. ` +
      `presets ${presetLabel} (${config.presetOrigin})` +
      (config.hasReviewIgnore ? ", .github/review-ignore from this branch" : "") +
      (config.linguistPatterns.length
        ? `, ${config.linguistPatterns.length} linguist-generated rules`
        : ""),
  );

  const groups = groupByRule(p.matches);
  const matchedCount = p.matches.filter((m) => m.hidden).length;

  for (const [rule, paths] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    log(`  ${String(paths.length).padStart(5)}  ${rule}`);
    if (flags.verbose) for (const path of paths) log(`         ${path}`);
  }

  const skippedThreads = p.skipped.filter((s) => s.reason === "has-review-thread");
  const skippedViewed = p.skipped.filter((s) => s.reason === "already-viewed");
  if (skippedThreads.length)
    log(`  skipping ${skippedThreads.length} file(s) with review comments`);
  if (skippedViewed.length) log(`  skipping ${skippedViewed.length} file(s) already marked viewed`);

  if (p.allNoise) {
    log(`all ${pr.files.length} files matched ${presetLabel}, nothing left to review`);
  } else {
    log(`${matchedCount} matched, ${p.remaining} left to review`);
  }

  if (flags.dryRun) {
    log(`dry run: would mark ${p.toMark.length} file(s). Nothing changed.`);
    return 0;
  }

  if (p.toMark.length === 0) {
    log("nothing to mark");
    return 0;
  }

  const ruleByPath = new Map(p.matches.map((m) => [m.path, m.rule]));
  // Recorded per batch: a crash halfway leaves an accurate partial record.
  const store = await ledgerStore(target.owner, target.repo, target.number, {
    sha: pr.headRefOid,
    ruleFor: (path) => ruleByPath.get(path) ?? null,
  });
  const started = Date.now();

  const out = await markFiles(client, target, pr.id, p.toMark, store);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  log(`marked ${out.succeeded.length} file(s) viewed in ${secs}s`);
  if (out.appliedDespiteError.length) {
    log(`  ${out.appliedDespiteError.length} reported as failed had in fact been applied`);
  }
  if (out.failed.length) {
    log(`${out.failed.length} failed:`);
    for (const f of out.failed.slice(0, 5)) log(`  ${f.path}: ${f.message}`);
  }
  log(`ledger: ${ledgerPath(target.owner, target.repo, target.number)}`);
  log(
    `hide them in the browser: https://github.com/${target.owner}/${target.repo}` +
      `/pull/${target.number}/files?show-viewed-files=false`,
  );
  return out.failed.length ? 1 : 0;
}

async function watch(flags: Flags, log: (s: string) => void): Promise<number> {
  const client = new GitHubClient(token(), (m) => log(`  ${m}`));
  for (;;) {
    const prs = await client.searchReviewRequested();
    log(`${new Date().toISOString()}: ${prs.length} PR(s) awaiting your review`);
    for (const t of prs) {
      try {
        await runOne(t, flags, log);
      } catch (e) {
        log(`${t.owner}/${t.repo}#${t.number}: ${(e as Error).message}`);
      }
    }
    if (flags.once) return 0;
    await Bun.sleep(flags.interval * 60_000);
  }
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const log = (s: string) => console.log(s);

  if (flags.help || flags.positional.length === 0) {
    console.log(USAGE);
    return flags.help ? 0 : 1;
  }

  if (flags.positional[0] === "watch") return watch(flags, log);

  const target = parseTarget(flags.positional[0]!, flags.repo ?? repoFromCwd());
  return runOne(target, flags, log);
}

try {
  process.exit(await main());
} catch (e) {
  console.error(`gh skim: ${(e as Error).message}`);
  process.exit(1);
}
