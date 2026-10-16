# Skim

Marks lock files, generated code and build output in a pull request as
**Viewed**, so GitHub collapses them and you review only what matters. Only
your view changes, and it can be undone.

To do this on every pull request for your whole team, install the
[Skim GitHub App](https://skim.accordy.io). This repository is the command line
tool.

## Install

Needs the [GitHub CLI](https://cli.github.com), logged in with `gh auth login`.
macOS and Linux.

```sh
gh extension install Accordy/gh-skim
gh extension upgrade skim    # to update
```

## Use

```sh
gh skim https://github.com/owner/repo/pull/123
```

| Command | Does |
|---|---|
| `gh skim <pr>` | Mark noise files viewed |
| `gh skim <pr> --dry-run` | Show what it would mark |
| `gh skim <pr> --undo` | Unmark what it marked |
| `gh skim <pr> --verbose` | List each path and the rule that matched it |
| `gh skim <pr> --mine` | Also mark files CODEOWNERS gives to others |
| `gh skim <pr> --preset node,go` | Use these presets instead of detecting them |
| `gh skim watch` | Run on every pull request awaiting your review, every 5 minutes (`--once`, `--interval 15`) |

`<pr>` is a URL, `owner/repo#123`, or a number inside a clone (or with `-R owner/repo`).

Files with review comments, and files you marked yourself, are never touched.

## Rules

Gitignore syntax. Later sources override earlier ones:

1. A built-in preset for the repository's languages: `node`, `go`, `python`,
   `swift`, `jvm`, `ruby`, `rust`, `dotnet` ([presets](packages/rules/presets)).
2. `linguist-generated` in `.gitattributes`.
3. `.github/review-ignore` in the pull request's branch, shared by the team.
4. Your own rules in `~/.config/gh-skim/rules/<owner>/<repo>`, or `--rules FILE`.

```gitignore
# preset: node
# codeowners: on

**/__tests__/**
api/generated/**/*.ts
!api/generated/**/config.ts
```

- `# preset:` on the first line picks presets; `none` turns them off.
- `# codeowners: on` does `--mine` for everyone. CODEOWNERS is read from the
  base branch; files nobody owns stay visible.
- `!` can't bring back a file whose folder is hidden, so hide by file type
  (`dir/**/*.ts`), not by folder (`dir/**`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The Skim name and logo are not covered.
