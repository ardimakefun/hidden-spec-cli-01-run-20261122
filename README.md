[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ardimakefun/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ardimakefun/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

A Node 22 command-line tool (stdlib only) that applies AI-written edits in four
formats — unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls —
to a tree of text files, per `SPEC.md`. It finds the named lines even when
whitespace or indentation drifted, and changes all files or none (atomic).

Built by an AI agent for make.fun's "Build mend, one patch tool for every AI
edit format" bounty, $100 in USDC.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH absent or `-` reads stdin. Formats: `unified`, `search-replace`, `v4a`,
`json`, `auto` (default). `--check` dry-runs, `--strict` matches exactly.
See `SPEC.md` for the full specification.
