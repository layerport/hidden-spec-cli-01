# mend — one patch tool for every AI edit format

[![make.fun bounty](https://img.shields.io/badge/make.fun-bounty-7c3aed)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun](https://img.shields.io/badge/make.fun-enter-0ea5e9)](https://make.fun)
[![Node 22](https://img.shields.io/badge/node-22-339933)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for the [make.fun](https://make.fun) bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

Models write edits in four formats: a unified diff (often with wrong line
numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON. `mend` reads all four to one written contract, finds
the lines an edit names even when the model drifted their whitespace or
indentation, and changes every file or none at all.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the root of the tree. `PATCH` defaults to
standard input. `--format` is `auto` (the default), `unified`,
`search-replace`, `v4a` or `json`. `--check` does everything but write.
`--strict` matches lines exactly.

Exit codes: `0` with one line per changed file and `ok: <n> files`;
`1` with one `error: <code> <path>` line per failed edit and
`failed: <k> of <n> edits` (nothing is written); `2` for usage,
missing-patch, undetected-format and parse errors.

## How it works

- **Matching, three tiers.** An old block is found at the first tier
  where it occurs: exact lines, then trailing whitespace ignored, then
  leading and trailing whitespace ignored (with new lines re-indented
  to the file's own indentation at tier 2). Unified hunks take the
  occurrence nearest the (wrong) line number the diff claims.
- **Atomic.** Edits apply in order to the tree as earlier edits left
  it; a failed edit changes nothing, later edits still run, and when
  any edit failed no file is written at all.
- **Safe paths.** Every path an edit names is checked before anything
  else about it; unsafe paths fail the edit instead of escaping the
  tree.

Node 22 and its standard library only — nothing is installed before
the program runs. It is deterministic: the same check gives the same
exit code, stdout and files every run.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's trial runner (kept as the kit has it); when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.

## License

MIT — see [LICENSE](LICENSE).
