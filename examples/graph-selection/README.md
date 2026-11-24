# Graph-weighted selection experiment (DEV-71)

This is an offline selection PoC, not a harness benchmark. It runs no model, test command, or paid service. `select` does not change task stores or the existing `mine` and `run` defaults.

## Observed result, including the negative result

The pinned sqlite-graph-mcp checkout supplied six eligible implementation+test commits using the normal miner defaults (`limit=200`, `maxTasks=25`, `maxDiffLines=1200`). Both methods selected three tasks from that exact pool. The baseline is the existing newest-first order. The experimental method uses seed 42.

| Metric | Existing order | Weighted selection | Weighted minus baseline |
| --- | ---: | ---: | ---: |
| Distinct parent-directory modules | 3 | 2 | -1 |
| Mean pairwise implementation-file Jaccard | 0.111111 | 0.355556 | +0.244444 |

The experimental selection was worse on both descriptive proxies in this run. No reduction in selection bias was demonstrated. A seed is not a replication across repositories, and directory coverage is not task quality. There is no claim about real harness performance. DEV-24 real-driver acceptance remains separate.

`experiment.json` includes the full graph snapshot, producer commit/engine, graph SHA-256, candidate SHA-256, IDs, reference commits, per-file degree/change counts, each draw's weight/probability and both distributions. Zero-degree and missing files differ: missing graph paths have `degree: null`.

## Reproduce from clean checkouts

Use Node 22.12+ for development; the built selection CLI also runs on Node 20.19. Install the normal repository dependencies. Use a trusted sqlite-graph-mcp checkout: the exporter explicitly imports its built JavaScript. It never executes a binary named in snapshot JSON.

```sh
npm ci
npm run build
# Keep this directory basename, since existing miner IDs include the repo basename.
git clone https://github.com/developjik/sqlite-graph-mcp.git /tmp/sqlite-graph-71
git -C /tmp/sqlite-graph-71 checkout 62335697d412dcdf6cbb41567e1e37bc224212d6
(cd /tmp/sqlite-graph-71 && npm ci && npm run build)
node scripts/export-selection-graph.mjs /tmp/sqlite-graph-71 /tmp/sqlite-graph-71 /tmp/selection-graph.json
node dist/bin/cli.js select --repo /tmp/sqlite-graph-71 --graph-snapshot /tmp/selection-graph.json --count 3 --seed 42 --out /tmp/selection-result.json
node scripts/check-selection-replay.mjs /tmp/selection-result.json
```

Outputs must not already exist. `--out` uses exclusive create to avoid overwriting source files or the graph snapshot. Both checkout trees must be clean. The exporter indexes into a throwaway database, not the user's existing graph, and removes only that temporary directory afterward. No network is used by selection/export; clone/install above require network.

The CI job builds the pinned graph producer, exports it and checks the exact report against `experiment.json`. To use another repository, keep its graph snapshot and comparison report together; choose `--count` no greater than the eligible candidate pool. A sparse candidate pool is an error, not a silently smaller comparison. Add `--test-cmd` if the miner cannot infer metadata, but no command is executed by `select`.

## Method and limits

- Collapse sqlite-graph-mcp edges between distinct file paths into unique, undirected edges. File degree counts neighbors across those relationships, not symbol count. Self-edges are excluded.
- Candidate change frequency counts how many fixed-pool tasks touch each implementation file, not every git commit.
- Base task weight is `1 + mean(log1p(degree) + log1p(candidateChanges))`. Missing degree contributes zero but is explicitly unknown in the evidence.
- Sequential weighted sampling is without replacement. Divide weight by `1 + max(previous selections touching each module)` to discourage repeated modules. The PRNG is the versioned Mulberry32 implementation, uint32 seed, with input order preserved.
- Baseline remains `tasks.slice(0, count)`. The seed is recorded for the comparison but does not randomize the existing baseline.
- Modules are POSIX parent directories. Multi-module tasks count once in each module; module counts therefore need not sum to selected task count. Duplicate-file overlap is mean pairwise set Jaccard, zero when fewer than two tasks are selected.
- This HEAD graph is an intentional approximation for historical commits, not a graph reconstructed at every task's base. All file blob IDs are checked against the declared HEAD. Historical/deleted paths can be missing, and graph parser limitations remain.
- Producer metadata is not a signature. Use the included exporter on trusted code; an attacker can manufacture a structurally valid graph. The snapshot deliberately contains paths/edges/blob IDs, not source snippets, prompts, secrets or absolute local paths. Review repository filenames before sharing it.
- No score weights, regression aggregation, runtime drivers, required gates or package publication change.
