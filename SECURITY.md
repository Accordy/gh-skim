# Security

`gh skim` runs with your GitHub token and changes the viewed state of files in
pull requests, so security reports are taken seriously.

Please **don't open a public issue**. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/Accordy/gh-skim/security/advisories/new)
for this repository. Include what you found, how to reproduce it, and what an
attacker could do with it.

You'll get a reply within a few days. Fixes are released as a new version of
the extension, and credited if you want.

## What the tool does with your token

It reads the token from `GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`, sends it
only to `api.github.com`, and never stores it. The only things it writes are the
records of what it marked, under `~/.config/gh-skim/`.
