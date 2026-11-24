# harness-bench

[English](README.md) · 한국어

[![ci](https://github.com/developjik/harness-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/harness-bench/actions/workflows/ci.yml)

> **npm:** 스코프 패키지로 설치하세요 — `npm i @developjik/harness-bench`. 스코프 없는 `harness-bench`는 다른 프로젝트입니다.

**내 리포 × 내 하네스.** 공개 벤치마크의 과제는 남의 코드입니다. harness-bench는 **내 git 히스토리**에서
벤치마크 과제를 캐냅니다. 구현 파일과 테스트 파일을 함께 바꾼 커밋이 곧 하나의 과제가 됩니다.
하네스는 그 변경 **직전** 체크아웃에 테스트 hunk만 적용된 상태를 받고, 격리된 `git worktree` 안에서
테스트를 통과시켜야 합니다.

- **내 스택 그대로.** 내 테스트 러너, 내 컨벤션, 내 모노레포 구조.
- **오염 없는 베이스.** 베이스 커밋은 채굴한 커밋의 부모입니다. 구현은 빠지고 테스트만 남습니다.
- **내 의존성 그대로.** 설치된 `node_modules` / `.venv`를 worktree에 심볼릭 링크해 리포의 테스트 명령을
  그대로 돌립니다.
- **하네스끼리 비교.** `claude-code`, `codex`, `opencode`, `damon` + `mock` 드라이버.
- **토큰 0원 데모.** `npm run demo`로 파이프라인 전체를 무료로 검증합니다.

## 동작 방식

```
git 히스토리 ─mine─▶ 과제 ─┬─ git worktree @ 부모 커밋 + 테스트 hunk만
                             ├─ 베이스라인 테스트 (새 테스트는 실패)
                             ├─ 하네스 실행: claude-code / codex / opencode / damon / mock
                             └─ 패치 + 테스트 ─score─▶ 점수 매트릭스 + 정적 HTML
```

과제에는 베이스 커밋, 테스트 전용 패치, 참조 구현 패치, 프롬프트(커밋 메시지 + 규칙), 테스트 명령,
골드 diff 통계가 저장됩니다.

## 설치

```sh
git clone https://github.com/developjik/harness-bench
cd harness-bench
npm ci
npm run build
npm link            # 선택: `harness-bench`를 PATH에 등록
```

Node.js 20 이상. 네이티브 의존성은 `better-sqlite3` 하나뿐이며(prebuilt 바이너리 사용) 싫다면
`--store jsonl`로 피할 수 있습니다.

## 60초 데모 (토큰 0원, 네트워크 불필요)

```sh
npm run demo
```

`os.tmpdir()`에 구현+테스트 커밋 2개가 있는 임시 리포를 만들고, 채굴 → mock 하네스 실행 → 매트릭스
출력 → `reports/demo.html` 생성까지 수행합니다.

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

## 내 리포에 바로 쓰기

```sh
cd ~/code/my-app

harness-bench mine --repo . --limit 300      # 히스토리 스캔, ./.harness-bench에 과제 저장
harness-bench list                           # 채굴된 과제와 건너뛴 이유
harness-bench run --repo . --driver mock --dry-run   # 토큰 없이 파이프라인 점검
harness-bench run --repo . --driver claude-code --limit 3 --timeout 900
harness-bench report --format html           # reports/harness-bench-<timestamp>.html
```

`mine`은 구현과 함께 테스트를 추가하거나 바꾸는 커밋을 필요로 합니다. 테스트를 별도 리포에 두는 경우
`--repo`를 코드 리포로 지정하고 `--test-cmd`를 넘기세요.

## CLI

| 명령 | 하는 일 |
| --- | --- |
| `mine` | 커밋을 스캔해 과제를 저장. `--repo`, `--limit`, `--max-tasks`, `--since`, `--test-cmd`, `--max-diff-lines`, `--store`, `--dry-run` |
| `run` | 과제 × 드라이버를 worktree에서 실행. `--repo`, `--driver`, `--task`, `--limit`, `--timeout`, `--test-timeout`, `--dry-run`, `--mock-mode`, `--no-baseline`, `--keep-worktree`, `--damon-backend` |
| `report` | `--format table\|html\|json`, `--out`, `--task` |
| `list` | 저장된 과제 목록 |
| `doctor` | 하네스 바이너리가 PATH에 있는지 확인 |

공통: `--json`, `--no-color`, `--data-dir`, `--help`, `--version`.

## 채점

| 항목 | 가중치 | 측정 |
| --- | --- | --- |
| 테스트 해결 | 0.60 | 준비된 베이스에서 실패하던 테스트 중 실행 후 통과한 비율 |
| diff 유사도 | 0.30 | ½ · 참조 구현 패치 대비 파일 F1 + ½ · 변경 줄 Jaccard |
| 회귀 없음 | 0.10 | 베이스에서 통과하던 테스트가 실행 후에도 통과 |

기준점: 아무것도 바꾸지 않은 하네스 **0.10**, 다르게 구현해 테스트를 통과시키면 **약 0.70**, 원래
패치에 가까우면 **1.00**. diff 점수는 의도적으로 부차적입니다. 다르지만 올바른 구현도 통과이고,
점수는 "레퍼런스에서 얼마나 벗어났는지"를 보여줄 뿐 허용 여부를 판정하지 않습니다.

실행마다 하네스 종료 코드, 소요 시간, 건드린 파일 수, 추가/삭제 줄 수, 베이스라인 테스트 수, 테스트
이름 단위 회귀, 하네스가 테스트 파일을 수정했는지까지 기록합니다(테스트를 고치는 하네스는 의심 대상
이며 리포트에 표시됩니다).

## 드라이버

| id | 바이너리 | 실행 형태 | 환경변수 |
| --- | --- | --- | --- |
| `claude-code` | `claude` | `claude -p <prompt> --output-format text --permission-mode acceptEdits` | `HARNESS_CLAUDE_CMD` |
| `codex` | `codex` | `codex exec --full-auto --color never <prompt>` | `HARNESS_CODEX_CMD` |
| `opencode` | `opencode` | `opencode run <prompt>` | `HARNESS_OPENCODE_CMD` |
| `damon` | `damon` | `damon prompt <prompt> --backend <id>` | `HARNESS_DAMON_CMD`, `HARNESS_DAMON_BACKEND` |
| `mock` | — | `oracle` / `partial` / `noop` (골드 diff 기반) | — |

`--driver`는 콤마로 여러 개를 받습니다. 실제 하네스는 CLI가 설치·로그인돼 있어야 하고, 환경변수로
비표준 위치의 바이너리를 지정할 수 있습니다. `run --dry-run`은 mock으로 대체하고 실행했을 명령줄을
로그에 남깁니다.

### 검증된 하네스

실제 하네스를 이용한 종단 간 실행(작은 `node --test` 리포에서 채굴한 과제 1개 × 드라이버 1개):

| 하네스 | 버전 | 백엔드 | 환경 | 검증일 | 결과 |
| --- | --- | --- | --- | --- | --- |
| `damon` (+ `damond`) | 0.8.0 | `omp` 19.1.0 | macOS 27.0.1 arm64, Node 25 | 2026-11-22 | 베이스라인 0/1 → 최종 2/2, 점수 0.96 |

재현:

```sh
damond &            # 드라이버는 `damon prompt`를 셸로 실행합니다
harness-bench mine --repo <small-repo> --data-dir /tmp/hb-e2e --store jsonl
harness-bench run --repo <small-repo> --data-dir /tmp/hb-e2e --store jsonl \
    --driver damon --damon-backend omp
harness-bench report --data-dir /tmp/hb-e2e --store jsonl --format html
```

하네스가 worktree 안에서 `git commit`을 해도 실행은 준비 커밋 기준으로 diff를 뽑아 패치에 수집합니다.

### 통합 테스트

`test/integration.test.ts`는 실제 드라이버 경로를 종단으로 검증합니다. 옵트인 방식 — CI는 플래그를
설정하지 않으므로 `npm test`에서 건너뜁니다:

```sh
HARNESS_BENCH_INTEGRATION=1 HARNESS_DAMON_BACKEND=omp npm test
# 다른 하네스:
HARNESS_BENCH_INTEGRATION=1 HARNESS_BENCH_INTEGRATION_DRIVER=opencode npm test
```

### 드라이버 추가

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

`src/drivers/index.ts`에 등록하고 `ALL_DRIVER_IDS`에 id를 추가하면 됩니다. 처음부터 구현하려면
`HarnessDriver`(`commandLine`, `available`, `run`)를 구현해 종료 코드·출력·소요 시간·타임아웃 여부를
돌려주면 됩니다.

## damon-agent-core 연동

[Damon](https://github.com/developjik/damon-agent-core)은 9종 코딩 에이전트 CLI를 네이티브 프로토콜로
구동하는 로컬 데몬입니다. `damon` 드라이버는 과제 worktree에서 Damon의 원샷 프롬프트를 호출합니다.

```sh
damon prompt "<과제 프롬프트>" --backend claude
```

- 백엔드는 `--damon-backend`(또는 `HARNESS_DAMON_BACKEND`)로 선택하며 기본값은 `claude`입니다.
- Damon은 비밀을 보관하지 않습니다. 백엔드 CLI가 미리 설치·로그인돼 있어야 합니다.
- Damon이 세션과 히스토리를 남기므로 하네스 실행 하나가 곧 Damon 세션 하나입니다. `damon sessions`,
  `damon search "<task id>"`로 에이전트가 한 일을, `harness-bench`가 `.harness-bench/logs/`에 남기는 실행 로그와
  나란히 볼 수 있습니다.
- Damon의 worktree 기능(`damon worktree create . --pr 123`)은 *PR 작업*을 격리하고, harness-bench는
  *벤치마크 체크아웃*을 격리합니다. 서로 보완적입니다.

## 데이터 위치

```
.harness-bench/
  tasks.db            # --store jsonl이면 tasks.jsonl
  results.jsonl       # 과제×드라이버별 결과, 재실행 시 해당 줄 교체
  logs/<run>.log      # 하네스 출력·패치·테스트 출력
  worktrees/<run>/    # --keep-worktree가 아니면 실행 후 제거
```

## 한계

- **테스트가 유일한 오라클입니다.** 테스트가 틀렸거나 나중에 다시 쓰인 커밋은 노이즈 과제가 됩니다.
  `mine`은 명백한 노이즈(락파일, 문서, 테스트 삭제, 과대 diff)를 거르지만 의도까지 판단하지 못합니다.
- **표본이 작으면 노이즈가 큽니다.** 과제×하네스 1회는 품질보다 LLM 분산을 보여줍니다. 최소 10개
  과제, 여러 회 반복 후 중앙값으로 판단하세요.
- **테스트 명령은 리포 루트 기준입니다.** 모노레포는 `--test-cmd "pnpm -w test"`나 패키지 범위 명령을 넘기세요.
- **의존성은 설치가 아니라 링크입니다.** `node_modules`·`.venv`를 소스 체크아웃에서 worktree로
  심볼릭 링크합니다(`--no-link-deps`로 끔). `package.json` 의존성을 바꾸는 과제는 하네스가 직접 설치해야
  합니다.
- **플래키 테스트에 약합니다.** 베이스라인에서 이미 실패한 테스트를 기록하고, 회귀는 초록 스위트가
  아니라 그 베이스라인과 비교합니다.
- **테스트를 수정하는 하네스는 표시만 됩니다.** 막지는 않습니다. 리포트가 건드린 테스트 파일을 모두
  나열합니다.
- **비용 집계는 없습니다.** 하네스마다 과금 방식이 다릅니다. 시간과 행동을 재고 돈은 재지 않습니다.
- **리더보드가 아닙니다.** *내* 히스토리로 *내* 하네스를 비교하는 도구이며, 리포 간 결과는 비교할 수
  없습니다.

## 라이선스

MIT © Jeong Ingwon (developjik)

### Regression identity checks (DEV-132)

회귀 비교는 같은 테스트 명령과 러너의 완전한 테스트 ID를 우선합니다. Vitest의 파일+테스트 경로와 pytest node ID를 지원합니다. 파일 오류, 다른 러너, 잘린 출력, 미지원 러너 또는 과거 기록처럼 ID가 불완전하면 실패 수가 같거나 줄어도 `unknown`으로 표시하며 회귀 없음 점수 0.1을 주지 않습니다. 실패 수 증가의 집계 fallback은 유지합니다. 새 실행부터 적용되며 CLI report는 기존 저장 점수를 다시 계산하지 않습니다. 개발용 rescore API는 저장된 메타데이터로 재계산할 수 있습니다.

기존 파서가 누락하거나 자른 ID는 rescore로 복원되지 않으며 새 실행이 필요합니다.
