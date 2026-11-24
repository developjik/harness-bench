# harness-bench

[한국어](README.ko.md) · English

[![ci](https://github.com/developjik/harness-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/harness-bench/actions/workflows/ci.yml)

> **npm:** install the scoped package — `npm i @developjik/harness-bench`. The unscoped `harness-bench` on npm is a different project.

**My repo × my harness.** Benchmark coding-agent harnesses on the repository you actually work in.

Public coding-agent benchmarks are saturating, and the tasks are somebody else's code. `harness-bench`
mines benchmark cases out of your own git history: every commit that changed implementation files and
test files together becomes a task. A harness gets the checkout from *right before* that change, with
only the test hunks applied, and has to make the tests pass inside an isolated `git worktree`.

- **Your stack, not a synthetic toy.** Your test runner, your conventions, your flaky test, your monorepo.
- **Contamination-free base.** The base commit is the parent of the mined commit; the implementation is removed, the tests stay.
- **Your dependencies.** Installed `node_modules` / `.venv` are symlinked into the worktree, so the repository's own test command runs unchanged.
- **Harness vs harness.** `claude-code`, `codex`, `opencode`, `damon`, plus a mock driver, behind one adapter interface.
- **Zero-token demo.** `npm run demo` proves the whole pipeline without spending a cent.

## How it works

```
git history ─mine─▶ task ─┬─ git worktree @ parent commit + test hunks only
                          ├─ baseline test run  (the new tests fail)
                          ├─ harness: claude-code / codex / opencode / damon / mock
                          └─ patch + tests ─score─▶ score matrix + static HTML
```

A mined task stores the base commit, the test-only patch, the reference implementation patch, the
prompt (the commit message plus the rules), the test command and the gold diff statistics.

## Install

```sh
git clone https://github.com/developjik/harness-bench
cd harness-bench
nvm install
nvm use
npm ci
npm run build
npm link            # optional, puts `harness-bench` on PATH
```

Published runtime: Node.js 20 or newer. Source development: Node.js22.12.0 via `nvm use`. The only native dependency is `better-sqlite3` (prebuilt binaries are used);
pass `--store jsonl` if you would rather not have it.

## 60-second demo (no tokens, no network)

```sh
npm run demo
```

Creates a throwaway repository in `os.tmpdir()` with two real implementation+test commits, mines it,
runs the mock harnesses, prints the matrix and writes `reports/demo.html`.

```
MATRIX
task                                mock:oracle  mock:noop
harness-bench-demo-…-83fa2757       1.00 ✓ 1/1   0.10 ✗ 0/1
harness-bench-demo-…-69f0d595       1.00 ✓ 2/2   0.10 ✗ 0/2

DRIVER SUMMARY
driver            runs   mean  pass@1   median  files   diff  errors
mock:oracle          2   1.00    100%      4ms    1.0   1.00       0
mock:noop            2   0.10      0%      0ms    0.0   0.00       0
```

## Quickstart on your own repository

```sh
cd ~/code/my-app

harness-bench mine --repo . --limit 300      # scan history, store tasks in ./.harness-bench
harness-bench list                           # what got mined, and what was skipped
harness-bench run --repo . --driver mock --dry-run   # end-to-end pipeline check, no tokens
harness-bench run --repo . --driver claude-code --limit 3 --timeout 900
harness-bench report --format html           # reports/harness-bench-<timestamp>.html
```

`mine` needs commits that add or change tests together with implementation. If your repository keeps
tests in a separate repository, point `--repo` at the code repository and pass `--test-cmd`.

## CLI

| Command | What it does |
| --- | --- |
| `mine` | Scans commits, writes tasks. Flags: `--repo`, `--limit`, `--max-tasks`, `--since`, `--test-cmd`, `--max-diff-lines`, `--store`, `--dry-run` |
| `run` | Runs tasks × drivers in worktrees. Flags: `--repo`, `--driver`, `--task`, `--limit`, `--timeout`, `--test-timeout`, `--dry-run`, `--mock-mode`, `--no-baseline`, `--keep-worktree`, `--damon-backend` |
| `report` | `--format table\|html\|json`, `--out`, `--task` |
| `list` | Lists stored tasks |
| `doctor` | Shows which harness binaries are on PATH |

Global: `--json`, `--no-color`, `--data-dir`, `--help`, `--version`.

## Scoring

| Component | Weight | Measure |
| --- | --- | --- |
| Tests solved | 0.60 | Share of the tests that fail on the prepared base and pass after the run |
| Diff similarity | 0.30 | ½ · file F1 against the reference impl patch + ½ · Jaccard of changed lines |
| No regression | 0.10 | No test that passed on the base fails after the run |

Reference points: a harness that changes nothing scores **0.10**; one that makes the tests pass with a
different implementation scores around **0.70**; one that lands close to the original patch scores
**1.00**. The diff component is deliberately secondary: a different but correct implementation is still
a pass, and the score shows how far it drifted from the reference, not whether it was allowed.

Every run also records the harness exit code, wall-clock time, files touched, lines added/removed, the
baseline test counts, regressions by test name, and whether the harness edited test files (a harness
that rewrites the tests is suspect, and the report flags it).

## Drivers

| id | Binary | Invocation | Env override |
| --- | --- | --- | --- |
| `claude-code` | `claude` | `claude -p <prompt> --output-format text --permission-mode acceptEdits` | `HARNESS_CLAUDE_CMD` |
| `codex` | `codex` | `codex exec --full-auto --color never <prompt>` | `HARNESS_CODEX_CMD` |
| `opencode` | `opencode` | `opencode run <prompt>` | `HARNESS_OPENCODE_CMD` |
| `damon` | `damon` | `damon prompt <prompt> --backend <id>` | `HARNESS_DAMON_CMD`, `HARNESS_DAMON_BACKEND` |
| `mock` | — | `oracle` / `partial` / `noop` patches derived from the gold diff | — |

`--driver` takes a comma-separated list. Real harnesses need their CLI installed and logged in; the
env override points at a binary in a non-standard location. `run --dry-run` substitutes the mock driver
and logs the command line that would have been executed.

### Verified harnesses

End-to-end runs against a real harness (one task mined from a small `node --test` repository, one
task × one driver):

| harness | version | backend | environment | verified | result |
| --- | --- | --- | --- | --- | --- |
| `damon` (+ `damond`) | 0.8.0 | `omp` 19.1.0 | macOS 27.0.1 arm64, Node 25 | 2026-11-22 | baseline 0/1 → final 2/2, score 0.96 |

Reproduce:

```sh
damond &            # the driver shells out to `damon prompt`
harness-bench mine --repo <small-repo> --data-dir /tmp/hb-e2e --store jsonl
harness-bench run --repo <small-repo> --data-dir /tmp/hb-e2e --store jsonl \
    --driver damon --damon-backend omp
harness-bench report --data-dir /tmp/hb-e2e --store jsonl --format html
```

A harness may `git commit` inside the worktree — the run diffs the prepared base commit, so committed
work is still collected into the patch.

### Integration tests

`test/integration.test.ts` exercises the real driver path end to end. It is opt-in only — CI never
sets the flag, so `npm test` skips it:

```sh
HARNESS_BENCH_INTEGRATION=1 HARNESS_DAMON_BACKEND=omp npm test
# a different harness:
HARNESS_BENCH_INTEGRATION=1 HARNESS_BENCH_INTEGRATION_DRIVER=opencode npm test
```

### Adding a driver

```ts
import { createCliDriver } from 'harness-bench/dist/src/drivers/cli.js';

export const myHarness = createCliDriver({
  id: 'my-harness',
  label: 'My Harness',
  binary: 'my-harness',
  envVar: 'HARNESS_MY_CMD',
  example: 'my-harness --prompt "<prompt>"',
  args: (ctx) => ['--prompt', ctx.prompt, '--cwd', ctx.cwd],
});
```

Register it in `src/drivers/index.ts` and add the id to `ALL_DRIVER_IDS`. A driver can also be written
from scratch: implement `HarnessDriver` (`commandLine`, `available`, `run`) and return exit code,
stdout/stderr, wall-clock time and a timeout flag.

## damon-agent-core integration

[Damon](https://github.com/developjik/damon-agent-core) is a local agent-control daemon that drives nine
coding-agent CLIs over their native protocols. The `damon` driver calls Damon's one-shot prompt in the
task worktree:

```sh
damon prompt "<task prompt>" --backend claude
```

- The backend is chosen with `--damon-backend` (or `HARNESS_DAMON_BACKEND`), default `claude`.
- Damon holds no secrets: the backend CLI must already be installed and logged in.
- Because Damon keeps sessions and history, every harness run is also a Damon session — `damon sessions`
  and `damon search "<task id>"` let you inspect what the agent did, next to the run log that
  `harness-bench` keeps in `.harness-bench/logs/`.
- Damon's own worktree support (`damon worktree create . --pr 123`) is complementary: harness-bench
  isolates the *benchmark* checkout, Damon isolates *your* PR work.

## Data layout

```
.harness-bench/
  tasks.db            # or tasks.jsonl with --store jsonl
  results.jsonl       # run results, one line per task×driver (reruns replace their line)
  logs/<run>.log      # harness output, patch and test output per run
  worktrees/<run>/    # removed after each run unless --keep-worktree
```

## Limitations

- **Tests are the only oracle.** A commit whose tests were wrong, or that was later rewritten, produces
  a noisy task. `mine` filters obvious noise (lockfiles, docs, deletions, oversized diffs) but cannot
  judge intent.
- **Small samples are noisy.** One run per task × harness says more about LLM variance than about
  quality. Use at least ten tasks and repeat runs before drawing conclusions; score with medians, not
  single numbers.
- **Root-level test command.** The inferred command runs at the repository root. Monorepos should pass
  `--test-cmd "pnpm -w test"` or a package-scoped command.
- **Dependencies are symlinked, not installed.** `node_modules` and `.venv` are linked into the worktree
  from the source checkout (`--no-link-deps` turns this off). A harness that changes `package.json`
  dependencies still needs its own install step.
- **Flaky tests hurt.** The baseline run records which tests already fail; regressions are judged against
  that baseline, not against a green suite.
- **Test-editing harnesses are flagged, not blocked.** A harness could weaken assertions; the report
  lists every test file it touched.
- **No cost accounting.** Each harness bills in its own way; harness-bench measures time and behaviour,
  not money.
- **Not a leaderboard.** It mines *your* history for *your* harness comparison. Results are not
  comparable across repositories.

## License

MIT © Jeong Ingwon (developjik)

### Regression identity checks (DEV-132)

Regression checks compare complete test IDs from the same command and runner before counts. Vitest file+case paths and pytest node IDs are supported. File errors, different runners, truncated output, unsupported runners and legacy records without complete IDs report `unknown` even if failure counts stay equal or decrease, earning no 0.1 regression-free credit. Increased failure counts still use the aggregate fallback. New runs use the new assessment. Existing saved scores remain unchanged in the CLI report; the exported rescore API can recalculate them from stored metadata.

Rescore cannot recover IDs truncated or omitted by an older parser. Rerun those tests to collect new identities.

## Development baseline (DEV-128)

Use Node.js 22.12.0 (`.nvmrc`) for development and CI. Vitest 5.1.1 requires Node 22.12+ on its supported release lines; Node 20.19 is outside its declared development support range. It may execute there, but CI does not treat that as supported test-runner usage. This development requirement does not change the package engine declaration. Runtime compatibility must be checked using the built package, separately from the test runner. TypeScript 7.0.2 is the development compiler baseline.
