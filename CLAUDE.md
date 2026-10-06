# gh-skim

`gh skim`: a gh extension that marks noise files in a pull request as viewed.
Public repo; the private hosted App (`Accordy/skim-app`) pins it as a submodule.

## Commands

```sh
bun install
bun test
bun run typecheck
bun run format       # Biome; CI runs format:check, typecheck and test
bun run build        # dist/ binaries (macOS + Linux) + ./gh-skim for local install
```

## Layout

Each package depends only on the ones above it.

- `packages/rules`: gitignore matching, presets, `linguist-generated`, `review-ignore`. Pure: no network, no file system.
- `packages/github`: GraphQL/REST client. Knows nothing about rules.
- `packages/engine`: load rules, plan, mark, reconcile, undo. Mark storage is the caller's `MarkStore`.
- `packages/cli`: the `gh skim` command; ledger in `~/.config/gh-skim/`.

The App uses `rules`, `github` and `engine`; changing their exports breaks it.

## Invariants

- Batches stay under GitHub's 76-alias cap (`BATCH_SIZE` 50), and every
  response's `errors[]` is read per alias, since overflow still returns HTTP 200.
- Reported mark failures are re-read before retrying: GitHub sometimes applies a mark it reports as failed.
- Never touch a file with a review thread or one the reviewer already marked viewed.
- CODEOWNERS is read from the base branch, never the head. A reviewer who owns
  none of the changed files gets nothing hidden by owner.
- Undo only reverses what the ledger recorded.
- Precedence, lowest first: presets, `linguist-generated`, `.github/review-ignore`, personal rules.
- Preset directory patterns use `dir/**`, never `dir/`, or `!` cannot re-include files.
- Comments describing behaviour measured against the real API stay with that code.
