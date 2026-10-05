# Skim

Hide the files nobody reads in a pull request, so the review shows only the
ones that need you.

Lock files, generated code, build output and vendored dependencies can make a
pull request look ten times bigger than it is. Skim marks those files as
**Viewed** for you on GitHub. They collapse, and one click hides them from
the file list entirely.

It only changes *your* view of the pull request. Nobody else's review is
affected, nothing is committed, and it undoes cleanly.

## Install

You need the [GitHub CLI](https://cli.github.com), logged in with `gh auth login`.

```sh
gh extension install Accordy/gh-skim
```

Runs on macOS, Apple silicon and Intel. To update later:

```sh
gh extension upgrade skim
```

## Use

Point it at a pull request:

```sh
gh skim https://github.com/owner/repo/pull/123
```

```
owner/repo#123: 22 files changed. presets node (detected), .github/review-ignore from this branch
      7  .github/review-ignore: **/__tests__/**
      1  .github/review-ignore: **/*.spec.ts
8 matched, 14 left to review
marked 8 file(s) viewed in 1.4s
hide them in the browser: https://github.com/owner/repo/pull/123/files?show-viewed-files=false
```

Open the pull request and the matched files are collapsed with a tick. Open the
link it prints, or untick **Viewed files** in the file filter menu, and they
leave the list altogether.

| Command | What it does |
|---|---|
| `gh skim <pr>` | Mark the noise files as viewed |
| `gh skim <pr> --dry-run` | Show what it would hide, change nothing |
| `gh skim <pr> --undo` | Put back everything it marked on that pull request |
| `gh skim <pr> --verbose` | List every hidden path and the rule that hid it |
| `gh skim 123 -R owner/repo` | Use a bare number instead of a URL |

`<pr>` can be a URL, `owner/repo#123`, or a number when you're inside a clone.

## Do it automatically

`watch` finds every open pull request where your review is requested and
filters each one, then checks again every five minutes. By the time you open a
review it's already done.

```sh
gh skim watch            # keep running, poll every 5 minutes
gh skim watch --once     # one pass, then exit
gh skim watch --dry-run  # show what it would do
```

For filtering on every pull request with nothing running on your machine, there
is a hosted [Skim GitHub App](https://skim.accordy.io) built on the same
engine.

## Rules

What counts as noise is decided by rules in gitignore syntax. They come from
four places, and a later one overrides an earlier one:

1. **A built-in preset**, picked from the repository's languages.
2. **`linguist-generated` entries** in the repository's `.gitattributes`.
3. **`.github/review-ignore`** in the pull request's own branch. This is the
   one to commit, so the whole team shares the same rules.
4. **Your personal rules** at `~/.config/gh-skim/rules/<owner>/<repo>`,
   if that file exists. Use it to try rules before committing them, or on a
   repository that doesn't have a `review-ignore` yet. `--rules FILE` points at
   a different file for one run.

With no configuration at all, the preset still applies, so most repositories
get something useful immediately.

### Writing a review-ignore

Plain gitignore syntax. `!` un-hides something an earlier rule hid. An optional
comment on the **first line** picks presets instead of detecting them:

```gitignore
# preset: node

**/__tests__/**
**/*.test.ts
**/*.spec.ts

infra/generated/**
```

Write `# preset: none` to start from nothing and list everything yourself.

**One gitignore rule to know.** Git never un-hides a file whose folder is
hidden. So if you want to hide a folder's code but keep something inside it
visible, hide by file type rather than by folder:

```gitignore
# Hides the generated clients but keeps their hand-written config reviewable.
api/generated/**/*.ts
!api/generated/**/config.ts
```

Writing `api/generated/**` instead would hide the folders too, and the `!` line
would do nothing.

### Built-in presets

| Preset | Hides |
|---|---|
| `swift` | snapshot folders, `Package.resolved`, `Podfile.lock`, `Cartfile.resolved`, generated Swift, `Generated/` folders, `xcuserdata` |
| `node` | npm, yarn, pnpm and bun lock files, `dist/`, `build/`, `.next/`, `coverage/`, generated files, Jest snapshots |
| `go` | `go.sum`, `vendor/`, generated protobuf and gRPC code, generated mocks, `zz_generated` files |
| `python` | Poetry, Pipenv and uv lock files, generated protobuf code, `__pycache__` |
| `jvm` | Gradle wrapper jar and scripts, Gradle lock and verification files, `build/`, `target/` |
| `ruby` | `Gemfile.lock`, vendored gems, Tapioca-generated RBI files |
| `rust` | `Cargo.lock`, `vendor/`, `target/` |
| `dotnet` | `packages.lock.json`, `*.Designer.cs`, `*.g.cs`, `obj/` |

The preset files are in [`packages/rules/presets/`](packages/rules/presets). If one misses something obvious
for your stack, a pull request against it helps everyone using that language.

## What it never does

- **It never touches a file that has review comments on it.** A discussion
  means somebody thinks it matters.
- **It never touches a file you already marked viewed.** Those are yours.
- **Undo only reverses its own marks.** Every mark is recorded in
  `~/.config/gh-skim/<owner>/<repo>/<pr>.json`, and `--undo` unmarks
  exactly those, if they are still viewed.

When a file changes after being marked, GitHub resets it to unviewed. Running
the tool again marks it again.

## How it works

It uses GitHub's `markFileAsViewed` API with your own GitHub CLI token, so
the marks are yours, exactly as if you'd clicked each tick. It sends them in
batches, checks every mark in a batch individually, and reads the state back
when GitHub reports an error, because GitHub sometimes reports a failure for a
mark it actually applied. A 1,800-file pull request takes about two minutes.

## Development

Needs [Bun](https://bun.sh).

```sh
bun install
bun test
bun run build        # builds dist/ and a local ./gh-skim for testing
gh extension install ./gh-skim
```

The repository is one Bun workspace. Each package depends only on the ones
above it:

| Package | What it is |
|---|---|
| [`packages/rules`](packages/rules) | What counts as noise: gitignore matching, the presets, `linguist-generated`, `review-ignore`. Pure: text and paths in, decisions out, no network or files |
| [`packages/github`](packages/github) | The GitHub API: pull request files and viewed state, config files, marking with batching, verification and retries. Knows nothing about rules |
| [`packages/engine`](packages/engine) | The flow: load rules for a pull request, plan, mark, reconcile what GitHub reported, record, undo. Where marks are recorded is passed in |
| [`packages/cli`](packages/cli) | `gh skim`. Records marks in `~/.config/gh-skim` |

To release, build and attach both binaries. `gh` looks for exactly these names:

```sh
bun run build
gh release create vX.Y.Z dist/gh-skim-darwin-arm64 dist/gh-skim-darwin-amd64
```

## Contributing

Presets are the easiest place to help: if one misses something obvious for
your stack, or your stack has none, see [CONTRIBUTING.md](CONTRIBUTING.md).
Security issues go through [SECURITY.md](SECURITY.md), not public issues.

## License

[MIT](LICENSE). The Skim name and logo are not covered by the license.
