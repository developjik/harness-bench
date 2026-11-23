# Changelog

## 0.1.1 — 2026-11-22

### Fixed
- `cargo test` output now sums every `test result:` summary across a workspace — unit tests, integration tests and doc-tests are distinct suites counted once each — instead of reading only the first one, so failures in later crates reach the score (DEV-45).
- A failing test-command exit code with zero recorded failures now marks the run `countsUncertain` and earns no test credit instead of reading a partial suite as a clean pass; the report shows the test label as `passed/total?` (DEV-45).
- Runs now collect the worktree patch against the prepared base commit, so work a harness commits itself is scored instead of producing an empty diff (DEV-24).

### Added
- Opt-in integration test `test/integration.test.ts` for real harness runs (`HARNESS_BENCH_INTEGRATION=1`; driver via `HARNESS_BENCH_INTEGRATION_DRIVER`, damon backend via `HARNESS_DAMON_BACKEND`); CI skips it (DEV-24).
- Failure-path tests for cli drivers and `spawnProcess` (missing binary, timeout, failing test command) (DEV-24).
- "Verified harnesses" table and reproduction steps in the README (DEV-24), and an npm install warning for the `@developjik/harness-bench` scope (DEV-36).
- `--help` example now runs `npx -y @developjik/harness-bench` instead of the unscoped name, which resolves to a different npm package (DEV-36).
