# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Presets

The most useful contribution is a better preset. Each one is a plain gitignore
file in [`packages/rules/presets/`](packages/rules/presets).

- **Only hide files nobody reviews line by line**: lock files, generated code,
  build output, vendored dependencies, recorded test baselines. If a reviewer
  would ever want to read it, leave it out.
- **Say why** in a comment above each group of patterns.
- **A new language** also needs an entry in `LANGUAGE_TO_PRESET` and
  `BUILT_IN` in [`packages/rules/src/presets.ts`](packages/rules/src/presets.ts),
  using GitHub's linguist names for the languages.
- **Add a test** in `packages/rules/src/presets.test.ts`: a path the preset
  should hide, and one it must not.

## Code

```sh
bun install
bun test
bun run typecheck
bun run format
```

CI runs the tests, the typecheck and `bun run format:check` on every pull request.

`packages/rules` stays pure: no network, no file system. Anything that talks to
GitHub goes in `packages/github`, and the flow that combines them in
`packages/engine`. Behaviour measured against the real GitHub API is documented
where it is handled; keep those comments when changing that code.

## Reporting a bug

Include the command you ran, its output with `--verbose`, and the
`.github/review-ignore` involved, if any. For anything security related, see
[SECURITY.md](SECURITY.md) instead.
