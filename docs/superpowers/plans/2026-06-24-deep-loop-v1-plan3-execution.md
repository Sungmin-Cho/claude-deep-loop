# deep-loop v1 — Plan 3: Execution plane (10 스킬) + skill-facing CLI 완성 + PreCompact hook + headless spawn 드라이버 + automation + 문서 + marketplace 등록 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 1(결정론 커널) + Plan 2(오케스트레이션 기계) 위에 deep-loop의 **Execution plane**(10개 LLM-facing 스킬), 스킬이 의존하는 **skill-facing 커널 CLI**(state get/patch · budget record · comprehension ack · breaker reset · finish · adapter resolve), **PreCompact hook 실배선**, **headless `spawnFn` 드라이버**, **automation 템플릿**, **사용자 문서**, **marketplace 등록**(사용자 승인 게이트)을 같은 2-plane 규율로 완성한다.

**Architecture:** 2-plane 엄격 분리(스펙 §1). Execution plane(스킬·SKILL.md)은 상태를 **읽고**(read-only CLI 또는 hash-검증 `state get`), 변경은 **오직 커널 CLI subcommand로만** 한다. 커널은 sibling 스킬을 함수로 호출하지 않는다(§1.1) — `next-action`/`adapter resolve`/`review dispatch`는 *디스크립터를 반환*하고 실제 dispatch는 Execution LLM이 `Skill()`로 수행한다. 유일한 실제 프로세스 spawn 지점은 headless `respawn`의 주입된 `spawnFn`(Plan 3의 `spawn-driver.mjs`) — PreCompact hook glue와 automation 드라이버가 이를 주입한다. 모든 mutating CLI는 lease fence(`--owner --generation`)를 요구하고, fence는 상태를 바꾸는 **그 lock 안에서** 검사된다.

**Tech Stack:** Node >= 20, `type: module`, `node:test` + `node:assert/strict`, 외부 의존성 0. Bash 3.2 호환 hook(`set -Eeuo pipefail`, `declare -A`/`${var,,}` 금지). Plan 1·2 모듈(`state/integrity/budget/breaker/comprehension/schema/envelope/slug/detect/recipes/initrun/lease/workspace/episode/review/adapters/next-action/handoff/respawn`)을 소비.

## Global Constraints

이 섹션은 모든 태스크의 요구사항에 암묵적으로 포함된다.

- Node >= 20, `package.json` `"type": "module"`. **외부 의존성 추가 금지.** (spec §2)
- **2-plane 경계 (spec §1.1, §7-불변식1):** 스킬(SKILL.md)은 상태를 **읽기**만 — `node scripts/deep-loop.mjs state get`/`next-action`/`validate`/`detect-plugins`/`recipe-match`/`adapter resolve` 또는 정적 `protocols/*.json`/`recipes/*.json` 읽기. **변경은 오직 mutating CLI subcommand로만.** SKILL.md가 `loop.json`·`event-log.jsonl`·`.loop.hash`를 직접 쓰는 지침을 포함하면 plan 실패.
- **모든 mutating CLI는 lease fence 필수** (`--owner <run_id> --generation <n>`) — 누락/불일치 시 종료코드 3(`LEASE_FENCED`/`FENCE_REQUIRED`). fence는 상태를 바꾸는 **같은 lock 안에서** 검사한다(Plan 2 트랩 B6: "generation fence는 상태 변경이 일어나는 같은 lock에서"). 새로 CLI에 노출하는 lib(`patch`/`recordCost`/`ack`)는 fence 파라미터를 추가해 lock 내부 `leaseCheck`로 강제한다.
- **`withLock`는 비재진입** — lock을 잡은 콜백 안에서 다시 lock을 잡는 함수(`patch`/`recordCost`/`appendAnchored`/`withLock`/`ack`/`tripBreaker`/`writeState`-via-`withLock` 등)를 호출하지 말 것. (Plan 1 impl review 확립)
- **모든 이벤트+상태 변경은 `integrity.appendAnchored(root, runId, {type, data}, mutate, preCheck?)` 단일 앵커 트랜잭션.** half-commit 금지(Plan 2 트랩 B). `appendEvent`(raw) 직접 호출 금지 — `event_log_head` 앵커가 stale된다. fence/존재성 검증은 `preCheck(loop)`에서(throw해도 앵커 손상 없음), 상태 변경은 `mutate(loop)`에서.
- **터미널 상태는 커널이 proof artifact에서만 파생** — episode `done/approved/rejected`, workstream `ready/merged/abandoned`, review pass. 스킬은 직접 못 씀. checker `approved/rejected`는 `review record` 경유만(`episode record`로 우회 불가). `finish --status completed`는 proof 검증 통과 필수. (spec §4·§15, 트랩 C)
- **state-patch 화이트리스트** — `state.classifyPatch`가 허용하는 비-터미널 경로만(`discovered_items`/`triage.*`/`decisions`/`active_workstreams`/`episodes.<i>.status(non-terminal)`/`episodes.<i>.result_*`/`workstreams.<i>.status(non-terminal)`/`workstreams.<i>.depends_on`). 그 외 default-deny. CLI는 lib `classifyPatch`를 그대로 신뢰(자체 재구현 금지).
- **비가역 외부 행동(push/merge/publish/delete)은 v1에서 전부 proposal-only**, 항상 사람 승인. 어떤 스킬/드라이버/hook도 자동 push/PR/publish/merge/delete를 실행하지 않는다. respawn의 `claude` 세션 spawn은 외부 세계 변경이 아니라 세션 연속(§9 예외)이라 허용. marketplace 등록(Phase E)은 사용자 명시 승인 게이트. (spec §15)
- **respawn은 acting tier로 게이팅하지 않는다.** 게이트 = `budget` → `breaker` → `sessions < max_sessions` → `wallclock < max_wallclock_sec` → `auto_handoff`. (spec §9, `respawn.mjs` 기존 구현)
- **미감시(unattended) 자율은 headless 강제** — `auto_handoff && (non-tty || driver:cron|loop || --unattended)`이면 headless(`claude -p`). headless 드라이버는 timeout + usage 파싱으로 intra-session까지 하드 강제하고 **측정 불가 시 fail-closed(spawn 거부/paused)**. (spec §9 예산 강제, `budget.on_unmeasurable_usage:"fail-closed"`)
- **무결성은 예방이 아니라 탐지+fail-stop**, 협조적-fallible 에이전트 전제. (spec §1.2)
- **project root 밖 쓰기 금지** — deep-loop 자신의 직접 쓰기는 `<project-root>/.deep-loop/` 하위만. 예외: `/deep-loop-finish`가 deep-memory/deep-wiki **각 플러그인 자체 스킬에 위임**해 그 store(`~/.deep-memory`, `wiki_root`)에 기록(deep-loop이 직접 쓰지 않음, 사람이 시작한 finish의 side-effect). `runId`는 안전한 단일 경로 세그먼트만(`runDir`이 강제). (spec §15)
- **SKILL.md frontmatter는 정확히 `name`·`description`·`user-invocable` 3필드만** (deep-suite 컨벤션). `description`에 영어+한국어 트리거 구문을 인라인으로 패킹. user-invocable 진입 스킬은 "Skill body echo 금지" 보일러플레이트로 시작. body는 한국어 헤딩 + 영어 기술용어 혼용, 사용자 언어 감지·동일 언어 출력. (deep-work/deep-review 스킬 미러)
- 시간은 `new Date().toISOString()`. 테스트·headless 드라이버는 주입 가능한 `now`(ms 또는 ISO)로 결정론 유지.
- M3 envelope(`producer:"deep-loop"`)는 loop.json 외 산출물(handoff/compaction-state/final-report 등)에 `envelope.wrap`로 적용. (spec §4)
- 커밋: 태스크당 1개, 모듈 스코프. 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

## 회피할 함정 (Plan 2 Codex 리뷰에서 확립 — Plan 3가 답습 금지)

Plan 2 구현 리뷰는 16라운드에 걸쳐 23 critical + 13 should-fix를 잡았다. Plan 3의 결정론 글루(CLI 완성·hook·spawn 드라이버·finish)는 같은 함정을 답습하지 않는다:

- **F1 (fencing in-lock):** generation fence는 상태를 바꾸는 같은 lock 안에서 검사. 외부 precondition만으로 통과시키지 말 것. `patch`/`recordCost`/`ack`/`finish`에 fence를 추가할 때 `withLock`/`appendAnchored`의 `preCheck` 안에서 `leaseCheck`.
- **F2 (atomic / no half-commit):** 이벤트 기록 + 상태 전이는 단일 `appendAnchored`. `finish`의 status 전이 + 이벤트는 한 트랜잭션. 분리하면 lease가 사이에 `releasing`이 되어 half-commit.
- **F3 (verify-before-append):** `appendAnchored`는 내부적으로 append 전 `verifyLog`/`verifyHead`. 우리는 새 `appendAnchored` 콜에서 그 단일 경로를 쓴다(직접 append 금지) → truncation launder 불가.
- **F4 (terminal via proof):** `finish --status completed`는 모든 episode settled + active_workstreams 0 + 모든 workstream 터미널 + final-report.md 존재를 proof로 검증한 뒤에만 전이. `stopped`는 사람 명시.
- **F5 (off-by-one):** respawn 게이트의 `sessions.length > max_sessions`, per_session_turn_cap의 `>=`는 기존 커널이 이미 처리 — Plan 3 드라이버는 커널 게이트(`respawnGate`)를 신뢰하고 우회하지 않는다.
- **F6 (phantom 검증):** `adapter resolve`/`finish`는 존재하지 않는 workstream/episode/protocol을 받으면 조용히 진행하지 말고 명시 throw.
- **F7 (fail-closed):** headless spawn 드라이버는 usage 측정 불가 시 성공으로 간주하지 말고 fail-closed(spawn 거부 + 부모 lease 롤백, `respawn`의 실패모드 B 경로 그대로).
- **F8 (parent-dir handoff):** launch 명령은 부모 run 디렉터리 경로를 참조(`buildLaunchCommand` 기존 구현). 드라이버는 `respawn`이 빌드한 명령을 그대로 실행, 경로를 재구성하지 않는다.

---

## 파일 구조 (이 plan이 생성/수정)

```
deep-loop/
  scripts/
    deep-loop.mjs                 # [수정] state/budget/comprehension/breaker/finish/adapter 핸들러 추가, next-action/tick에 --now
    lib/
      state.mjs                   # [수정] patch(...,{fence}) — lock 내부 leaseCheck
      budget.mjs                  # [수정] recordCost(...,{fence}) — preCheck leaseCheck
      comprehension.mjs           # [수정] ack(...,{fence}) — lock 내부 leaseCheck
      breaker.mjs                 # [수정] resetBreaker(root,runId,{confirm}) — 사람 전용 latch 해제
      finish.mjs                  # [신규] finishRun — proof 검증 + status 전이 + final-report 경로 기록
      spawn-driver.mjs            # [신규] headlessSpawn — child_process + timeout + usage 파싱 + fail-closed
    hooks-impl/
      precompact-handoff.mjs      # [신규] emit + 조건부 respawn(spawnFn 주입)
      drive-headless.mjs          # [신규] 무인 자동화용 fail-closed claude -p 래퍼 (headlessSpawn 경유)
  hooks/
    hooks.json                    # [신규] PreCompact 1개
    scripts/precompact-handoff.sh # [신규] Bash 3.2 래퍼 → hooks-impl/precompact-handoff.mjs
  skills/
    deep-loop/SKILL.md            # [신규] 진입 (user-invocable:true)
    deep-loop-workflow/SKILL.md   # [신규] 비공개 (user-invocable:false) + references/*.md
    deep-loop-workflow/references/{adapters.md,review-strategy.md,handoff-respawn.md}
    deep-loop-discover/SKILL.md
    deep-loop-triage/SKILL.md
    deep-loop-continue/SKILL.md   # [신규] 메인 tick
    deep-loop-handoff/SKILL.md
    deep-loop-resume/SKILL.md
    deep-loop-status/SKILL.md
    deep-loop-ack/SKILL.md
    deep-loop-finish/SKILL.md
  recipes/automation/
    cron-morning-triage.yml       # [신규]
    github-actions-loop.yml       # [신규]
  tests/
    orch-cli.test.mjs             # [수정] 날짜-flake 제거 (--now)
    cli-skillface.test.mjs        # [신규] state/budget/comprehension/breaker/adapter/finish CLI
    finish.test.mjs               # [신규] finishRun proof 게이트
    spawn-driver.test.mjs         # [신규] headlessSpawn fail-closed/timeout
    precompact-hook.test.mjs      # [신규] hook glue emit+respawn 분기
    skills.test.mjs               # [신규] 10 SKILL.md 구조/트리거/언어/CLI-참조 검증
    automation.test.mjs           # [신규] recipes/automation YAML 구조 검증
  README.md README.ko.md CHANGELOG.md   # [신규] 사용자 문서
  integration/deep-suite.patch.md       # [신규] marketplace 등록 패치 플랜 (항상 생성)
```

---

## Phase 0 — Groundwork

### Task 1: `next-action`/`tick` CLI `--now` 주입 + 날짜-flake 테스트 제거

기준선(`main`)의 `tests/orch-cli.test.mjs:20`은 `seed()`가 run을 고정 과거 날짜(`2026-06-24T00:00:00Z`)로 만들고 `next-action` CLI는 실시간 시계를 써서, 24h(`max_wallclock_sec=86400`)가 지난 날엔 `wallclock-hard-stop` → `discover` 대신 `handoff`를 반환해 실패한다(production 동작은 정상, 테스트가 고정-과거 seed와 live-clock을 섞은 취약점). `next-action`/`tick`에 `--now` 주입을 배선해 결정론으로 만든다.

**Files:**
- Modify: `scripts/deep-loop.mjs:83-84` (next-action, tick 핸들러)
- Modify: `tests/orch-cli.test.mjs:20-25` (failing test 결정론화)

**Interfaces:**
- Consumes: `next-action.nextAction(loop, {now})` (기존), `Date.parse`.
- Produces:
  - CLI `next-action [--json] [--now <iso|ms>]` — `--now` 지정 시 그 시각으로 게이트 평가(미지정 시 `Date.now()`).
  - CLI `tick --mode <m> [--now <iso|ms>]` — 동일.
  - Helper `parseNow(f)` in `deep-loop.mjs` — `--now`가 순수 정수면 `Number`, 아니면 `Date.parse`; 유효하지 않으면 `Date.now()`.

- [ ] **Step 1: Write the failing test**

`tests/orch-cli.test.mjs` 의 첫 테스트를 결정론으로 교체(`--now`를 seed 날짜로 전달):

```javascript
test('next-action prints descriptor JSON (deterministic now)', () => {
  const { root } = seed();   // run created_at = 2026-06-24T00:00:00Z
  const out = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z']));
  assert.ok(out.action && out.gate);
  assert.equal(out.action.type, 'discover');   // wallclock 창 안 → handoff 아님
});

test('next-action honors --now for wallclock hard-stop', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-30T00:00:00Z'])); // > 24h
  assert.equal(out.action.type, 'handoff');
  assert.equal(out.gate.blocked_by[0], 'budget');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/orch-cli.test.mjs`
Expected: FAIL — `next-action` 가 `--now` 를 무시(아직 미배선)해 두 번째 테스트가 실패하거나 unknown flag 무시로 첫 테스트가 live-clock에 의존.

- [ ] **Step 3: Plumb `--now` into the CLI handlers**

`scripts/deep-loop.mjs` — `parseFlags` 아래에 헬퍼 추가:

```javascript
function parseNow(f) {
  if (f.now === undefined || f.now === true) return Date.now();
  const s = String(f.now);
  const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(n) ? n : Date.now();
}
```

next-action / tick 핸들러를 교체:

```javascript
  'next-action': async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json(nextAction(data, { now: parseNow(f) })); return 0; },
  tick: async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json({ mode: f.mode || 'advance', ...nextAction(data, { now: parseNow(f) }) }); return 0; },
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/orch-cli.test.mjs`
Expected: PASS (모든 orch-cli 테스트 green)

- [ ] **Step 5: Run full suite + commit**

Run: `npm test`
Expected: 0 fail (기존 174 + 신규 1 = 176 통과; 정확 수는 node가 보고).

```bash
git add scripts/deep-loop.mjs tests/orch-cli.test.mjs
git commit -m "fix(cli): plumb --now into next-action/tick; deterministic wallclock test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase A — Skill-facing 커널 CLI 완성

스킬은 변경을 오직 CLI로만 한다. Plan 2는 오케스트레이션 핵심(lease/workstream/episode/review/handoff/respawn)만 CLI에 노출했고, 스킬이 의존하는 나머지 표면(`state get/patch`·`budget record`·`comprehension ack`·`breaker reset`·`finish`·`adapter resolve`)은 lib에만 있거나 미구현이다. 이 Phase가 그 표면을 완성한다. **모든 mutating 핸들러는 `requireLease`로 fence하고, 새로 노출하는 lib는 fence를 lock 내부에서 강제하도록 확장한다.**

### Task 2: `adapter resolve` CLI — maker dispatch 디스크립터(read-only)

`next-action`의 `dispatch_maker` 액션은 episode_id/point/workstream만 주고 *어느 sibling 스킬을 어떤 인자로 부를지*는 안 준다(`review dispatch`는 디스크립터를 주지만 maker는 비대칭). 스킬이 `protocols/*.json`을 손파싱하지 않도록, 기존 `adapters.resolveAdapter` + `guardTierProtocol`을 read-only CLI로 노출한다.

**Files:**
- Modify: `scripts/deep-loop.mjs` (`adapter` 핸들러 추가)
- Test: `tests/cli-skillface.test.mjs` (신규, 이 태스크에서 생성)

**Interfaces:**
- Consumes: `adapters.resolveAdapter(name)`, `adapters.guardTierProtocol(tier, protocol, verb)` (기존).
- Produces:
  - CLI `adapter resolve --protocol <name> --task <brief> [--verb dispatch] [--tier <t>]` → JSON `{ protocol, verb, descriptor:{kind,skill,then,args}, guard:{ok,reason} }`. read-only(fence 불필요). 알 수 없는 protocol → 종료코드 2 + `error`. `--tier` 지정 시 `guardTierProtocol` 결과 포함(read-only면 implementer dispatch 금지 사유).

- [ ] **Step 1: Write the failing test**

`tests/cli-skillface.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
function run(root, args) { return execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' }); }
function runFail(root, args) { try { run(root, args); return 0; } catch (e) { return e.status; } }
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-sf-'));
  const { runId } = initRun(root, { goal: 'g', protocol: 'deep-work', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

// Codex r1 should-fix-2: spec §6 의 4-verb 계약을 CLI 가 노출해야 한다 (dispatch 만 X).
test('adapter resolve returns a normalized 4-verb descriptor', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'Add auth']));
  assert.equal(out.dispatch.kind, 'invoke_skill');
  assert.equal(out.dispatch.skill, 'deep-work:deep-work-orchestrator');
  assert.match(out.dispatch.args, /Add auth/);
  assert.equal(out.await.kind, 'poll_file');
  assert.match(out.await.path, /Add auth/);          // path_template <task> 치환
  assert.ok('read' in out);                            // readArtifacts receipt 디스크립터
  assert.match(out.checker_via, /review dispatch/);    // checker 는 review dispatch CLI 경유
});

test('adapter resolve --verb selects a single verb descriptor', () => {
  const { root } = seed();
  const a = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--verb', 'await']));
  assert.equal(a.selected, 'await');
  assert.equal(a.descriptor.kind, 'poll_file');
});

test('adapter resolve blocks the deep-work implementer entirely under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, false);   // dispatch 자체가 implementer → 전체 차단
});

// Codex r7 sf-1: read-only superpowers 는 planning(writing-plans)은 허용하고 then(implementer)만 strip.
test('adapter resolve allows planning-only superpowers under read-only', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'superpowers', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, true);
  assert.equal(out.guard.planning_only, true);
  assert.equal(out.dispatch.skill, 'superpowers:writing-plans');
  assert.equal(out.dispatch.then, null);   // subagent-driven-development(implementer) 차단
});

test('adapter resolve rejects unknown protocol (exit 2)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--protocol', 'nope', '--task', 'x']), 2);
});

// Codex r1 should-fix-6: 비-fence 인자 누락은 usage 오류(exit 2)지 fence 코드(3) 가 아니다.
test('adapter resolve missing --protocol exits 2 (usage, not fence-3)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--task', 'x']), 2);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: FAIL — `unknown subcommand: adapter`.

- [ ] **Step 3: Add the `adapter` handler**

`scripts/deep-loop.mjs` — import 추가 + 핸들러:

```javascript
import { resolveAdapter, guardTierProtocol, loadProtocol } from './lib/adapters.mjs';
```

**Codex r1 should-fix-6 — exit-code 분리 헬퍼.** 기존 `strArg`/`intArg`는 누락/무효 시 `process.exit(3)`인데, 3은 **fence 전용 코드**(`LEASE_FENCED`/`FENCE_REQUIRED`)다. 비-fence 인자(adapter `--protocol`, state-patch `--field`/`--value`, comprehension `--episode`, finish `--status`)는 fence 코드로 보고하면 안 된다. fence 인자(`--owner`/`--generation`)는 계속 `requireLease`/`intArg`(exit 3), 비-fence 인자는 아래 비-exiting 헬퍼로 받아 핸들러가 적절한 코드를 `return`한다:
- 누락(required missing) → **exit 2** (usage 오류, unknown 커맨드/verb 와 동일 계열)
- 무효 값(bad JSON / 잘못된 enum) → **exit 1**

`parseFlags` 아래에 추가:

```javascript
function reqStr(f, name) { const v = f[name]; return (typeof v === 'string' && v.length) ? v : null; }   // 누락 시 null (핸들러가 exit 2 결정)
```

handlers 객체에 (`adapter resolve`는 read-only라 `requireLease` 호출 안 함; 4-verb 정규화 디스크립터 반환):

```javascript
  adapter: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest);
    if (verb !== 'resolve') { error(`unknown adapter verb: ${verb}`); return 2; }
    const protocol = reqStr(f, 'protocol'); if (!protocol) { error('MISSING_PROTOCOL'); return 2; }
    let ad, p; try { ad = resolveAdapter(protocol); p = loadProtocol(protocol); } catch { error(`UNKNOWN_PROTOCOL: ${protocol}`); return 2; }
    const task = reqStr(f, 'task') || '';
    const ref = { task };
    const fillTask = (t) => String(t || '').replace(/<task>/g, task);
    let dispatch = ad.dispatch(ref);
    const awaitD = ad.awaitResult(ref);
    const read = { path: p.read.receipt_path_template ? fillTask(p.read.receipt_path_template) : null, producer: p.read.producer, artifact_kind: p.read.artifact_kind };
    // guard 는 implementer_verb 기준 (tier×protocol 모순). Codex r7 sf-1: read-only 가 implementer 를 막을 때,
    // implementer_verb 가 'then'(superpowers)이면 planning(dispatch.skill=writing-plans)은 살리고 `then`(subagent-driven-development)만 strip,
    // 'dispatch'(deep-work/standalone)면 dispatch 자체가 implementer 라 전체 차단(guard.ok=false).
    const implGuard = f.tier && f.tier !== true ? guardTierProtocol(f.tier, protocol, p.implementer_verb) : { ok: true, reason: 'no-tier' };
    let guard = implGuard;
    if (!implGuard.ok && p.implementer_verb === 'then') {
      dispatch = { ...dispatch, then: null };                                  // planning-only: writing-plans 실행, then skip
      guard = { ok: true, reason: 'planning-only-readonly', planning_only: true };
    }
    const sel = f.verb && f.verb !== true ? String(f.verb) : null;
    if (sel) {
      const map = { dispatch, await: awaitD, read };
      if (!(sel in map)) { error(`UNKNOWN_VERB: ${sel}`); return 2; }
      json({ protocol, selected: sel, descriptor: map[sel], guard }); return 0;
    }
    json({ protocol, dispatch, await: awaitD, read, checker_via: 'review dispatch --point <p> --workstream <ws> (kernel derives checker episode + descriptor)', guard }); return 0;
  },
```

(주의: `loadProtocol`/`resolveAdapter`/`guardTierProtocol`는 `adapters.mjs` 기존 export. `awaitResult(ref)`는 `path_template`을 `<task>`로 채워 반환. `read`는 디스크 읽기를 *실행하지 않고* receipt 경로 템플릿 + 식별 가드만 노출. **스킬은 `guard.ok===true && dispatch.skill` 이면 planning 을 실행하고, `dispatch.then` 이 non-null 일 때만 implementer 단계를 실행한다** — `planning_only` 면 then 이 null 이라 자동으로 implementer 를 건너뛴다.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/deep-loop.mjs tests/cli-skillface.test.mjs
git commit -m "feat(cli): adapter resolve — read-only maker dispatch descriptor + tier guard

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: `state get` CLI — hash-검증 상태 읽기(read-only)

스킬(status/resume/continue)이 `loop.json`을 직접 읽으면 hash anchor 검증을 우회한다. `state get`은 `readState`(content-hash 검증 → 손상 시 `STATE_TAMPERED` throw)를 경유해 전체 또는 한 필드를 반환한다.

**Files:**
- Modify: `scripts/deep-loop.mjs` (`state` 핸들러, get verb)
- Test: `tests/cli-skillface.test.mjs` (이 태스크에서 추가)

**Interfaces:**
- Consumes: `state.readState(root, runId)` (기존, hash 검증).
- Produces:
  - CLI `state get [--field <dot.path>]` → `--field` 미지정이면 전체 loop JSON, 지정이면 그 경로의 값(JSON). 경로 없음 → `null`. read-only(fence 불필요). 손상 시 `readState`가 throw → 종료코드 1.

- [ ] **Step 1: Write the failing test**

`tests/cli-skillface.test.mjs` 에 추가:

```javascript
test('state get returns whole loop and a field path', () => {
  const { root } = seed();
  const whole = JSON.parse(run(root, ['state', 'get']));
  assert.equal(whole.goal, 'g');
  const status = JSON.parse(run(root, ['state', 'get', '--field', 'status']));
  assert.equal(status, 'running');
  const missing = JSON.parse(run(root, ['state', 'get', '--field', 'nope.deep']));
  assert.equal(missing, null);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: FAIL — `unknown subcommand: state`.

- [ ] **Step 3: Add the `state` handler (get verb)**

`scripts/deep-loop.mjs` handlers 에:

```javascript
  state: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'get') {
      const { data } = readState(root, runId);
      if (f.field === undefined || f.field === true) { json(data); return 0; }
      const val = String(f.field).split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
      json(val === undefined ? null : val); return 0;
    }
    // 'patch' verb는 Task 4에서 추가
    error(`unknown state verb: ${verb}`); return 2;
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/deep-loop.mjs tests/cli-skillface.test.mjs
git commit -m "feat(cli): state get — hash-verified read of whole loop or a field path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 4: `state patch` CLI + `patch()` fence 확장 (whitelisted, fenced)

스킬이 비-터미널 진행 상태(`discovered_items`/`triage.*`/`decisions`/`active_workstreams`/`episodes.<i>.status`/`workstreams.<i>.depends_on` 등)를 영속하려면 화이트리스트 patch가 필요하다. lib `patch`는 fence가 없으므로(트랩 F1) **lock 내부 `leaseCheck`**로 fence를 추가한 뒤 CLI에 노출한다.

**Files:**
- Modify: `scripts/lib/state.mjs:80-87` (`patch` 시그니처에 `{fence}` 추가)
- Modify: `scripts/deep-loop.mjs` (`state` 핸들러에 patch verb)
- Test: `tests/cli-skillface.test.mjs`, `tests/state.test.mjs` (fence 단위)

**Interfaces:**
- Consumes: `state.classifyPatch`(기존 화이트리스트), `lease.leaseCheck`(기존), `state.withLock`/`readState`/`setPath`(내부).
- Produces:
  - `state.patch(root, runId, field, value, { fence } = {})` — 변경: `classifyPatch` allow 확인 후, **`withLock` 안에서** `fence` 주어지면 `leaseCheck(data, fence)` 실패 시 `LEASE_FENCED` throw, 통과 시 `setPath`+`writeState`. fence 미지정이면 기존 동작(테스트 호환).
  - CLI `state patch --field <path> --value <json> --owner <run_id> --generation <n>` → 화이트리스트 위반 `FIELD_FORBIDDEN`(종료 1), fence 불일치 `LEASE_FENCED`(종료 3). 성공 시 `{ok:true}`.

- [ ] **Step 1: Write the failing test**

`tests/cli-skillface.test.mjs` 에 추가:

```javascript
test('state patch writes whitelisted field with valid fence', () => {
  const { root, runId } = seed();
  run(root, ['state', 'patch', '--field', 'discovered_items', '--value', '["a","b"]', '--owner', runId, '--generation', '1']);
  const got = JSON.parse(run(root, ['state', 'get', '--field', 'discovered_items']));
  assert.deepEqual(got, ['a', 'b']);
});

test('state patch rejects forbidden field (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['state', 'patch', '--field', 'budget.spent', '--value', '999', '--owner', runId, '--generation', '1']), 1);
});

test('state patch is fenced on wrong generation (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['state', 'patch', '--field', 'decisions', '--value', '["x"]', '--owner', runId, '--generation', '9']), 3);
});

test('state patch forbids terminal episode status (exit 1)', () => {
  const { root, runId } = seed();
  // episodes.0.status=done 은 터미널 → classifyPatch forbid (episode 가 없어도 분류 단계에서 거부)
  assert.equal(runFail(root, ['state', 'patch', '--field', 'episodes.0.status', '--value', '"done"', '--owner', runId, '--generation', '1']), 1);
});
```

`tests/state.test.mjs` 에 fence 단위(직접 lib, Codex r3 sf-5: 실행 가능한 assertion):

```javascript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { patch, readState } from '../scripts/lib/state.mjs';

test('patch enforces fence inside the lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pf-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  patch(root, runId, 'discovered_items', ['a'], { fence: { owner: runId, generation: 1, intent: 'business' } });
  assert.deepEqual(readState(root, runId).data.discovered_items, ['a']);
  assert.throws(() => patch(root, runId, 'discovered_items', ['b'], { fence: { owner: runId, generation: 9, intent: 'business' } }), /LEASE_FENCED/);
  // forbidden field 는 fence 와 무관하게 거부
  assert.throws(() => patch(root, runId, 'budget.spent', 1, { fence: { owner: runId, generation: 1, intent: 'business' } }), /FIELD_FORBIDDEN/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: FAIL — `unknown state verb: patch`.

- [ ] **Step 3a: Extend `patch()` with in-lock fence**

`scripts/lib/state.mjs` — import + 시그니처:

```javascript
import { leaseCheck } from './lease.mjs';
```

```javascript
export function patch(root, runId, field, value, { fence } = {}) {
  if (classifyPatch(field, value) !== 'allow') throw new Error(`FIELD_FORBIDDEN: ${field}`);
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (fence) { const r = leaseCheck(data, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    setPath(data, field, value);
    writeState(root, runId, data);
  });
}
```

(순환 import 주의: `lease.mjs`는 `state.mjs`의 `readState/writeState/withLock`을 import한다. `state.mjs`가 `lease.mjs`의 `leaseCheck`만 import하면 ESM 순환이 생기지만, `leaseCheck`는 순수 함수(top-level 부수효과 없음)라 안전 — Node ESM은 함수 호출 시점에 바인딩 해소. 단위 테스트가 import 성공을 검증.)

- [ ] **Step 3b: Add `patch` verb to the `state` handler**

`scripts/deep-loop.mjs` — import 에 `patch` 추가:

```javascript
import { readState, writeState, patch as patchState } from './lib/state.mjs';
```

`state` 핸들러의 `error('unknown state verb...')` 위에:

```javascript
    if (verb === 'patch') {
      requireLease(root, runId, f);   // --owner/--generation 누락·불일치 → exit 3 (fence)
      const field = reqStr(f, 'field'); if (!field) { error('MISSING_FIELD'); return 2; }       // Codex r1 sf-6: 비-fence 누락 → exit 2
      const rawVal = reqStr(f, 'value'); if (rawVal === null) { error('MISSING_VALUE'); return 2; }
      let value; try { value = JSON.parse(rawVal); } catch { error('INVALID_VALUE: must be JSON'); return 1; }   // 무효 값 → exit 1
      try { patchState(root, runId, field, value, { fence: { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' } }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
      json({ ok: true }); return 0;
    }
```

(주의: `requireLease`가 owner/generation 누락·불일치를 이미 종료3으로 거른다. patch 안의 in-lock fence는 TOCTOU를 닫는 2차 방어.)

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cli-skillface.test.mjs tests/state.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs scripts/deep-loop.mjs tests/cli-skillface.test.mjs tests/state.test.mjs
git commit -m "feat(cli): state patch — whitelisted + in-lock fenced field write

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 5: `budget record` CLI + `recordCost()` fence 확장

continue tick / headless 드라이버가 턴·토큰 소비를 기록해 budget 게이트가 동작하려면 cost 이벤트 기록 CLI가 필요하다. `budget.spent`/`tokens_spent`는 커널이 event-log 합산에서만 파생(스킬 patch 금지) — `recordCost`가 그 단일 경로다. fence를 추가한다.

**Files:**
- Modify: `scripts/lib/budget.mjs:23-29` (`recordCost`에 `{fence}` preCheck)
- Modify: `scripts/deep-loop.mjs` (`budget` 핸들러)
- Test: `tests/cli-skillface.test.mjs`

**Interfaces:**
- Consumes: `integrity.appendAnchored` (기존 단일 앵커 경로), `lease.leaseCheck`, `integrity.validCost`.
- Produces:
  - `budget.recordCost(root, runId, { turns=0, tokens=0, fence })` — `appendAnchored`의 **preCheck**에서 `fence` 주어지면 `leaseCheck` 실패 시 throw. mutate는 기존대로 `budget.spent/tokens_spent` 갱신.
  - CLI `budget record --turns <n> --tokens <n> --owner --generation` → `{ok:true, spent, tokens_spent}`. `budget check [--now]` → `checkBudget` 결과(read-only).

- [ ] **Step 1: Write the failing test**

```javascript
test('budget record accrues turns/tokens via event log with fence', () => {
  const { root, runId } = seed();
  const r = JSON.parse(run(root, ['budget', 'record', '--turns', '3', '--tokens', '1000', '--owner', runId, '--generation', '1']));
  assert.equal(r.ok, true);
  const spent = JSON.parse(run(root, ['state', 'get', '--field', 'budget.spent']));
  assert.equal(spent, 3);
});

test('budget record is fenced (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns', '1', '--owner', runId, '--generation', '9']), 3);
});

// Codex r4 sf-4: 값 없는 --turns 는 1 로 오기록하지 말고 거부(exit 1).
test('budget record rejects a valueless --turns (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['budget', 'record', '--turns', '--owner', runId, '--generation', '1']), 1);
});

test('budget check is read-only and reports ok', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['budget', 'check', '--now', '2026-06-24T00:00:01Z']));
  assert.equal(r.ok, true);
});

// Codex r3 critical-1: budget record 가 세션 turns 를 증가시켜 per_session_turn_cap 마일스톤을 실제로 구동.
test('budget record drives per_session_turn_cap → next-action handoff', () => {
  const { root, runId } = seed();
  run(root, ['budget', 'record', '--turns', '40', '--owner', runId, '--generation', '1']);   // == per_session_turn_cap(40)
  const na = JSON.parse(run(root, ['next-action', '--json', '--now', '2026-06-24T00:00:01Z']));
  assert.equal(na.action.type, 'handoff');
  assert.equal(na.action.reason, 'per_session_turn_cap');
});

// Codex r3 sf-2: 스킬이 쓰는 CLI 경로(episode new --artifacts → record done)가 실제로 통과하는지 통합 검증.
test('episode new --artifacts then record done (the skill flow)', () => {
  const { root, runId } = seed();
  writeFileSync(join(root, 'art.txt'), 'x');   // expected artifact 가 root 하위에 존재해야 done 통과
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'implementation', '--point', 'implementation', '--artifacts', '["art.txt"]', '--owner', runId, '--generation', '1']));
  run(root, ['episode', 'record', '--id', ep.id, '--status', 'done', '--artifacts', '["art.txt"]', '--owner', runId, '--generation', '1']);
  assert.equal(JSON.parse(run(root, ['state', 'get', '--field', 'episodes.0.status'])), 'done');
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: FAIL — `unknown subcommand: budget`.

- [ ] **Step 3a: Add fence preCheck to `recordCost`**

`scripts/lib/budget.mjs`:

```javascript
import { leaseCheck } from './lease.mjs';
```

```javascript
export function recordCost(root, runId, { turns = 0, tokens = 0, fence } = {}) {
  if (!validCost({ turns, tokens })) throw new Error(`INVALID_COST: turns/tokens must be finite >= 0 (got ${turns}/${tokens})`);
  return appendAnchored(root, runId, { type: 'cost', data: { turns, tokens } }, (loop, spent) => {
    loop.budget.spent = spent.turns;
    loop.budget.tokens_spent = spent.tokens;
    // Codex r3 critical-1: per_session_turn_cap 마일스톤은 nextAction 이 lease owner 의 session.turns 로 판정한다
    // (next-action.mjs:5-7,57-59). 같은 트랜잭션에서 현재 세션의 turns 를 이 호출의 delta 만큼 증가시켜야 cap 이 실제로 터진다.
    const owner = loop.session_chain?.lease?.owner_run_id;
    const sess = (loop.session_chain?.sessions || []).find(s => s.run_id === owner);
    if (sess) sess.turns = (sess.turns || 0) + turns;
  }, (loop) => {
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
  });
}
```

(주의: 실제 시그니처는 `appendAnchored(root, runId, {type,data}, mutate, preCheck)` — mutate는 **4번째** 위치인자 `(loop, spent)`, preCheck는 **5번째** `(loop)`. 위 코드는 이를 정확히 호출한다. 기존 호출자(테스트)는 fence 미전달 → 동작 불변. [Codex r1 info-7])

- [ ] **Step 3b: Add the `budget` handler**

`scripts/deep-loop.mjs` — import + 핸들러:

```javascript
import { recordCost, checkBudget } from './lib/budget.mjs';
```

```javascript
  budget: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(checkBudget(data, { now: parseNow(f) })); return 0; }
    if (verb === 'record') {
      requireLease(root, runId, f);
      // Codex r4 sf-4: parseFlags 는 값 없는 플래그를 true 로 둔다 → Number(true)=1 오기록 방지.
      // 미지정 → 0, 지정 시 비음정수 문자열만 허용(true/음수/NaN/Infinity 거부).
      const turns = optInt(f, 'turns'); const tokens = optInt(f, 'tokens');
      if (turns === null || tokens === null) { error('INVALID_COST: --turns/--tokens must be non-negative integers'); return 1; }
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { recordCost(root, runId, { turns, tokens, fence }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
      const { data } = readState(root, runId);
      json({ ok: true, spent: data.budget.spent, tokens_spent: data.budget.tokens_spent }); return 0;
    }
    error(`unknown budget verb: ${verb}`); return 2;
  },
```

`optInt` 헬퍼는 `parseFlags`/`reqStr` 근처에 한 번 정의(Task 2 에서 `reqStr` 와 함께 도입):

```javascript
function optInt(f, name) {   // 미지정 → 0; 지정 시 비음정수 문자열만 허용, 아니면 null(핸들러가 exit 1)
  const v = f[name];
  if (v === undefined) return 0;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  return Number(v);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/budget.mjs scripts/deep-loop.mjs tests/cli-skillface.test.mjs
git commit -m "feat(cli): budget record/check — fenced cost accrual via single anchor path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 6: `comprehension ack`/`status` CLI + `ack()` fence 확장

`/deep-loop-ack`이 사람 검토를 표시해 comprehension debt를 줄이려면 fenced ack CLI가 필요하다.

**Files:**
- Modify: `scripts/lib/comprehension.mjs:11-19` (`ack`에 `{fence}`)
- Modify: `scripts/deep-loop.mjs` (`comprehension` 핸들러)
- Test: `tests/cli-skillface.test.mjs`

**Interfaces:**
- Consumes: `comprehension.computeDebt`(기존), `lease.leaseCheck`, `state.withLock`/`readState`/`writeState`.
- Produces:
  - `comprehension.ack(root, runId, episodeId, { fence } = {})` — `withLock` 안에서 `fence` 주어지면 `leaseCheck` 실패 시 throw; 통과 시 `episodes_human_reviewed++` + `ep.human_reviewed=true`.
  - CLI `comprehension ack --episode <id> --owner --generation` → `{ok:true, debt_ratio}`. `comprehension status` → `computeDebt`(read-only).

- [ ] **Step 1: Write the failing test**

```javascript
test('comprehension status is read-only', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['comprehension', 'status']));
  assert.equal(r.debt_ratio, 0);
});

test('comprehension ack is fenced (exit 3)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--episode', 'x', '--owner', runId, '--generation', '9']), 3);
});

// Codex r1 should-fix-5: 부재 episode ack 는 overcount 를 일으키면 안 된다 → 거부(exit 1).
test('comprehension ack rejects nonexistent episode (exit 1)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--episode', 'ghost', '--owner', runId, '--generation', '1']), 1);
});

// Codex r1 should-fix-6: 비-fence 인자 누락 → exit 2 (usage).
test('comprehension ack missing --episode exits 2', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['comprehension', 'ack', '--owner', runId, '--generation', '1']), 2);
});
```

`tests/comprehension.test.mjs` 에 dedup 단위 테스트 추가(직접 lib, Codex r3 sf-5: 실행 가능):

```javascript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { newEpisode } from '../scripts/lib/episode.mjs';
import { ack } from '../scripts/lib/comprehension.mjs';
import { readState } from '../scripts/lib/state.mjs';

test('ack is idempotent and validates episode existence', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-ack-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  const ep = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', expectedArtifacts: ['a'], fence });
  ack(root, runId, ep.id, { fence });
  ack(root, runId, ep.id, { fence });   // 중복 — 카운트 증가 금지
  assert.equal(readState(root, runId).data.comprehension.episodes_human_reviewed, 1);
  assert.throws(() => ack(root, runId, 'ghost', { fence }), /EPISODE_NOT_FOUND/);
  assert.throws(() => ack(root, runId, ep.id, { fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: FAIL — `unknown subcommand: comprehension`.

- [ ] **Step 3a: Add in-lock fence to `ack`**

`scripts/lib/comprehension.mjs`:

```javascript
import { leaseCheck } from './lease.mjs';
```

```javascript
export function ack(root, runId, episodeId, { fence } = {}) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (fence) { const r = leaseCheck(data, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
    const ep = data.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // Codex r1 sf-5: 부재 episode overcount 차단
    if (ep.human_reviewed) return { ok: true, already: true };     // 멱등 — 중복 ack 는 카운트 증가 안 함
    ep.human_reviewed = true;
    data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    writeState(root, runId, data);
    return { ok: true, already: false };
  });
}
```

- [ ] **Step 3b: Add the `comprehension` handler**

```javascript
import { computeDebt, ack as ackComprehension } from './lib/comprehension.mjs';
```

```javascript
  comprehension: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'status') { const { data } = readState(root, runId); json(computeDebt(data)); return 0; }
    if (verb === 'ack') {
      requireLease(root, runId, f);   // fence 인자 → exit 3
      const episode = reqStr(f, 'episode'); if (!episode) { error('MISSING_EPISODE'); return 2; }   // Codex r1 sf-6
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { ackComprehension(root, runId, episode, { fence }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }   // EPISODE_NOT_FOUND → exit 1
      const { data } = readState(root, runId); json({ ok: true, ...computeDebt(data) }); return 0;
    }
    error(`unknown comprehension verb: ${verb}`); return 2;
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/comprehension.mjs scripts/deep-loop.mjs tests/cli-skillface.test.mjs
git commit -m "feat(cli): comprehension ack/status — fenced human-review acknowledgement

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 7: `breaker reset`/`check` CLI + `resetBreaker()` (사람 전용 latch 해제)

circuit breaker가 latch되면(연속 REQUEST_CHANGES 3) 사람 reset 전까지 모든 진행이 막힌다(spec §15). 사람 escape hatch로 reset CLI가 필요하되 **불변식 2(모든 mutating CLI는 lease fence 필수)를 지킨다**(Codex r2 critical-1): **`--confirm`(사람 의도 게이트) + lease fence(`--owner --generation`, lock 내부 검사) 둘 다 요구.** breaker trip 시 lease 는 **해제되지 않으므로**(여전히 그 세션이 owner) 같은 세션이 자기 fence 로 reset 하거나, 새 세션이 `/deep-loop-resume`(lease acquire → generation+1) 후 reset 한다. `--confirm` 은 autonomous tick 이 스스로 breaker 를 못 풀게 막고(자동 루프는 `--confirm` 안 줌), fence 는 lease 미보유 호출을 막는다 — 상보적 게이트.

**Files:**
- Modify: `scripts/lib/breaker.mjs` (`resetBreaker` 신규)
- Modify: `scripts/deep-loop.mjs` (`breaker` 핸들러)
- Test: `tests/cli-skillface.test.mjs`, `tests/breaker.test.mjs`

**Interfaces:**
- Consumes: `state.withLock`/`readState`/`writeState`, `lease.leaseCheck`(breaker.mjs 가 이미 import).
- Produces:
  - `breaker.resetBreaker(root, runId, { fence } = {})` — `withLock` 안에서 `fence` 주어지면 `leaseCheck` 실패 시 `LEASE_FENCED` throw; 통과 시 `tripped=false`, `consecutive_request_changes=0`, `trip_reason=null`; `status==='paused' && 직전 trip_reason 이 breaker 계열`이면 `status='running'` 복귀(다른 사유의 paused는 건드리지 않음). 반환 `{ok:true, status}`.
  - CLI `breaker check` → `checkBreaker`(read-only). `breaker reset --confirm --owner --generation` → `--confirm` 없으면 종료 2; fence(`requireLease`) 누락/불일치 또는 in-lock `LEASE_FENCED` 시 종료 3; 성공 시 `{ok:true,status}`. **autonomy 로 못 켜는 사람 + lease-owner 전용 경로.**

- [ ] **Step 1: Write the failing test**

`tests/breaker.test.mjs` 에 추가(직접 lib + trip→reset, Codex r3 sf-5: 실행 가능):

```javascript
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { checkBreaker, recordReviewVerdict, resetBreaker } from '../scripts/lib/breaker.mjs';
import { readState } from '../scripts/lib/state.mjs';

test('resetBreaker clears a tripped latch under valid fence; wrong gen throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-rb-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  const fence = { owner: runId, generation: 1, intent: 'business' };
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES', fence);
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES', fence);
  recordReviewVerdict(root, runId, 'REQUEST_CHANGES', fence);   // 연속 3 → tripped + status=paused
  assert.equal(checkBreaker(readState(root, runId).data).tripped, true);
  assert.throws(() => resetBreaker(root, runId, { fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);   // fence 강제
  const r = resetBreaker(root, runId, { fence });
  assert.equal(r.status, 'running');   // breaker 사유 paused → 복귀
  assert.equal(checkBreaker(readState(root, runId).data).tripped, false);
});
```

`tests/cli-skillface.test.mjs`:

```javascript
test('breaker reset requires --confirm (exit 2)', () => {
  const { root, runId } = seed();
  assert.equal(runFail(root, ['breaker', 'reset', '--owner', runId, '--generation', '1']), 2);   // confirm 없음
});

test('breaker reset with --confirm is still fenced (exit 3)', () => {
  const { root, runId } = seed();   // Codex r2 critical-1: confirm 만으로는 부족, fence 도 필요
  assert.equal(runFail(root, ['breaker', 'reset', '--confirm', '--owner', runId, '--generation', '9']), 3);
});

test('breaker check is read-only', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['breaker', 'check']));
  assert.equal(r.tripped, false);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/cli-skillface.test.mjs tests/breaker.test.mjs`
Expected: FAIL — `unknown subcommand: breaker` / `resetBreaker is not a function`.

- [ ] **Step 3a: Add `resetBreaker`**

`scripts/lib/breaker.mjs`:

```javascript
export function resetBreaker(root, runId, { fence } = {}) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    if (fence) { const r = leaseCheck(data, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }   // Codex r2 critical-1: in-lock fence
    const wasBreaker = data.status === 'paused' && /request-changes|consecutive/.test(data.circuit_breaker?.trip_reason || '');
    data.circuit_breaker = { consecutive_request_changes: 0, tripped: false, trip_reason: null };
    if (wasBreaker) data.status = 'running';
    writeState(root, runId, data);
    return { ok: true, status: data.status };
  });
}
```

- [ ] **Step 3b: Add the `breaker` handler**

```javascript
import { checkBreaker, resetBreaker } from './lib/breaker.mjs';
```

```javascript
  breaker: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(checkBreaker(data)); return 0; }
    if (verb === 'reset') {
      if (f.confirm !== true && f.confirm !== 'true') { error('BREAKER_RESET_REQUIRES_CONFIRM: pass --confirm (human-only)'); return 2; }
      requireLease(root, runId, f);   // Codex r2 critical-1: fence 도 필수 (--owner/--generation, exit 3)
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { json(resetBreaker(root, runId, { fence })); return 0; }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
    }
    error(`unknown breaker verb: ${verb}`); return 2;
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/cli-skillface.test.mjs tests/breaker.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/breaker.mjs scripts/deep-loop.mjs tests/cli-skillface.test.mjs tests/breaker.test.mjs
git commit -m "feat(cli): breaker check/reset — human-only latch reset (--confirm gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 8: `finish.mjs` lib + `finish` CLI — proof 검증 + status 전이

`/deep-loop-finish`의 결정론 코어. `completed`는 proof 검증(모든 episode settled + active_workstreams 0 + 모든 workstream 터미널 + final-report.md 존재) 통과 시에만 전이(트랩 F4). `stopped`는 사람 명시. status 전이 + 이벤트는 단일 `appendAnchored`(트랩 F2). fence 필수.

**Files:**
- Create: `scripts/lib/finish.mjs`
- Modify: `scripts/deep-loop.mjs` (`finish` 핸들러)
- Test: `tests/finish.test.mjs`, `tests/cli-skillface.test.mjs`

**Interfaces:**
- Consumes: `integrity.appendAnchored`, `lease.leaseCheck`, `state.readState`/`runDir`, `node:fs.existsSync`.
- Produces:
  - `finish.finishRun(root, runId, { status, reportRel, proof = {}, fence, now = Date.now() })` → `{ ok, status, blocked_by? }`.
    - preCheck(loop): `fence` → `leaseCheck`; `status ∈ {completed,stopped}`; `completed`면 (a) `episodes` 전부 settled(`done`/`approved`, 또는 review-satisfied된 rejected checker), (b) `active_workstreams.length===0`, (c) 모든 workstream `status ∈ {ready,merged,abandoned}`, (d) `reportRel` 가 `runDir` 하위에 존재 — 하나라도 실패 시 `FINISH_PROOF_UNMET: <reason>` throw. `stopped`면 `proof.human_reason` 비어있지 않을 것.
    - mutate(loop): `loop.status = status`; `loop.termination.finished_at = ISO(now)`; `loop.termination.final_report = reportRel`.
    - 단일 `appendAnchored({type:'finish', data:{status, reportRel}})`.
  - `finish.finishProofState(loop)` → `{ settled, noActiveWs, allWsTerminal, missing[] }` (검증 분해, status 스킬도 사용).
  - CLI `finish --status <completed|stopped> [--report <rel>] [--proof <json>] --owner --generation [--now <t>]` → `FINISH_PROOF_UNMET` 종료 1, fence 불일치 종료 3, 성공 `{ok:true, status}`.

- [ ] **Step 1: Write the failing test**

`tests/finish.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runDir } from '../scripts/lib/state.mjs';
import { newWorkstream, recordWorkstreamTerminal } from '../scripts/lib/workspace.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { finishRun, finishProofState } from '../scripts/lib/finish.mjs';

// Codex r2 should-fix-2: review.points 를 ['implementation'] 한 개로 시드해야 recordWorkstreamTerminal('ready')
// 의 "전 review point done" 게이트(workspace.mjs:77-82, 기본 [design,plan,implementation])를 한 번의 approve 로 충족한다.
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-fin-'));
  const review = { points: ['implementation'], reviewer: 'subagent-checker', mode: 'cross-model', flags: [], converge: true, max_review_rounds: 5, require_human_ack: false };
  const { runId } = initRun(root, { goal: 'g', review, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}

// 완전히 settled+reviewed+terminal 인 run 을 실제 lib 계약대로 조립 (completed proof 충족).
// Codex r2 sf-2: recordEpisode('done')는 expected_artifacts 가 비어있지 않고 실제 파일이 root 하위에 존재해야 한다
// (episode.mjs:89-112). recordWorkstreamTerminal('ready')는 전 review point coverage 필요(위 seed 가 1개로 축소).
function buildSettledRun(root, runId, fence) {
  writeFileSync(join(root, 'art.txt'), 'artifact');   // expected artifact 가 디스크에 존재해야 done 통과
  const ws = newWorkstream(root, runId, { title: 'W', branch: 'b', worktree: 'wt', fence });
  const ep = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation', workstream: ws.id, expectedArtifacts: ['art.txt'], fence });
  recordEpisode(root, runId, ep.id, { status: 'done', artifacts: ['art.txt'], proof: {}, fence });   // artifacts 가 expected 를 커버
  const dr = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws.id, detected: {}, fence });
  recordReviewOutcome(root, runId, { episodeId: dr.checkerEpisodeId, workstreamId: ws.id, point: 'implementation', verdict: 'APPROVE', fence });
  // 'ready' 는 review_points_done 커버리지만 검사(proof 는 객체이기만 하면 됨); recordWorkstreamTerminal 이 active 에서 제거.
  recordWorkstreamTerminal(root, runId, ws.id, { status: 'ready', proof: {}, fence });
  return ws.id;
}

// --- finishProofState 순수 단위 (디스크 없음) — Codex r1 critical-1 ---
test('finishProofState blocks an empty run (no proof of work)', () => {
  const ps = finishProofState({ episodes: [], workstreams: [], active_workstreams: [] });
  assert.ok(ps.missing.includes('no-proof-of-work'));
});

test('finishProofState blocks when there is no independent review proof', () => {
  const loop = { episodes: [{ id: 'm', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: [] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('no-independent-review'));
});

test('finishProofState passes only with settled + reviewed + terminal', () => {
  const loop = { episodes: [
      { id: 'm', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'approved' }],
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.deepEqual(finishProofState(loop).missing, []);
});

// Codex r6 critical-1: 한 maker 는 리뷰됐지만 다른 done maker 는 미리뷰면 completed 차단.
test('finishProofState blocks when any one done maker is unreviewed', () => {
  const loop = { episodes: [
      { id: 'm1', role: 'maker', point: 'implementation', workstream_id: 'w', status: 'done' },
      { id: 'c1', role: 'checker', point: 'implementation', workstream_id: 'w', status: 'approved' },
      { id: 'm2', role: 'maker', point: 'plan', workstream_id: 'w', status: 'done' }],   // 'plan' 리뷰 없음
    workstreams: [{ id: 'w', status: 'ready', review_points_done: ['implementation'] }], active_workstreams: [] };
  assert.ok(finishProofState(loop).missing.includes('unreviewed-maker'));
});

// --- finishRun 디스크 ---
test('finish completed is blocked on an empty run even with a report', () => {
  const { root, runId, fence } = seed();
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# report');
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }), /FINISH_PROOF_UNMET/);
});

test('finish completed is blocked without report (proof otherwise met)', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
});

test('finish completed succeeds with full proof + report', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  writeFileSync(join(runDir(root, runId), 'final-report.md'), '# report');
  const r = finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence });
  assert.equal(r.status, 'completed');
});

test('finish stopped requires human_reason', () => {
  const { root, runId, fence } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: {}, fence }), /human_reason|FINISH_PROOF_UNMET/);
  const r = finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'user asked' }, fence });
  assert.equal(r.status, 'stopped');
});

test('finish is fenced', () => {
  const { root, runId } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'x' }, fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);
});

// Codex r3 sf-3: fence 는 lib 레벨 필수 (CLI 우회 호출도 차단).
test('finishRun requires a fence object', () => {
  const { root, runId } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'x' } }), /FENCE_REQUIRED/);
});

// Codex r3 sf-3: report 경로는 runDir 하위로 격리 — 바깥 경로는 proof 미충족.
test('finish completed rejects a report path outside runDir', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: '../../escape.md', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
});

// Codex r4 critical-1: runDir 자체('.') 나 디렉터리('handoffs')는 final report 가 아니다 → 거부.
test('finish completed rejects runDir itself or a directory as the report', () => {
  const { root, runId, fence } = seed();
  buildSettledRun(root, runId, fence);
  mkdirSync(join(runDir(root, runId), 'handoffs'), { recursive: true });
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: '.', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'handoffs', proof: {}, fence }), /final-report-missing|FINISH_PROOF_UNMET/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/finish.test.mjs`
Expected: FAIL — `Cannot find module finish.mjs`.

- [ ] **Step 3a: Write `scripts/lib/finish.mjs`**

```javascript
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { appendAnchored } from './integrity.mjs';
import { leaseCheck } from './lease.mjs';
import { runDir } from './state.mjs';

function reviewSatisfied(loop, ep) {
  const ws = (loop.workstreams || []).find(w => w.id === ep.workstream_id);
  if (ws && (ws.review_points_done || []).includes(ep.point)) return true;
  return (loop.episodes || []).some(e => e.role === 'checker' && e.status === 'approved' && e.workstream_id === ep.workstream_id && e.point === ep.point);
}
const settledEp = (loop, e) => ['done', 'approved'].includes(e.status) || (e.role === 'checker' && e.status === 'rejected' && reviewSatisfied(loop, e));
const TERMINAL_WS = ['ready', 'merged', 'abandoned'];

export function finishProofState(loop) {
  const eps = loop.episodes || [];
  const hasWork = eps.length > 0;                                  // Codex r1 critical-1: 빈 run 의 공허-통과 차단
  const settled = eps.every(e => settledEp(loop, e));
  const noActiveWs = (loop.active_workstreams || []).length === 0;
  const wsAll = (loop.workstreams || []).every(w => TERMINAL_WS.includes(w.status));
  // Codex r6 critical-1: **모든** done maker 가 reviewSatisfied 여야 한다 (전역 any 가 아니라 per-maker) —
  // nextAction(next-action.mjs:33-35)·spec §488("checker 없이 maker done 간주 ❌")와 동일 강도.
  const doneMakers = eps.filter(e => e.role === 'maker' && e.status === 'done');
  const allMakersReviewed = doneMakers.every(m => reviewSatisfied(loop, m));
  const reviewedProof = doneMakers.length > 0 && allMakersReviewed;   // 최소 1 리뷰된 maker = 독립 리뷰 proof
  const missing = [];
  if (!hasWork) missing.push('no-proof-of-work');                  // 최소 1 episode 필요 (Array.every 공허-통과 방지)
  if (!settled) missing.push('unsettled-episodes');
  if (!noActiveWs) missing.push('active-workstreams');
  if (!wsAll) missing.push('non-terminal-workstreams');
  if (!allMakersReviewed) missing.push('unreviewed-maker');        // 미리뷰 done maker 차단
  if (hasWork && !reviewedProof) missing.push('no-independent-review');
  return { hasWork, settled, noActiveWs, allWsTerminal: wsAll, allMakersReviewed, reviewedProof, missing };
}

export function finishRun(root, runId, { status, reportRel, proof = {}, fence, now = Date.now() } = {}) {
  // Codex r3 sf-3: fence 는 lib 레벨에서 **필수** (CLI 우회 호출도 fence 강제). newEpisode/recordEpisode 와 동일 규약.
  if (!fence || typeof fence.owner !== 'string' || !Number.isInteger(fence.generation)) throw new Error('FENCE_REQUIRED: finishRun');
  let result;
  appendAnchored(root, runId, { type: 'finish', data: { status, reportRel: reportRel || null } },
    (loop) => {
      loop.status = status;
      loop.termination = loop.termination || {};
      loop.termination.finished_at = new Date(now).toISOString();
      if (reportRel) loop.termination.final_report = reportRel;
      result = { ok: true, status };
    },
    (loop) => {
      const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason);   // 무조건 (fence 필수)
      if (status !== 'completed' && status !== 'stopped') throw new Error(`FINISH_STATUS_INVALID: ${status}`);
      if (status === 'stopped') {
        if (!proof || !proof.human_reason) throw new Error('FINISH_PROOF_UNMET: stopped requires proof.human_reason');
        return;
      }
      // completed: report 는 runDir 하위로 정규화·격리(containment)된 채 존재해야 — CLI 가드에 의존하지 않고 lib 가 강제.
      const ps = finishProofState(loop);
      const base = resolve(runDir(root, runId));
      const full = reportRel ? resolve(base, reportRel) : null;
      // Codex r4 critical-1: report 는 runDir **하위**(자체 아님)의 **실제 파일**이어야 한다 — `--report .` / 디렉터리 거부.
      const reportOk = full && full.startsWith(base + sep) && existsSync(full) && statSync(full).isFile();
      if (!reportOk) ps.missing.push('final-report-missing');
      if (ps.missing.length) throw new Error(`FINISH_PROOF_UNMET: ${ps.missing.join(',')}`);
    });
  return result;
}
```

(주의: `reportRel`은 `runDir` 하위 상대경로만 — `..`/절대경로는 `existsSync`가 root 밖을 보지 않도록 호출자/CLI에서 정규화. spec §15 root-밖-쓰기 금지.)

- [ ] **Step 3b: Add the `finish` handler**

```javascript
import { finishRun } from './lib/finish.mjs';
```

```javascript
  finish: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);   // fence 인자 → exit 3
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    const status = reqStr(f, 'status'); if (!status) { error('MISSING_STATUS'); return 2; }   // Codex r1 sf-6
    const reportRel = f.report && f.report !== true ? String(f.report) : undefined;
    if (reportRel && (reportRel.startsWith('/') || reportRel.split('/').includes('..'))) { error('FINISH_REPORT_PATH_UNSAFE'); return 1; }
    let proof; try { proof = f.proof ? JSON.parse(f.proof) : {}; } catch { error('INVALID_PROOF: must be JSON'); return 1; }   // 무효 값 → exit 1
    try { const r = finishRun(root, runId, { status, reportRel, proof, fence, now: parseNow(f) }); json(r); return 0; }
    catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }   // FINISH_STATUS_INVALID/PROOF_UNMET → exit 1
  },
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/finish.test.mjs`
Expected: PASS (4 tests)

- [ ] **Step 5: Run full suite + commit**

Run: `npm test`
Expected: 0 fail.

```bash
git add scripts/lib/finish.mjs scripts/deep-loop.mjs tests/finish.test.mjs tests/cli-skillface.test.mjs
git commit -m "feat(cli): finish — proof-gated completed/stopped transition (single anchor)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase B — Execution plane 스킬 (10 SKILL.md)

스킬은 LLM-facing 산문이라 단위테스트가 어렵다. 대신 **구조/트리거/언어/CLI-참조 검증**(`tests/skills.test.mjs`)을 게이트로 쓴다(핸드오프 §5.2). 각 스킬 태스크는 (a) **정확한 frontmatter**(verbatim, 3필드만), (b) **본문 콘텐츠 스펙**(반드시 포함할 섹션·지침·CLI 호출), (c) **structural test 항목**을 명세한다. 구현자는 콘텐츠 스펙을 만족하는 산문을 쓰고 test로 검증한다.

**모든 SKILL.md 공통 규약 (test가 강제):**
- frontmatter = `name`·`description`·`user-invocable` 정확히 3필드. `description`에 영어+한국어 트리거 구문 인라인.
- user-invocable 진입 스킬은 `> [!IMPORTANT]` "Skill body echo 금지" 보일러플레이트로 시작.
- 본문은 "사용자 언어를 감지해 같은 언어로 응답" 지침 포함.
- mutating 동작은 **반드시 `node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" <sub> ... --owner <run_id> --generation <n>`** CLI로. `loop.json`/`event-log.jsonl`/`.loop.hash` 직접 쓰기 지침 금지(test가 forbidden 패턴 스캔).
- "loop.json + handoff가 source of truth, 이전 대화 컨텍스트 가정 금지", "비가역 외부 행동은 proposal-only(사람 승인)", "maker/checker 분리 유지" 안전 지침 포함.

### Task 9: `tests/skills.test.mjs` 구조 검증 하네스 + `skills/deep-loop/SKILL.md` (진입)

TDD: 먼저 10개 스킬 전부에 대한 구조 검증 하네스를 쓰고(전부 실패 — 파일 없음), 이 태스크에서 진입 스킬을 구현해 그 항목을 green으로 만든다. 후속 태스크는 각자 스킬을 추가해 같은 하네스를 통과시킨다.

**Files:**
- Create: `tests/skills.test.mjs`
- Create: `skills/deep-loop/SKILL.md`

**Interfaces:**
- Consumes: `node:fs.readFileSync`, `node:fs.existsSync`.
- Produces:
  - `tests/skills.test.mjs` — `SKILLS` 매니페스트(아래) 위로 각 스킬을 검증. export 없음(테스트 파일).
  - `skills/deep-loop/SKILL.md` — 진입 스킬.

- [ ] **Step 1: Write the failing test (전체 하네스)**

`tests/skills.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = (dir) => join(ROOT, 'skills', dir, 'SKILL.md');

// 매니페스트: [dir, name, userInvocable, triggers[](영+한 둘 다 포함해야), refsCLI?(mutating이면 CLI 참조 필수)]
const SKILLS = [
  ['deep-loop', 'deep-loop', true, ['/deep-loop', '루프', 'loop engineering'], true],
  ['deep-loop-workflow', 'deep-loop-workflow', false, ['adapter', '어댑터'], false],
  ['deep-loop-discover', 'deep-loop-discover', true, ['/deep-loop-discover', 'discover', '발견'], true],
  ['deep-loop-triage', 'deep-loop-triage', true, ['/deep-loop-triage', 'triage', '분류'], true],
  ['deep-loop-continue', 'deep-loop-continue', true, ['/deep-loop-continue', 'tick', '진행', '계속'], true],
  ['deep-loop-handoff', 'deep-loop-handoff', true, ['/deep-loop-handoff', 'handoff', '인수인계'], true],
  ['deep-loop-resume', 'deep-loop-resume', true, ['/deep-loop-resume', 'resume', '이어'], true],
  ['deep-loop-status', 'deep-loop-status', true, ['/deep-loop-status', 'status', '상태'], false],
  ['deep-loop-ack', 'deep-loop-ack', true, ['/deep-loop-ack', 'ack', '검토'], true],
  ['deep-loop-finish', 'deep-loop-finish', true, ['/deep-loop-finish', 'finish', '종료'], true],
];

function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, 'frontmatter block present');
  return m[1];
}

// Codex r1 sf-4 / r2 sf-3: 2-plane 경계 강제 — durable state 에 대한 *쓰기 지침*만 잡고 읽기/언급/마크다운 인용은 허용.
// durable paths: loop.json · event-log.jsonl · .loop.hash · .deep-loop/runs.
// 셸 redirect 는 **마크다운 blockquote(줄이 '>' 로 시작)를 제외하고** 줄 단위로만 판정한다
// — '> [!IMPORTANT] loop.json + handoff are source of truth' 같은 정상 callout 오탐 방지.
function violatesBoundary(src) {
  // Codex r6 sf-3: 금지 대상은 **커널 전용 durable state 파일 3종**뿐. `.deep-loop/runs/<id>/final-report.md`
  // 같은 비-상태 artifact 쓰기는 /deep-loop-finish 가 정당하게 수행하므로 차단하지 않는다(§12·§15).
  const DUR = '(loop\\.json|event-log\\.jsonl|\\.loop\\.hash)';
  const callForms = [
    new RegExp(`(Write|Edit)\\s*\\([^)]*?${DUR}`),
    new RegExp(`(writeFileSync|appendFileSync|writeFile|appendFile)\\s*\\([^)]*?${DUR}`),
    new RegExp(`\\bsed\\s+-i\\b[^\\n]*?${DUR}`),                     // sed -i 인플레이스
    new RegExp(`\\b(perl|ruby)\\s+-[a-z]*i[a-z]*\\b[^\\n]*?${DUR}`),  // perl/ruby -i 인플레이스
    new RegExp(`open\\s*\\([^)]*${DUR}[^)]*,\\s*["'][wa]`),           // python/ruby open(..., "w"/"a")
  ];
  if (callForms.some(re => re.test(src))) return true;
  // 줄 단위(blockquote 제외): state 파일을 대상으로 하는 셸 쓰기/redirect (cp/mv/rm/truncate/dd).
  const redirect = new RegExp(`(?:>>?|\\btee\\b)\\s+\\S*${DUR}`);
  const shellWrite = new RegExp(`\\b(cp|mv|rm|truncate|install|dd)\\b[^\\n]*${DUR}`);
  return src.split('\n').some(line => {
    if (/^\s*>/.test(line)) return false;   // 마크다운 blockquote — 셸 쓰기 아님
    return redirect.test(line) || shellWrite.test(line);
  });
}

// Codex r3 sf-4: deep-loop.mjs 를 실제 호출하는 라인 중 mutating subcommand 는 --owner 와 --generation 을 **둘 다** 가져야 한다.
const MUTATING_SUB = /(state\s+patch|episode\s+(?:new|record)|workstream\s+(?:new|set|terminal)|review\s+(?:dispatch|record)|handoff\s+emit|budget\s+record|comprehension\s+ack|breaker\s+reset|lease\s+(?:acquire|release)|finish\b)/;
// Codex r5 sf-3: shorthand 명령(예: `episode record --status done`, `finish --status completed`)도 잡는다.
// "command 라인" = deep-loop.mjs 호출이거나, mutating sub 뒤에 CLI 플래그(--xxx)가 오는 경우. 순수 산문 멘션은 무시.
const MUTATING_CMD = /(?:state\s+patch|episode\s+(?:new|record)|workstream\s+(?:new|set|terminal)|review\s+(?:dispatch|record)|handoff\s+emit|budget\s+record|comprehension\s+ack|breaker\s+reset|lease\s+(?:acquire|release)|finish)\b[^\n]*\s--\w/;
function mutatingFenced(text) {
  // Codex r4 sf-2: 셸 라인 연속(\ 로 끝나는 줄)을 논리 명령으로 먼저 합친다 — multi-line unfenced 명령 회피 차단.
  const joined = text.replace(/\\\n\s*/g, ' ');
  return joined.split('\n').every(line => {
    if (!MUTATING_SUB.test(line)) return true;                       // mutating sub 언급 없음 → OK
    const isCommand = /deep-loop\.mjs/.test(line) || MUTATING_CMD.test(line);
    if (!isCommand) return true;                                     // 산문 멘션(플래그 없음) → 무시
    return /--owner\b/.test(line) && /--generation\b/.test(line);    // mutating 명령 → 두 fence flag 필수 (OR 아님)
  });
}

test('boundary scan flags forbidden write forms and allows reads/mentions/blockquotes (fixtures)', () => {
  const bad = [
    'Write({ file_path: ".deep-loop/runs/x/loop.json", content: "..." })',
    'fs.appendFileSync(".deep-loop/runs/x/event-log.jsonl", line)',
    'echo "$JSON" > .deep-loop/runs/$ID/loop.json',
    'sed -i "s/running/paused/" .deep-loop/runs/x/loop.json',
    'cp tmp .deep-loop/runs/$ID/loop.json',
    'mv tmp .deep-loop/runs/x/event-log.jsonl',
    'truncate -s 0 .deep-loop/runs/x/loop.json',
    "python -c \"open('.deep-loop/runs/x/loop.json', 'w')\"",
    'node -e "fs.writeFileSync(\'a/.loop.hash\', h)"',
  ];
  for (const s of bad) assert.ok(violatesBoundary(s), `should flag: ${s}`);
  const ok = [
    'loop.json + handoff 가 source of truth. 이전 대화 가정 금지.',
    '> [!IMPORTANT] loop.json + handoff are the source of truth.',   // blockquote 오탐 금지
    '> .deep-loop/runs/<id>/loop.json 은 커널만 쓴다.',               // blockquote path 언급 허용
    'run dir 은 .deep-loop/runs/<id>/ 이다 (커널만 씀).',             // 비-blockquote path 언급(쓰기 동사 없음) 허용
    'Write({ file_path: ".deep-loop/runs/<id>/final-report.md", content: report })',   // Codex r6 sf-3: 정당한 artifact write 허용
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field status',
    'Read .deep-loop/runs/<id>/handoffs/<ts>-next-session.md first; then /deep-loop-resume',
    'event-log.jsonl 은 커널이 appendAnchored 단일 경로로만 쓴다 (스킬은 절대 직접 쓰지 않음).',
  ];
  for (const s of ok) assert.ok(!violatesBoundary(s), `should allow: ${s}`);
});

test('mutatingFenced requires both fence flags on mutating CLI lines (fixtures)', () => {
  assert.ok(mutatingFenced('node x/deep-loop.mjs episode record --status done --owner $R --generation 1'));
  assert.ok(!mutatingFenced('node x/deep-loop.mjs episode record --status done --owner $R'));   // --generation 누락
  assert.ok(!mutatingFenced('node x/deep-loop.mjs review record --verdict APPROVE --generation 1'));   // --owner 누락
  assert.ok(mutatingFenced('node x/deep-loop.mjs next-action --json'));   // read-only → fence 불필요
  assert.ok(mutatingFenced('record the result via `episode record`'));    // 산문(플래그 없음) → 무시
  // Codex r4 sf-2: 셸 연속줄로 fence 를 분리해 회피하는 시도 차단.
  assert.ok(!mutatingFenced('node x/deep-loop.mjs \\\n  state patch --field discovered_items --value "[]"'));
  assert.ok(mutatingFenced('node x/deep-loop.mjs \\\n  state patch --field x --value "[]" --owner $R --generation 1'));
  // Codex r5 sf-3: deep-loop.mjs 프리픽스 없는 shorthand mutating 명령도 fence 필요.
  assert.ok(!mutatingFenced('episode record --status done --artifacts \'["a"]\''));   // shorthand unfenced
  assert.ok(!mutatingFenced('finish --status completed --report final-report.md'));   // shorthand unfenced
  assert.ok(mutatingFenced('episode record --status done --owner $R --generation 1'));   // shorthand fenced OK
});

for (const [dir, name, invocable, triggers, refsCLI] of SKILLS) {
  test(`skill ${dir}: exists`, () => assert.ok(existsSync(skillPath(dir)), `${dir}/SKILL.md missing`));
  test(`skill ${dir}: frontmatter has exactly name/description/user-invocable`, () => {
    const fm = frontmatter(readFileSync(skillPath(dir), 'utf8'));
    assert.match(fm, new RegExp(`name:\\s*${name}\\b`));
    assert.match(fm, new RegExp(`user-invocable:\\s*${invocable}`));
    assert.match(fm, /description:/);
    // 허용 키만 (다른 top-level 키 금지)
    const keys = fm.split('\n').filter(l => /^[a-z-]+:/.test(l)).map(l => l.split(':')[0]);
    for (const k of keys) assert.ok(['name', 'description', 'user-invocable'].includes(k), `unexpected key ${k} in ${dir}`);
  });
  test(`skill ${dir}: triggers present (en+ko)`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    for (const t of triggers) assert.ok(src.includes(t), `${dir} missing trigger "${t}"`);
  });
  test(`skill ${dir}: language-detect instruction`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.match(src, /언어|language/i);
  });
  test(`skill ${dir}: never instructs a direct durable-state write`, () => {
    assert.ok(!violatesBoundary(readFileSync(skillPath(dir), 'utf8')),
      `${dir} instructs a direct durable-state write — must route through the fenced CLI`);
  });
  if (refsCLI) {
    test(`skill ${dir}: every mutating CLI line carries both fence flags`, () => {
      const src = readFileSync(skillPath(dir), 'utf8');
      assert.match(src, /deep-loop\.mjs/, `${dir} must invoke kernel CLI`);
      // Codex r3 sf-4: --owner 와 --generation 둘 다 (OR 아님). mutating CLI 라인마다 fence 필수.
      assert.ok(mutatingFenced(src), `${dir} has a mutating deep-loop.mjs line missing --owner or --generation`);
    });
  }
  if (invocable && dir !== 'deep-loop-status') {
    test(`skill ${dir}: entry skills carry echo-suppression + safety boilerplate`, () => {
      const src = readFileSync(skillPath(dir), 'utf8');
      assert.match(src, /echo 금지|IMPORTANT/, `${dir} missing echo-suppression callout`);
      assert.match(src, /proposal-only|사람 승인|human/i, `${dir} missing external-action safety note`);
    });
  }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/skills.test.mjs`
Expected: FAIL — 모든 스킬 파일 부재.

- [ ] **Step 3: Write `skills/deep-loop/SKILL.md`**

**Frontmatter (verbatim):**

```yaml
---
name: deep-loop
description: "Loop Engineering control plane entry — starts a durable cross-plugin orchestration run over the deep-suite. Detects siblings, matches a recipe/protocol, asks the review strategy, decomposes the goal into workstreams, creates the run, and prints the next command. Triggered by '/deep-loop \"<goal>\"', 'start a loop', 'loop engineering', 'orchestrate this work', '루프 시작', '딥루프 시작', '루프 엔지니어링', cross-platform Skill({ skill: \"deep-loop:deep-loop\", args: \"<goal>\" })."
user-invocable: true
---
```

**본문 콘텐츠 스펙 (반드시 포함):**
- `> [!IMPORTANT]` "Skill body echo 금지" 보일러플레이트 + "사용자 언어 감지·동일 언어 출력" + "loop.json/handoff = source of truth, 이전 대화 가정 금지" + "비가역 외부 행동(push/PR/publish/merge/delete)은 proposal-only, 사람 승인" + "maker/checker 분리 유지".
- **Section 1 (silent state):** 진행 중 run 감지 — `node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field status` (있으면 `/deep-loop-status` 안내 후 종료, 또는 이어가기 제안).
- **Section 2 (First Action — run 시작):**
  1. `detect-plugins`로 sibling 감지(JSON 읽기).
  2. `recipe-match --goal "<goal>"`로 recipe+protocol 결정론 제안(LLM은 제안만, 확정 변경은 사람 — `recipe_override_auth=user-only`).
  3. **리뷰 전략 확인 질문(§7):** deep-review 감지 시 기본 추천 `deep-review:deep-review-loop --contract --codex`(cross-model); 미감지 시 codex 2-way / 서브에이전트 checker / standalone 제안 → 사용자 확정. 결과를 `review` JSON으로 조립. 상세: `Read("../deep-loop-workflow/references/review-strategy.md")`.
  4. **workstream 분해(§8):** 큰 goal이면 N개 workstream(=PR) 제안 후 사람 확인("[이대로/조정/단일 PR로]"), 작은 작업이면 1 workstream 자동.
  5. **run 생성:** `init-run --goal "<goal>" --protocol <p> --recipe <recipe-id> --review '<json>'` → `run_id` 회수. **`--recipe` 는 `recipe-match` 가 준 recipe **id 문자열**(예: `robust-implementation`)이다 — JSON 아님(Codex r4 sf-3: CLI 가 f.recipe 를 id/name 으로 저장). `--review` 만 JSON.** 이후 모든 mutating은 `--owner <run_id> --generation 1`.
  6. workstream 생성: `workstream new --title ... --branch ... --worktree ... [--depends-on '<json>'] --owner <run_id> --generation 1`.
  7. 첫 episode: `episode new --plugin <maker> --role maker --kind <k> --point <design|plan|implementation> --workstream <ws> --artifacts '<json: expected output paths>' --owner ... --generation 1`. **`--artifacts` 필수** (Codex r3 sf-2): maker `done` 전이는 비어있지 않은 expected_artifacts + 그 파일들의 실제 존재를 요구한다(episode.mjs). expected 경로는 protocol read 디스크립터(`adapter resolve` 의 `read.path`) 또는 계획된 산출물에서 도출.
- **Section 3 (완료 메시지):** 다음 명령(`/deep-loop-continue`) 안내 + run_id + workstream 요약.

- [ ] **Step 4: Run to verify the entry skill passes its harness rows**

Run: `node --test tests/skills.test.mjs 2>&1 | grep "deep-loop:"`
Expected: `deep-loop` 행 PASS(나머지 스킬은 아직 부재로 FAIL — 정상, 후속 태스크에서 채움).

- [ ] **Step 5: Commit**

```bash
git add tests/skills.test.mjs skills/deep-loop/SKILL.md
git commit -m "feat(skills): SKILL structural harness + deep-loop entry skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 10: `skills/deep-loop-workflow/SKILL.md` + `references/*.md` (비공개 4-verb 로직)

비공개(user-invocable:false) 무거운 로직 — 어댑터 4-verb 수행법, 리뷰 전략, handoff/respawn 호출법. 다른 스킬이 `Read()`로 참조.

**Files:**
- Create: `skills/deep-loop-workflow/SKILL.md`
- Create: `skills/deep-loop-workflow/references/adapters.md`
- Create: `skills/deep-loop-workflow/references/review-strategy.md`
- Create: `skills/deep-loop-workflow/references/handoff-respawn.md`

**Frontmatter (verbatim):**

```yaml
---
name: deep-loop-workflow
description: |
  deep-loop 비공개 코어 워크플로우 — 프로토콜 adapter 4-verb(dispatch/awaitResult/checker/readArtifacts) 수행법,
  리뷰 전략 조립, 자율 handoff/respawn 호출 규약을 정의한다. deep-loop 진입·continue 스킬이 references로 로드한다.
user-invocable: false
---
```

**본문 + references 콘텐츠 스펙:**
- `SKILL.md`: 4-verb 개요 + 각 verb를 **Execution LLM이** 수행하는 방식(커널은 호출 안 함, §1.1) + references 인덱스 + "사용자 언어 감지" 지침.
- `references/adapters.md`:
  - **dispatch:** **`adapter resolve --protocol <p> --task "<brief>" --tier <gate.tier_after>`** (Codex r5 sf-1: `--tier` 를 **반드시** `next-action` 의 `gate.tier_after` 로 전달 — 빠지면 guard 가 `no-tier` no-op 라 read-only run 이 implementer 를 dispatch 한다). 디스크립터(`{dispatch,await,read,checker_via,guard}`)에서 `guard.ok===false`면 **dispatch 중단**(tier×protocol 모순 → `await_human`). 통과 시 `dispatch.kind==='invoke_skill'`이면 `Skill({skill, args})`로 sibling invoke(superpowers 는 `dispatch.skill`=`writing-plans` 만; **read-only tier 면 `then` implementer(`subagent-driven-development`) 단계는 건너뛴다** — 계획-only 허용, 구현 dispatch 금지), `kind==='inline'`이면 직접 도구 사용.
  - **awaitResult:** 디스크립터의 `await.kind`가 `poll_file`이면 그 경로(`path_template` 채워진)를 `done_when` 만족까지 폴링(LLM/드라이버가 수행). deep-work는 `.deep-work/<task>/session-receipt.json`의 `current_phase=idle`.
  - **checker:** `review dispatch --point <p> --workstream <ws> --owner --generation`로 checker episode + 디스크립터 생성 → 그 reviewer 스킬을 invoke → verdict를 `review record --episode <id> --workstream <ws> --point <p> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --owner --generation`로 기록(커널이 터미널·breaker·comprehension 파생).
  - **readArtifacts:** sibling receipt 경로 + 식별 가드(§10). 불일치 시 throw 금지 → null + 경고.
- `references/review-strategy.md`: §7 확인 질문 흐름, deep-review 유/무 분기, `review` JSON 형태(`points`/`reviewer`/`mode`/`flags`/`converge`/`max_review_rounds`/`require_human_ack`).
- `references/handoff-respawn.md`: §9 호출자 3종, `handoff emit` → (interactive: `terminal/launch-command.txt`를 사람에게 제시 / headless: 드라이버가 respawn). respawn 게이트 순서. "미감시 자율은 headless 강제". **비용 회계 모델(Codex r5 critical-2):** 진짜 무인 장기 실행의 하드 강제는 **drive-headless 드라이버**가 측정 usage 를 `budget record` 로 권위있게 커밋(단일 출처). PreCompact respawn 은 *세션 연속을 위한 안전망*이라 spawnFn 의 measured usage 를 기록하지 않고 버린다 — 인수한 **자식 세션이 자기 drive 사이클(drive-headless 또는 interactive tick)에서 자기 비용을 회계**한다(이중계상 방지).

**structural test:** Task 9 하네스의 `deep-loop-workflow` 행(user-invocable:false, triggers `adapter`/`어댑터`). 추가로 references 3파일 `existsSync` 검증을 하네스에 inline(아래 Step 1).

- [ ] **Step 1: Extend the harness with references existence**

`tests/skills.test.mjs` 끝에:

```javascript
test('deep-loop-workflow references exist', () => {
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md'])
    assert.ok(existsSync(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r)), `missing reference ${r}`);
});

// Codex r3 sf-4: SKILL.md + workflow references 의 *모든* mutating CLI 라인이 fence(--owner+--generation)를 갖는지 전역 검사.
// deep-loop-workflow 는 references 에 review dispatch/record(mutating)를 담으므로 여기서 함께 검증된다.
test('all skills + workflow references fence every mutating CLI line', () => {
  const files = SKILLS.map(([dir]) => skillPath(dir));
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md'])
    files.push(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r));
  for (const f of files) {
    if (!existsSync(f)) continue;
    assert.ok(mutatingFenced(readFileSync(f, 'utf8')), `${f} has an unfenced mutating CLI invocation`);
  }
});
```

- [ ] **Step 2: Run to verify fail** — `node --test tests/skills.test.mjs` → workflow 행 + references FAIL.
- [ ] **Step 3: Write the SKILL.md + 3 references** (콘텐츠 스펙대로).
- [ ] **Step 4: Run to verify pass** — workflow 행 + references PASS.
- [ ] **Step 5: Commit**

```bash
git add skills/deep-loop-workflow tests/skills.test.mjs
git commit -m "feat(skills): deep-loop-workflow — adapter 4-verb + review/handoff references

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 11: `skills/deep-loop-continue/SKILL.md` (메인 tick)

가장 무거운 스킬. 1 tick = 게이트검사 → `next-action` 읽기 → dispatch/record → Decide → 필요 시 handoff+respawn.

**Files:**
- Create: `skills/deep-loop-continue/SKILL.md`

**Frontmatter (verbatim):**

```yaml
---
name: deep-loop-continue
description: "deep-loop main tick — advances the loop one step: checks budget/breaker/comprehension gates, reads next-action, dispatches the maker or checker, records the outcome, decides whether to hand off, and pre-emptively respawns at a milestone or per-session turn cap. Triggered by '/deep-loop-continue', 'continue the loop', 'advance the loop', 'next tick', '루프 진행', '루프 계속', '다음 tick', '계속 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-continue\" })."
user-invocable: true
---
```

**본문 콘텐츠 스펙 (스펙 §9 `/deep-loop-continue 1 tick` 그대로):**
- echo 금지 + 안전 보일러플레이트 + 언어감지.
- 0. run_id/generation 확보: `state get --field session_chain.lease`로 owner/generation 읽기(현재 세션이 owner인지 확인; 아니면 `/deep-loop-resume` 안내).
- 1. **게이트(항상 먼저):** `next-action --json`. `gate.allowed===false`거나 `action.type ∈ {handoff, await_human}`면: budget/breaker면 `handoff emit` + 사람 호출 후 종료; breaker면 `/deep-loop-status`로 사람 reset(`breaker reset --confirm --owner <run_id> --generation <n>`) 안내. (continue tick 은 autonomous 라 스스로 `--confirm` 을 주지 않는다 — breaker 해제는 사람 전용.)
- 2. **action 분기(next-action이 반환한 `action.type`대로, 스스로 판단 추가 금지):**
  - `discover` → `/deep-loop-discover` 안내(또는 invoke).
  - `dispatch_maker` → **`adapter resolve --protocol <p> --task "<brief>" --tier <gate.tier_after>`** (Codex r5 sf-1: `next-action` 의 `gate.tier_after` 를 **반드시** 전달 — `--tier` 없으면 guard 가 no-op 라 read-only run 이 implementer 를 dispatch 할 수 있다). **`guard.ok===false` 면 dispatch 중단** → `await_human`(tier×protocol 모순) 안내. 통과 시 디스크립터(+`read.path`로 expected artifacts 도출) → `episode record --status in_progress --owner <run_id> --generation <n>` → sibling `Skill()` invoke → 완료 후 `episode record --status done --artifacts '<json>' --proof '<json>' --owner <run_id> --generation <n>`.
  - `dispatch_checker` → `review dispatch --point <p> --workstream <ws> --owner <run_id> --generation <n>` → reviewer invoke → `review record --episode <id> --workstream <ws> --point <p> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --owner <run_id> --generation <n>`.
  - `fix_episode` → fix maker episode 생성(`episode new --kind fix --artifacts '<json: expected 산출물>' --owner <run_id> --generation <n>`, fix 도 maker 라 expected_artifacts 필수) 후 dispatch.
  - `await_result` → 폴링.
  - `finish` → `/deep-loop-finish` 안내.
- 3. **record:** 각 단계 후 CLI로 기록(위). **비용 기록(Codex r5 sf-2):** interactive tick 은 best-effort 로 `budget record --turns <n> --owner <run_id> --generation <n>` 자기보고(per_session_turn_cap 구동). **headless 구동(`DEEP_LOOP_UNATTENDED` set)에서는 자기보고를 생략** — drive-headless 드라이버가 측정 usage 를 권위있게 기록하므로 이중계상 방지.
- 4. **Decide:** 마일스톤(`milestone_predicate`) 통과 or `per_session_turn_cap` 도달이면 `handoff emit --owner <run_id> --generation <n>` + respawn(드라이버/사람). 아니면 다음 episode 안내.
- **mutating CLI 예시는 전부 `--owner <run_id> --generation <n>` 를 인라인 포함한다**(structural test `mutatingFenced` 가 강제). 비가역 외부행동 proposal-only.

- [ ] **Step 1~2:** 하네스 `deep-loop-continue` 행 RED 확인.
- [ ] **Step 3:** SKILL.md 작성.
- [ ] **Step 4:** `node --test tests/skills.test.mjs 2>&1 | grep continue` PASS.
- [ ] **Step 5: Commit**

```bash
git add skills/deep-loop-continue/SKILL.md
git commit -m "feat(skills): deep-loop-continue — main tick (gate→dispatch→record→decide→handoff)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 12: `skills/deep-loop-discover` + `skills/deep-loop-triage`

**Files:** Create `skills/deep-loop-discover/SKILL.md`, `skills/deep-loop-triage/SKILL.md`.

**deep-loop-discover frontmatter (verbatim):**

```yaml
---
name: deep-loop-discover
description: "deep-loop manual discovery heartbeat — surveys the repo, git state, sibling artifacts, and existing loop state to find candidate work items, then persists them. Triggered by '/deep-loop-discover', 'discover work', 'find next work', 'what should I do next', '할 일 발견', '작업 발견', '다음 할 일 찾기', cross-platform Skill({ skill: \"deep-loop:deep-loop-discover\" })."
user-invocable: true
---
```

**deep-loop-discover 콘텐츠 스펙:** echo 금지 + 언어감지 + 안전. repo/git/sibling artifact/기존 state 스캔 → 후보 목록 → `state patch --field discovered_items --value '<json>' --owner --generation`로 영속. comprehension debt(`comprehension status`)이 임계 초과면 새 fan-out 자제(사람 검토 먼저).

**deep-loop-triage frontmatter (verbatim):**

```yaml
---
name: deep-loop-triage
description: "deep-loop triage — classifies discovered candidates into actionable / needs_human / blocked / archived. Triggered by '/deep-loop-triage', 'triage work', 'classify candidates', '작업 분류', '후보 분류', '트리아지', cross-platform Skill({ skill: \"deep-loop:deep-loop-triage\" })."
user-invocable: true
---
```

**deep-loop-triage 콘텐츠 스펙:** echo 금지 + 언어감지 + 안전. `state get --field discovered_items` → 분류 → `state patch --field triage.actionable|needs_human|blocked|archived --value '<json>' --owner --generation`. actionable 항목은 `/deep-loop` 분해/`episode new`로 이어짐 안내.

- [ ] **Step 1~2:** 하네스 두 행 RED.
- [ ] **Step 3:** 두 SKILL.md 작성.
- [ ] **Step 4:** `node --test tests/skills.test.mjs 2>&1 | grep -E "discover|triage"` PASS.
- [ ] **Step 5: Commit**

```bash
git add skills/deep-loop-discover/SKILL.md skills/deep-loop-triage/SKILL.md
git commit -m "feat(skills): deep-loop-discover + deep-loop-triage (state patch persistence)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 13: `skills/deep-loop-handoff` + `skills/deep-loop-resume`

**Files:** Create `skills/deep-loop-handoff/SKILL.md`, `skills/deep-loop-resume/SKILL.md`.

**deep-loop-handoff frontmatter (verbatim):**

```yaml
---
name: deep-loop-handoff
description: "deep-loop manual handoff — escape hatch to emit a clean handoff (and optionally respawn) without waiting for a milestone. Triggered by '/deep-loop-handoff', 'hand off now', 'emit handoff', 'pass to a fresh session', '핸드오프', '인수인계', '새 세션으로 넘기기', cross-platform Skill({ skill: \"deep-loop:deep-loop-handoff\" })."
user-invocable: true
---
```

**deep-loop-handoff 콘텐츠 스펙:** echo 금지 + 언어감지 + 안전. `handoff emit [--reason <r>] [--headless] --owner --generation` → 산출(handoff.md/compaction-state/launch-command). interactive면 `terminal/launch-command.txt`(state get으로 경로 확인)를 사람에게 제시. headless/미감시면 드라이버 respawn 안내(자동 spawn은 드라이버만, §9). respawn 게이트 차단 시 paused + 수동 resume 안내.

**deep-loop-resume frontmatter (verbatim):**

```yaml
---
name: deep-loop-resume
description: "deep-loop resume — entry point for a respawned fresh session: reads only the handoff.md and loop.json, acquires the session lease, attaches active worktrees, and continues. Triggered by '/deep-loop-resume', 'resume the loop', 'take over the session', 'continue handed-off work', '루프 이어가기', '세션 인수', '이어서 진행', cross-platform Skill({ skill: \"deep-loop:deep-loop-resume\" })."
user-invocable: true
---
```

**deep-loop-resume 콘텐츠 스펙:** echo 금지 + 언어감지 + 안전. **handoff.md + loop.json만 읽음(이전 대화 가정 금지).** `state get`으로 최신 handoff child run_id 확인 → `lease acquire --owner <childRunId> --generation <expected> --expect-generation <n>`로 lease CAS 인수(generation+1). active workstream worktree 경로 무결성 확인(경로 소실 시 조용히 재생성 ❌ → needs-human). 그 후 `/deep-loop-continue` 안내.

- [ ] **Step 1~2:** 하네스 두 행 RED.
- [ ] **Step 3:** 두 SKILL.md 작성.
- [ ] **Step 4:** `node --test tests/skills.test.mjs 2>&1 | grep -E "handoff|resume"` PASS.
- [ ] **Step 5: Commit**

```bash
git add skills/deep-loop-handoff/SKILL.md skills/deep-loop-resume/SKILL.md
git commit -m "feat(skills): deep-loop-handoff + deep-loop-resume (lease handoff/takeover)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 14: `skills/deep-loop-status` + `skills/deep-loop-ack`

**Files:** Create `skills/deep-loop-status/SKILL.md`, `skills/deep-loop-ack/SKILL.md`.

**deep-loop-status frontmatter (verbatim):**

```yaml
---
name: deep-loop-status
description: "deep-loop status — shows the current run's status, budget, comprehension debt, circuit breaker, pending human reviews, session chain, and workstreams. Read-only. Triggered by '/deep-loop-status', 'loop status', 'show the loop', 'where are we', '루프 상태', '상태 보기', '진행 상황', cross-platform Skill({ skill: \"deep-loop:deep-loop-status\" })."
user-invocable: true
---
```

**deep-loop-status 콘텐츠 스펙:** 언어감지 + 안전. **read-only**(echo 금지 보일러플레이트 면제 — Task 9 하네스가 status는 제외). `state get`, `budget check`, `comprehension status`, `breaker check`로 표시: status·예산(turns/tokens)·debt_ratio·breaker(tripped면 `breaker reset --confirm --owner <run_id> --generation <n>` 안내 — 사람 + lease-owner 전용)·미검토 episode·session_chain·workstream 표. 사람이 막힌 지점을 알 수 있게 다음 명령 제안.

**deep-loop-ack frontmatter (verbatim):**

```yaml
---
name: deep-loop-ack
description: "deep-loop acknowledge — marks an episode/diff as human-reviewed, reducing comprehension debt so the loop can fan out new work. Triggered by '/deep-loop-ack', 'ack the review', 'mark reviewed', 'I reviewed it', '검토 완료', '리뷰 확인', '이해 표시', cross-platform Skill({ skill: \"deep-loop:deep-loop-ack\" })."
user-invocable: true
---
```

**deep-loop-ack 콘텐츠 스펙:** echo 금지 + 언어감지 + 안전. 사람이 검토한 episode를 `comprehension ack --episode <id> --owner --generation`로 표시 → debt_ratio 갱신 보고. (deep-review APPROVE는 설정에 따라 자동 카운트; `require_human_ack=true`면 이 스킬만 인정.)

- [ ] **Step 1~2:** 하네스 두 행 RED.
- [ ] **Step 3:** 두 SKILL.md 작성.
- [ ] **Step 4:** `node --test tests/skills.test.mjs 2>&1 | grep -E "status|ack"` PASS.
- [ ] **Step 5: Commit**

```bash
git add skills/deep-loop-status/SKILL.md skills/deep-loop-ack/SKILL.md
git commit -m "feat(skills): deep-loop-status (read-only) + deep-loop-ack (comprehension)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 15: `skills/deep-loop-finish/SKILL.md`

**Files:** Create `skills/deep-loop-finish/SKILL.md`.

**Frontmatter (verbatim):**

```yaml
---
name: deep-loop-finish
description: "deep-loop finish — end-of-work: writes the final report, then transitions the run to completed (proof-gated) or stopped, and delegates to deep-memory / deep-wiki when installed. Triggered by '/deep-loop-finish', 'finish the loop', 'wrap up', 'end the run', '루프 종료', '작업 마무리', '런 종료', cross-platform Skill({ skill: \"deep-loop:deep-loop-finish\" })."
user-invocable: true
---
```

**본문 콘텐츠 스펙 (스펙 §12):**
- echo 금지 + 언어감지 + 안전("artifacts 삭제 ❌").
- 1. **final-report.md 작성:** `runDir/final-report.md`(생성 repo/파일/명령/원칙반영/maker-checker/worktree/heartbeat/검증결과/통합여부/남은 TODO/사용 예시/다음 명령/사람 검증 체크리스트). deep-loop 자체 산출이라 `<project-root>/.deep-loop/runs/<id>/` 하위 — root 밖 금지.
- 2. **finish 전이:** `finish --status completed --report final-report.md --proof '<json>' --owner --generation` (proof 미충족이면 `FINISH_PROOF_UNMET` → 무엇이 빠졌는지 보고 후 사람 결정; `stopped`는 `--proof '{"human_reason":"..."}'`).
- 3. **deep-memory 감지 시:** `Skill({skill:"deep-memory:deep-memory-harvest"})` + 핵심 결정 `deep_memory_save`(local) — **각 플러그인 자체 스킬에 위임**(deep-loop이 `~/.deep-memory` 직접 쓰지 않음).
- 4. **deep-wiki 감지 시:** `Skill({skill:"deep-wiki:wiki-ingest", args:"<final-report 경로>"})`.
- 5. 미감지 → 스킵, 로그 명시.

- [ ] **Step 1~2:** 하네스 `deep-loop-finish` 행 RED.
- [ ] **Step 3:** SKILL.md 작성.
- [ ] **Step 4: Run full skills harness** — `node --test tests/skills.test.mjs` 전부 PASS(10 스킬 완성).
- [ ] **Step 5: Run full suite + commit**

Run: `npm test` → 0 fail.

```bash
git add skills/deep-loop-finish/SKILL.md
git commit -m "feat(skills): deep-loop-finish — final report + proof-gated finish + memory/wiki delegation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — PreCompact hook + headless spawn 드라이버

`respawn`의 `spawnFn` 미배선 지점(`defaultSpawn`은 `SPAWN_NOT_WIRED` throw)을 Plan 3가 채운다. headless 자율 모드(§9)에서만 커널이 실제 `claude -p` 프로세스를 spawn — Node가 에이전트를 실행하는 유일한 지점(함수 호출 아님, 프로세스 경계).

### Task 16: `scripts/lib/spawn-driver.mjs` — `headlessSpawn` (timeout + usage 파싱 + fail-closed)

`respawn`에 주입할 `spawnFn`. `cmd`(= `buildLaunchCommand`가 만든 `claude -p ...` 셸 문자열)를 child_process로 실행, timeout 강제, usage 파싱. **측정 불가 시 fail-closed**(`{ok:false}` 반환 → respawn이 실패모드 B로 lease를 부모로 롤백, 트랩 F7).

**Files:**
- Modify: `scripts/lib/handoff.mjs` (`buildLaunchCommand` headless 변형에 `--output-format json`)
- Create: `scripts/lib/spawn-driver.mjs`
- Test: `tests/spawn-driver.test.mjs`, `tests/handoff.test.mjs` (headless 명령 검증)

**Interfaces:**
- Consumes: `node:child_process.spawnSync`(기본 runner; 테스트는 주입).
- Produces:
  - `handoff.buildLaunchCommand` — 변경: headless 변형을 `claude -p "<resume>" --output-format json --permission-mode acceptEdits` 로(Codex r6 sf-4). `--output-format json` 이 없으면 `claude -p` 가 num_turns/usage 를 stdout 으로 내보내지 않아 `headlessSpawn`/`driveHeadless` 가 항상 측정불가(fail-closed)로 멈춘다. interactive 변형은 변경 없음.
  - `spawn-driver.headlessSpawn(cmd, { timeoutMs = 1800000, run = defaultRun } = {})` → `{ ok:true, usage } | { ok:false, reason }`. `run(cmd,{timeoutMs}) → {code, stdout, stderr, timedOut}`. timeout/non-zero exit/usage 측정불가는 전부 `ok:false`.
  - `spawn-driver.parseUsage(stdout)` → `{num_turns?, tokens?} | null` (claude `-p --output-format json` 의 `num_turns`/`usage` 파싱; 없으면 `null`).
  - `spawn-driver.defaultRun(cmd, {timeoutMs})` → `spawnSync('bash', ['-c', cmd], {timeout})` 래핑.

- [ ] **Step 0: `buildLaunchCommand` headless 에 `--output-format json` (lib + 테스트)**

`scripts/lib/handoff.mjs:14` 의 `headlessCmd` 를 교체:

```javascript
  const headlessCmd = `cd ${root} && claude -p "${resumePrompt}" --output-format json --permission-mode acceptEdits`;
```

`tests/handoff.test.mjs` 에 추가:

```javascript
test('buildLaunchCommand headless requests metric-bearing output', () => {
  const cmds = buildLaunchCommand({ root: '/r', parentRunId: 'p', childRunId: 'c', handoffRel: 'handoffs/x.md', headless: true });
  assert.match(cmds.headless, /--output-format json/);
  assert.match(cmds.interactive, /--output-format json/);   // headless=true 면 interactive 필드도 headless 명령
});
```

- [ ] **Step 1: Write the failing test**

`tests/spawn-driver.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlessSpawn, parseUsage } from '../scripts/lib/spawn-driver.mjs';

const okRun = () => ({ code: 0, stdout: '{"num_turns":3,"usage":{"input_tokens":10}}', stderr: '', timedOut: false });
const timeoutRun = () => ({ code: null, stdout: '', stderr: '', timedOut: true });
const unmeasurableRun = () => ({ code: 0, stdout: 'done, no usage here', stderr: '', timedOut: false });
const costOnlyRun = () => ({ code: 0, stdout: '{"total_cost_usd":0.12}', stderr: '', timedOut: false });   // Codex r2 sf-4

test('headlessSpawn ok when usage measurable', () => {
  const r = headlessSpawn('claude -p x', { run: okRun });
  assert.equal(r.ok, true);
  assert.ok(Number.isFinite(r.usage.num_turns) || Number.isFinite(r.usage.tokens));
});

test('headlessSpawn fail-closed on timeout', () => {
  const r = headlessSpawn('claude -p x', { run: timeoutRun });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'timeout');
});

test('headlessSpawn fail-closed when usage unmeasurable', () => {
  const r = headlessSpawn('claude -p x', { run: unmeasurableRun });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unmeasurable/);
});

// Codex r2 sf-4: cost-only JSON 에는 enforceable metric(turns/tokens)이 없으므로 fail-closed.
test('headlessSpawn fail-closed when only total_cost_usd is present', () => {
  const r = headlessSpawn('claude -p x', { run: costOnlyRun });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unmeasurable/);
});

test('parseUsage requires a finite enforceable metric', () => {
  assert.equal(parseUsage('{"num_turns":2}').num_turns, 2);
  assert.ok(parseUsage('{"usage":{"input_tokens":5,"output_tokens":7}}').tokens === 12);
  assert.equal(parseUsage('{"total_cost_usd":0.12}'), null);   // cost-only → 측정 불가
  assert.equal(parseUsage('nothing'), null);
});
```

- [ ] **Step 2: Run to verify fail** — `node --test tests/spawn-driver.test.mjs` → module 없음.

- [ ] **Step 3: Write `scripts/lib/spawn-driver.mjs`**

```javascript
import { spawnSync } from 'node:child_process';

// Codex r2 sf-4: budget 을 강제하려면 enforceable metric(turns 또는 tokens)이 최소 1개 finite 여야 한다.
// total_cost_usd 만 있는 출력은 turns/tokens 로 budget 게이트를 못 거니 측정 불가(null) → fail-closed.
export function parseUsage(stdout) {
  const s = String(stdout || '');
  let turns = null, tokens = null;
  try {
    const j = JSON.parse(s);
    if (j) {
      if (Number.isFinite(j.num_turns)) turns = j.num_turns;
      const inT = j.usage?.input_tokens, outT = j.usage?.output_tokens;
      if (Number.isFinite(inT) || Number.isFinite(outT)) tokens = (Number.isFinite(inT) ? inT : 0) + (Number.isFinite(outT) ? outT : 0);
    }
  } catch { /* not json */ }
  if (turns == null) { const m = s.match(/"(?:num_turns|turns)"\s*:\s*(\d+)/); if (m) turns = Number(m[1]); }
  if (!Number.isFinite(turns) && !Number.isFinite(tokens)) return null;   // 측정 불가 → fail-closed
  return { num_turns: turns, tokens };
}

export function defaultRun(cmd, { timeoutMs }) {
  const r = spawnSync('bash', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  const timedOut = r.error && (r.error.code === 'ETIMEDOUT' || r.signal === 'SIGTERM');
  return { code: r.status ?? null, stdout: r.stdout || '', stderr: r.stderr || '', timedOut: !!timedOut };
}

// respawn 의 spawnFn 계약: {ok:true} | throw/{ok:false,reason}. fail-closed = ok:false (respawn 실패모드 B 롤백).
export function headlessSpawn(cmd, { timeoutMs = 30 * 60 * 1000, run = defaultRun } = {}) {
  let out;
  try { out = run(cmd, { timeoutMs }); } catch (e) { return { ok: false, reason: `spawn-error: ${e.message || e}` }; }
  if (out.timedOut) return { ok: false, reason: 'timeout' };
  if (out.code !== 0) return { ok: false, reason: `exit-${out.code}` };
  const usage = parseUsage(out.stdout);
  if (usage == null) return { ok: false, reason: 'unmeasurable-fail-closed' };   // 트랩 F7
  return { ok: true, usage };
}
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/spawn-driver.test.mjs` PASS (4 tests).
- [ ] **Step 5: Commit**

```bash
git add scripts/lib/spawn-driver.mjs tests/spawn-driver.test.mjs
git commit -m "feat(driver): headlessSpawn — child_process spawnFn with timeout + fail-closed usage gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 17: `scripts/hooks-impl/precompact-handoff.mjs` — emit + 조건부 respawn

PreCompact hook의 Node 구현. 현재 run을 찾아 `handoff emit`(+ headless/미감시면 `respawn`에 `headlessSpawn` 주입). best-effort — compaction을 절대 막지 않음(항상 exit 0). hook glue는 lib import 허용(핸드오프 §3).

**Files:**
- Create: `scripts/hooks-impl/precompact-handoff.mjs`
- Test: `tests/precompact-hook.test.mjs`

**Interfaces:**
- Consumes: `state.readState`, `handoff.emitHandoff`, `respawn.respawn`/`respawnGate`, `spawn-driver.headlessSpawn`, `detect`(unattended 판단), `node:fs`(`.deep-loop/current` 읽기).
- Produces:
  - `precompact-handoff.runPreCompactHandoff(input, { root, spawnFn = headlessSpawn, now = Date.now() })` → `{ ok, action: 'emitted'|'respawned'|'gate-blocked'|'respawn-failed'|'no-run'|'fenced'|'error', childRunId? }`.
    - `.deep-loop/current` 없으면 `{ok:true, action:'no-run'}`(no-op).
    - `readState` → lease owner/generation. headless 판단: `input.unattended === true` 또는 `loop.autonomy.spawn_style==='headless'` 또는 비-tty(`input.tty===false`).
    - `emitHandoff(root, runId, { reason:'pre-compact', trigger:'pre-compact', headless, expect:{owner,generation} })`.
    - **게이트를 외부에서 선검사하지 않는다 (Codex r2 sf-5).** `headless && loop.autonomy.auto_handoff` 이면 **항상** `respawn(root, runId, { childRunId, key, handoffRel, headless:true, now, spawnFn })`를 호출한다. canonical 게이트 평가와 차단 시 `status=paused` 기록은 **`respawn` 내부**(실패모드 A, respawn.mjs:44-58)에서 일어난다 → `rr.outcome==='gate-blocked'`면 `action:'gate-blocked'`(paused), 성공이면 `'respawned'`, 그 외 실패는 `'respawn-failed'`. interactive(비-headless)면 spawn 없이 `action:'emitted'`(사람 수동 resume).
  - CLI 진입(파일 하단): stdin JSON 파싱 → `runPreCompactHandoff` → 항상 `process.exit(0)`(에러 삼킴, best-effort).

- [ ] **Step 1: Write the failing test**

`tests/precompact-hook.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { runPreCompactHandoff } from '../scripts/hooks-impl/precompact-handoff.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('no current run → no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-pc0-'));
  const r = await runPreCompactHandoff({}, { root, now: Date.parse('2026-06-24T00:01:00Z') });
  assert.equal(r.action, 'no-run');
});

test('interactive → emits handoff, no spawn', async () => {
  const { root } = seed();
  let spawned = false;
  const r = await runPreCompactHandoff({ tty: true }, { root, now: Date.parse('2026-06-24T00:01:00Z'), spawnFn: () => { spawned = true; return { ok: true }; } });
  assert.equal(r.action, 'emitted');
  assert.equal(spawned, false);
});

test('unattended → emits + respawns with injected spawnFn', async () => {
  const { root } = seed();
  let spawnedCmd = null;
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-06-24T00:01:00Z'), spawnFn: (cmd) => { spawnedCmd = cmd; return { ok: true }; } });
  assert.equal(r.action, 'respawned');
  assert.match(spawnedCmd, /claude -p/);
  assert.match(spawnedCmd, /--output-format json/);   // Codex r6 sf-4: 측정 가능한 출력 요청
});

// Codex r1 should-fix-3: gate 차단(wallclock 소진) headless PreCompact 는 spawn 하지 않고 status=paused.
test('unattended but gate-blocked → no spawn, run paused', async () => {
  const { root, runId } = seed();
  let spawned = false;
  // created_at=2026-06-24 + now 한참 뒤 → wallclock(max 86400s) 초과 → respawnGate 차단.
  const r = await runPreCompactHandoff({ unattended: true }, { root, now: Date.parse('2026-07-01T00:00:00Z'), spawnFn: () => { spawned = true; return { ok: true }; } });
  assert.equal(spawned, false);
  assert.equal(r.action, 'gate-blocked');
  const { readState } = await import('../scripts/lib/state.mjs');
  assert.equal(readState(root, runId).data.status, 'paused');
});
```

- [ ] **Step 2: Run to verify fail** — module 없음.

- [ ] **Step 3: Write `scripts/hooks-impl/precompact-handoff.mjs`**

```javascript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState } from '../lib/state.mjs';
import { emitHandoff } from '../lib/handoff.mjs';
import { respawn } from '../lib/respawn.mjs';
import { headlessSpawn } from '../lib/spawn-driver.mjs';

function currentRunId(root) {
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

export async function runPreCompactHandoff(input = {}, { root = process.cwd(), spawnFn = headlessSpawn, now = Date.now() } = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };
  let loop;
  try { ({ data: loop } = readState(root, runId)); } catch (e) { return { ok: false, action: 'error', reason: String(e.message || e) }; }
  const lease = loop.session_chain?.lease || {};
  const expect = { owner: lease.owner_run_id, generation: lease.generation };
  const headless = input.unattended === true || loop.autonomy?.spawn_style === 'headless' || input.tty === false;
  const em = emitHandoff(root, runId, { reason: 'pre-compact', trigger: 'pre-compact', headless, expect });
  if (!em.ok) return { ok: false, action: 'fenced', reason: em.reason };
  // Codex r1 should-fix-3: 외부에서 게이트를 선검사하지 않는다. headless && auto_handoff 면 **항상** respawn 을 호출해
  // respawn 내부의 canonical 실패모드 A 경로(gate 차단 시 status=paused 기록)를 타게 한다. 선검사하면 budget/wallclock
  // 소진된 headless PreCompact 가 releasing handoff 만 남기고 paused 를 못 박는다(spec §9.1).
  if (headless && loop.autonomy?.auto_handoff) {
    const rr = respawn(root, runId, { childRunId: em.childRunId, key: em.key, handoffRel: em.handoffRel, headless: true, now, spawnFn });
    const action = rr.ok ? 'respawned' : (rr.outcome === 'gate-blocked' ? 'gate-blocked' : 'respawn-failed');
    return { ok: rr.ok, action, childRunId: em.childRunId, outcome: rr.outcome };
  }
  return { ok: true, action: 'emitted', childRunId: em.childRunId };   // interactive → 사람 수동 resume
}

// CLI 진입 — best-effort, 절대 compaction 차단 안 함.
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    let input = {};
    try {
      const chunks = []; for await (const c of process.stdin) chunks.push(c);
      if (chunks.length) input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { /* ignore */ }
    try { await runPreCompactHandoff(input, { root: input.cwd || process.cwd() }); } catch { /* swallow */ }
    process.exit(0);
  })();
}
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/precompact-hook.test.mjs` PASS (3 tests).
- [ ] **Step 5: Commit**

```bash
git add scripts/hooks-impl/precompact-handoff.mjs tests/precompact-hook.test.mjs
git commit -m "feat(hook): precompact-handoff impl — emit + conditional headless respawn (best-effort)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 18: `hooks/scripts/precompact-handoff.sh` (Bash 3.2) + `hooks/hooks.json`

PreCompact 이벤트 → bash 래퍼 → `.mjs`. Bash 3.2 호환(`set -Eeuo pipefail`, `declare -A`/`${var,,}` 금지). hook은 stdin JSON을 그대로 `.mjs`에 파이프.

**Files:**
- Create: `hooks/scripts/precompact-handoff.sh`
- Create: `hooks/hooks.json`
- Test: `tests/precompact-hook.test.mjs` (구조 검증 추가)

**Interfaces:**
- Produces:
  - `hooks/hooks.json` — `{ "description": "...", "hooks": { "PreCompact": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/precompact-handoff.sh" } ] } ] } }`.
  - `hooks/scripts/precompact-handoff.sh` — Bash 3.2 래퍼: stdin을 `node "${CLAUDE_PLUGIN_ROOT}/scripts/hooks-impl/precompact-handoff.mjs"`에 파이프, 항상 exit 0.

- [ ] **Step 1: Write the failing test (구조)**

`tests/precompact-hook.test.mjs` 에 추가:

```javascript
import { readFileSync as rf } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const PROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('hooks.json declares PreCompact → precompact-handoff.sh', () => {
  const h = JSON.parse(rf(join(PROOT, 'hooks', 'hooks.json'), 'utf8'));
  assert.ok(h.hooks.PreCompact, 'PreCompact event present');
  const cmd = h.hooks.PreCompact[0].hooks[0].command;
  assert.match(cmd, /precompact-handoff\.sh/);
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}/);
});

test('precompact-handoff.sh is Bash 3.2 safe', () => {
  const sh = rf(join(PROOT, 'hooks', 'scripts', 'precompact-handoff.sh'), 'utf8');
  assert.match(sh, /set -Eeuo pipefail/);
  assert.ok(!/declare -A/.test(sh), 'no associative arrays');
  assert.ok(!/\$\{[A-Za-z_]+,,\}/.test(sh), 'no ${var,,} lowercasing');
  assert.match(sh, /precompact-handoff\.mjs/);
});
```

- [ ] **Step 2: Run to verify fail** — 파일 없음.

- [ ] **Step 3: Write the hook files**

`hooks/hooks.json`:

```json
{
  "description": "deep-loop autonomous handoff safety net — emit a clean handoff (and headless respawn when unattended) just before context compaction.",
  "hooks": {
    "PreCompact": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/scripts/precompact-handoff.sh" }
        ]
      }
    ]
  }
}
```

`hooks/scripts/precompact-handoff.sh`:

```bash
#!/usr/bin/env bash
# PreCompact hook — deep-loop clean-handoff safety net.
# Bash 3.2 compatible (no `declare -A`, no `${var,,}`). Best-effort: never blocks compaction.
set -Eeuo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
IMPL="$PLUGIN_ROOT/scripts/hooks-impl/precompact-handoff.mjs"

# stdin(JSON)을 그대로 .mjs 로 파이프. 실패해도 compaction 을 막지 않도록 exit 0.
if [ -f "$IMPL" ]; then
  node "$IMPL" || true
fi
exit 0
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/precompact-hook.test.mjs` PASS (전체 5 tests). 추가로 `bash -n hooks/scripts/precompact-handoff.sh`(구문 검사) 통과.
- [ ] **Step 5: Run full suite + commit**

Run: `npm test` → 0 fail.

```bash
git add hooks/hooks.json hooks/scripts/precompact-handoff.sh tests/precompact-hook.test.mjs
git commit -m "feat(hook): PreCompact wiring — hooks.json + Bash 3.2 wrapper → handoff impl

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Automation 템플릿 + 사용자 문서

### Task 19: `drive-headless.mjs` fail-closed 래퍼 + `recipes/automation/*.yml` (무인 자동화)

무인 장기 실행은 headless 강제 + 측정불가 시 fail-closed(§9). **Codex r2 sf-6: 템플릿이 raw `claude -p` 를 직접 부르면 timeout/usage/fail-closed 안전장치를 우회한다.** 따라서 `headlessSpawn`을 감싸는 작은 드라이버(`drive-headless.mjs`)를 만들고, cron/GitHub Actions 템플릿이 **그 드라이버**를 호출한다.

**Files:**
- Modify: `scripts/lib/lease.mjs` (`leaseCheck` 에 `accounting` carve-out)
- Create: `scripts/hooks-impl/drive-headless.mjs`
- Create: `recipes/automation/cron-morning-triage.yml`
- Create: `recipes/automation/github-actions-loop.yml`
- Test: `tests/automation.test.mjs`, `tests/lease.test.mjs` (carve-out 단위)

**Interfaces:**
- Consumes: `spawn-driver.headlessSpawn`(Task 16), `budget.recordCost`, `state.readState`, `lease.leaseCheck`.
- Produces:
  - `lease.leaseCheck` — 변경: `releasing` 상태 carve-out 에 **`intent='accounting'`** 추가(기존 `intent='lease'` 와 함께). 비용 회계는 상태기계 mutation 이 아니라 이미 발생한 cost 기록이라 owner+generation 일치 시 releasing 중에도 허용(Codex r6 sf-2). generation 불일치(자식 인수)는 여전히 거부.
  - `drive-headless.driveHeadless({ root = process.cwd(), prompt = '/deep-loop-continue', spawnFn = headlessSpawn, timeoutMs } = {})` → `{ ok:true, action:'drove', usage, recorded } | { ok:false, action:'fail-closed', reason } | { ok:true, action:'no-run' }`. headlessSpawn 으로 timeout+usage 측정, 측정불가/timeout/비0 → `fail-closed`. 성공 시 측정 usage 를 `recordCost`(intent:'accounting')로 권위있게 커밋. CLI 진입은 `drove`/`no-run` exit 0, `fail-closed` exit 1.
  - `cron-morning-triage.yml` / `github-actions-loop.yml`: schedule + **`drive-headless.mjs` 호출**(raw `claude -p` 금지) + proposal-only 주석.

- [ ] **Step 0: `leaseCheck` accounting carve-out (lib + 단위테스트)**

`scripts/lib/lease.mjs` 의 releasing carve-out 줄을 교체:

```javascript
  // 부모 carve-out: releasing 중 업무 write 거부; 자기 lease 관리(intent='lease')와 비용 회계(intent='accounting')만 허용.
  if (lease.state === 'releasing' && intent !== 'lease' && intent !== 'accounting') return { ok: false, reason: 'lease-releasing-carveout' };
```

`tests/lease.test.mjs` 에 추가:

```javascript
test('leaseCheck allows accounting during releasing for matching owner/generation', () => {
  const loop = { session_chain: { lease: { owner_run_id: 'r', generation: 2, state: 'releasing' } } };
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'business' }).ok, false);    // 업무 write 거부
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 2, intent: 'accounting' }).ok, true);   // 회계 허용
  assert.equal(leaseCheck(loop, { owner: 'r', generation: 3, intent: 'accounting' }).ok, false);  // generation 불일치 거부
});
```

- [ ] **Step 1: Write the failing test**

`tests/automation.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { respawn } from '../scripts/lib/respawn.mjs';
import { acquireLease } from '../scripts/lib/lease.mjs';
import { driveHeadless } from '../scripts/hooks-impl/drive-headless.mjs';

const A = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'automation');
function seedRun() {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('driveHeadless drives when spawn ok and requests metric output', () => {
  let cmd = null;
  const r = driveHeadless({ root: seedRun().root, spawnFn: (c) => { cmd = c; return { ok: true, usage: { num_turns: 1, tokens: 50 } }; } });
  assert.equal(r.action, 'drove');
  assert.match(cmd, /--output-format json/);   // Codex r6 sf-4
});

// Codex r5 critical-2: 성공한 headless 실행의 측정 usage 는 budget+session 에 결정론적으로 커밋되어야 한다.
test('driveHeadless commits measured usage to budget on success', () => {
  const { root, runId } = seedRun();
  const r = driveHeadless({ root, spawnFn: () => ({ ok: true, usage: { num_turns: 3, tokens: 100 } }) });
  assert.equal(r.recorded, true);
  const d = readState(root, runId).data;
  assert.equal(d.budget.spent, 3);
  assert.equal(d.budget.tokens_spent, 100);
  assert.equal(d.session_chain.sessions[0].turns, 3);   // per_session_turn_cap 도 구동
});

// Codex r6 sf-2: 자식 tick 이 milestone 에서 handoff 를 emit 해 lease 가 releasing 이 돼도 측정 usage 는 정확히 1회 회계.
test('driveHeadless still accounts usage when the child emitted a handoff', () => {
  const { root, runId } = seedRun();
  const r = driveHeadless({ root, spawnFn: () => {
    emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', expect: { owner: runId, generation: 1 } });  // lease → releasing
    return { ok: true, usage: { num_turns: 2, tokens: 50 } };
  } });
  assert.equal(r.recorded, true);
  assert.equal(readState(root, runId).data.budget.spent, 2);
});

// Codex r7 sf-2: 자식이 generation+1 로 완전히 인수했으면 stale 부모(캡처한 generation)는 펜싱돼 기록하지 않는다.
test('driveHeadless does not record under a child that fully acquired the lease', () => {
  const { root, runId } = seedRun();
  const r = driveHeadless({ root, spawnFn: () => {
    const em = emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', expect: { owner: runId, generation: 1 } });
    respawn(root, runId, { childRunId: em.childRunId, key: em.key, handoffRel: em.handoffRel, headless: true, spawnFn: () => ({ ok: true }) });  // lease → released
    acquireLease(root, runId, { owner: em.childRunId, expectGeneration: 1 });   // 자식 인수 → generation 2, owner=child
    return { ok: true, usage: { num_turns: 4 } };
  } });
  assert.equal(r.recorded, false);                              // 캡처한 부모 fence(gen 1) 가 펜싱됨
  assert.equal(readState(root, runId).data.budget.spent, 0);    // 부모는 기록 안 함
});

test('driveHeadless fails closed when usage unmeasurable/timeout', () => {
  const r = driveHeadless({ root: seedRun().root, spawnFn: () => ({ ok: false, reason: 'unmeasurable-fail-closed' }) });
  assert.equal(r.ok, false);
  assert.equal(r.action, 'fail-closed');
});

test('driveHeadless is a no-op when no current run', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-auto0-'));
  assert.equal(driveHeadless({ root }).action, 'no-run');
});

test('cron template calls the fail-closed driver (not raw claude -p)', () => {
  const f = join(A, 'cron-morning-triage.yml'); assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /cron|schedule|\d+\s+\d+\s+\*/i);
  assert.match(s, /drive-headless\.mjs/);                 // 드라이버 경유
  assert.match(s, /fail-closed|budget|proposal-only/i);
});

test('github-actions template is a scheduled workflow calling the driver', () => {
  const f = join(A, 'github-actions-loop.yml'); assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /on:\s*[\s\S]*schedule/);
  assert.match(s, /cron:/);
  assert.match(s, /drive-headless\.mjs/);
  assert.match(s, /proposal-only|사람 승인|human/i);
});
```

- [ ] **Step 2: Run to verify fail** — module/파일 없음.

- [ ] **Step 3a: Write `scripts/hooks-impl/drive-headless.mjs`**

```javascript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState } from '../lib/state.mjs';
import { recordCost } from '../lib/budget.mjs';
import { headlessSpawn } from '../lib/spawn-driver.mjs';

function currentRunId(root) { const p = join(root, '.deep-loop', 'current'); return existsSync(p) ? readFileSync(p, 'utf8').trim() : null; }

// 무인 자동화 진입점: headlessSpawn 으로 claude -p 를 timeout + usage 측정 하에 구동.
// 측정불가/timeout/비0 종료 → fail-closed. 성공 시 **측정 usage 를 budget 에 권위있게 커밋**(spec §9 hard 강제).
// DEEP_LOOP_UNATTENDED=1 로 자식의 자기보고를 끄므로 driver 의 기록이 단일 출처(이중계상 없음, Codex r5 critical-2).
export function driveHeadless({ root = process.cwd(), prompt = '/deep-loop-continue', spawnFn = headlessSpawn, timeoutMs } = {}) {
  const runId = currentRunId(root);
  if (!runId) return { ok: true, action: 'no-run' };
  // Codex r7 sf-2: fence 를 spawn **이전에** 캡처. 자식이 generation+1 로 lease 를 인수했으면 stale 부모는
  // generation/owner mismatch 로 펜싱돼 recordCost 가 LEASE_FENCED → skip(자식이 자기 회계를 가짐). post-spawn lease 를
  // 쓰면 자식 신원으로 잘못 기록되므로 금지.
  const pre = readState(root, runId).data.session_chain?.lease || {};
  const fence = { owner: pre.owner_run_id, generation: pre.generation, intent: 'accounting' };
  // Codex r6 sf-4: --output-format json 으로 num_turns/usage 를 stdout 에 내보내야 headlessSpawn 이 측정 가능.
  const cmd = `cd ${root} && DEEP_LOOP_UNATTENDED=1 claude -p "${prompt}" --output-format json --permission-mode acceptEdits`;
  const res = spawnFn(cmd, timeoutMs ? { timeoutMs } : {});
  if (!res.ok) return { ok: false, action: 'fail-closed', reason: res.reason };
  // 측정 usage 를 캡처한 fence(intent:'accounting')로 커밋 — releasing(같은 owner/gen)은 허용, generation 변경은 거부.
  let recorded = false;
  try {
    recordCost(root, runId, { turns: res.usage?.num_turns || 0, tokens: res.usage?.tokens || 0, fence });
    recorded = true;
  } catch (e) { if (!String(e.message).startsWith('LEASE_FENCED')) throw e; }
  return { ok: true, action: 'drove', usage: res.usage, recorded };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = driveHeadless({ root: process.cwd() });
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(r.ok ? 0 : 1);
}
```

- [ ] **Step 3b: Write both templates (call the driver)**

`recipes/automation/cron-morning-triage.yml`:

```yaml
# deep-loop — unattended morning triage (cron template).
# 무인 장기 실행은 headless 강제 + 측정불가 시 fail-closed (spec §9).
# 안전장치(timeout/usage/fail-closed)는 drive-headless.mjs 가 claude -p 를 감싸 제공한다 — raw claude -p 직접 호출 금지.
# crontab -e 에 붙여넣어 사용. <PROJECT_ROOT>/<DEEP_LOOP_DIR> 를 실제 경로로 치환.
#
# ┌ min  ┌ hour ┌ dom ┌ mon ┌ dow
# 0      8      *     *     *   cd <PROJECT_ROOT> && \
#   DEEP_LOOP_UNATTENDED=1 node <DEEP_LOOP_DIR>/scripts/hooks-impl/drive-headless.mjs >> deep-loop-cron.log 2>&1
#
# 동작:
#   - .deep-loop/current 의 run 을 headless 로 1 tick 진행 (drive-headless → headlessSpawn(claude -p "/deep-loop-continue")).
#   - budget(turns/tokens/wallclock) 하드캡 + usage 측정불가/timeout 시 fail-closed(비0 종료, 재트리거 전 사람 점검).
#   - 비가역 외부 행동(push/PR/merge/publish)은 v1 에서 proposal-only — cron 이 자동 실행하지 않음.
#   - run 이 없으면 no-op. breaker latch 시 사람 reset 전까지 진행 중단.
schedule: "0 8 * * *"
drive: 'node <DEEP_LOOP_DIR>/scripts/hooks-impl/drive-headless.mjs'
unattended: true
notes: "drive-headless wraps claude -p with timeout + usage fail-closed; external actions remain proposal-only"
```

`recipes/automation/github-actions-loop.yml`:

```yaml
# deep-loop — scheduled autonomous loop (GitHub Actions template).
# 사용자가 .github/workflows/ 로 복사. 안전장치는 drive-headless.mjs(headlessSpawn 래퍼)가 제공 — raw claude -p 금지.
name: deep-loop
on:
  schedule:
    - cron: "0 8 * * *"   # 매일 08:00 UTC
  workflow_dispatch: {}
jobs:
  loop:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      # headless 구동 — 비대화형(non-tty)이라 unattended=headless. drive-headless 가 timeout + usage fail-closed 강제.
      - name: Drive deep-loop (headless, fail-closed)
        env:
          DEEP_LOOP_UNATTENDED: "1"
        run: node scripts/hooks-impl/drive-headless.mjs
      # 주의: 비가역 외부 행동(push/PR/merge/publish/delete)은 v1 에서 proposal-only —
      # 사람 승인 게이트. 이 workflow 는 코드 변경/세션 연속만 자동화하며 자동 머지/배포하지 않는다.
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/automation.test.mjs` PASS (5 tests).
- [ ] **Step 5: Commit**

```bash
git add scripts/hooks-impl/drive-headless.mjs recipes/automation tests/automation.test.mjs
git commit -m "feat(automation): drive-headless fail-closed wrapper + cron/GHA templates calling it (no raw claude -p)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 20: `README.md` + `README.ko.md` + `CHANGELOG.md`

사용자 문서. README는 10개 명령·2-plane 아키텍처·안전 불변식·독립 동작을 설명.

**Files:**
- Create: `README.md`, `README.ko.md`, `CHANGELOG.md`
- Test: `tests/docs.test.mjs`

**Interfaces:**
- Produces (test가 강제하는 최소 요건):
  - `README.md`: 10개 `/deep-loop*` 명령 전부 나열 + "2-plane"/"control plane" 설명 + "proposal-only"/사람 승인 안전 노트 + "standalone"(독립 동작) 언급.
  - `README.ko.md`: 한국어 미러(같은 10개 명령 나열).
  - `CHANGELOG.md`: `0.1.0` (또는 v1) 항목 + Plan 1/2/3 요약.

- [ ] **Step 1: Write the failing test**

`tests/docs.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_CMDS = ['/deep-loop', '/deep-loop-discover', '/deep-loop-triage', '/deep-loop-continue',
  '/deep-loop-handoff', '/deep-loop-resume', '/deep-loop-status', '/deep-loop-ack', '/deep-loop-finish'];

test('README lists all commands + architecture + safety', () => {
  const s = readFileSync(join(R, 'README.md'), 'utf8');
  for (const c of SKILL_CMDS) assert.ok(s.includes(c), `README missing ${c}`);
  assert.match(s, /2-plane|control plane/i);
  assert.match(s, /proposal-only|human approval|사람 승인/i);
  assert.match(s, /standalone|독립/i);
});

test('README.ko mirrors commands', () => {
  const s = readFileSync(join(R, 'README.ko.md'), 'utf8');
  for (const c of SKILL_CMDS) assert.ok(s.includes(c), `README.ko missing ${c}`);
});

test('CHANGELOG has a 0.1.0 entry', () => {
  assert.ok(existsSync(join(R, 'CHANGELOG.md')));
  assert.match(readFileSync(join(R, 'CHANGELOG.md'), 'utf8'), /0\.1\.0|v1/);
});
```

- [ ] **Step 2: Run to verify fail** — 파일 없음.
- [ ] **Step 3: Write README.md / README.ko.md / CHANGELOG.md** (요건 충족; 아키텍처 다이어그램·명령표·안전 불변식·설치·독립 동작·deep-suite 연동 섹션).
- [ ] **Step 4: Run to verify pass** — `node --test tests/docs.test.mjs` PASS (3 tests).
- [ ] **Step 5: Run full suite + commit**

Run: `npm test` → 0 fail.

```bash
git add README.md README.ko.md CHANGELOG.md tests/docs.test.mjs
git commit -m "docs: README (en/ko) + CHANGELOG — commands, 2-plane architecture, safety invariants

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase E — Marketplace 등록 (사용자 승인 게이트)

비가역 외부 행동(GitHub push)은 **사용자 명시 승인 필수**(spec §13·§15). 등록은 발견성만 추가하며 의존성이 아니다. **SHA 핀닝 제약**: `check-pinned-plugin-paths.js`가 `gh api`로 레포를 SHA에서 fetch → **push 전엔 preflight 불가**. 따라서 두 경로:

### Task 21: `integration/deep-suite.patch.md` (항상) + (push 승인 시) 3-파일 lockstep + preflight

**Files:**
- Create: `integration/deep-suite.patch.md`
- (push 승인 시만) Modify in `/Users/sungmin/Dev/claude-plugins/deep-suite/`:
  - `.claude-plugin/marketplace.json`
  - `.agents/plugins/marketplace.json`
  - `.claude-plugin/suite-extensions.json`

**Interfaces (등록 엔트리 형태 — 조사로 확인됨):**
- `marketplace.json` 엔트리: `{ name:"deep-loop", description, source:{ source:"url", url:"https://github.com/Sungmin-Cho/claude-deep-loop.git", sha:"<40-char>" } }`.
- `.agents/plugins/marketplace.json` 엔트리: 위 + `policy:{ installation:"AVAILABLE", authentication:"ON_USE" }` + `category:"Coding"` (기존 항목과 동일 순서/포맷).
- `suite-extensions.json` 엔트리: `"deep-loop": { runtime:["node","bash"], capabilities:[...], artifacts:{ writes:[".deep-loop/runs/<id>/loop.json", ...], reads:[<sibling receipts>] }, hooks_active:["PreCompact"] }` — hooks_active 비어있지 않으므로 `hooks_intentionally_empty_reason` 불필요.

- [ ] **Step 1: Build + 독립 동작 검증**

Run: `npm run preflight` (deep-loop) → validate + 전체 테스트 PASS. 외부 의존성 0, sibling 없이 standalone 동작 확인.

- [ ] **Step 2: `integration/deep-suite.patch.md` 작성 (항상)**

3-파일 lockstep 수정 내용을 정확한 before/after diff로 문서화 — push 미승인 시 사용자가 직접 적용할 수 있도록. `<SHA>` 플레이스홀더 포함. preflight가 push 후에만 가능함을 명시.

- [ ] **Step 3: 사용자 승인 게이트 (AskUserQuestion 또는 명시 확인)**

> "deep-loop를 GitHub(`https://github.com/Sungmin-Cho/claude-deep-loop.git`)에 push하고 deep-suite marketplace에 등록할까요? push는 비가역 외부 행동이라 명시 승인이 필요합니다. [push+등록 / patch 플랜만 / 나중에]"

- **승인 시:** PR merge 후 push → 40-char SHA 회수 → deep-suite 3파일 lockstep 수정(SHA 핀) → deep-suite `npm run preflight`(README 테이블 자동재생성, 마커 내부 수정 ❌) PASS 확인.
- **미승인 시:** `integration/deep-suite.patch.md`만 남기고 종료(등록 보류).

- [ ] **Step 4: Commit (patch plan)**

```bash
git add integration/deep-suite.patch.md
git commit -m "docs(integration): deep-suite marketplace registration patch plan (push-gated)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 최종 검증

- [ ] `npm run preflight` (= `validate` + `npm test`) PASS, 0 fail.
- [ ] `git status` clean (worktree).
- [ ] 10개 SKILL.md frontmatter·트리거·CLI-참조 검증 통과(`tests/skills.test.mjs`).
- [ ] 결정론 글루(CLI 완성·hook·spawn 드라이버·finish) 단위테스트 전부 green.
- [ ] §7 불변식 위반 0 (2-plane 경계, fence, 단일 앵커, 터미널-proof, proposal-only, respawn 게이트, worktree 연속성, root-밖-쓰기 금지, breaker latch).

---

## Self-Review (작성자 체크리스트)

**1. Spec coverage:** §3(10 스킬)→Tasks 9-15 · §1.1/§6(어댑터 4-verb, 커널 비호출)→Tasks 2,10,11 · §7(리뷰 전략)→Tasks 9,10 · §9(handoff/respawn 3 호출자)→Tasks 11,13,16,17,18 · §10(sibling 계약)→Tasks 10,11 · §11(graceful degradation)→Tasks 9,15 · §12(finish)→Tasks 8,15 · §2(PreCompact hook)→Task 18 · §13(marketplace)→Task 21 · §16(proposal-only)→Global Constraints. **추가 발견:** 스킬이 의존하나 Plan 2가 미노출한 CLI(state get/patch·budget record·comprehension ack·breaker reset·finish·adapter resolve)→Phase A(Tasks 2-8). 날짜-flake→Task 1.

**2. Placeholder scan:** 결정론 글루는 전체 test+impl 코드 포함. SKILL.md는 산문이라 frontmatter(verbatim) + 콘텐츠 스펙(필수 포함 요소) + structural test로 명세 — 핸드오프 §5.2 규약("SKILL.md는 구조/트리거/언어 검증")에 부합. TBD/TODO 없음.

**3. Type consistency:** fence 시그니처(`{fence}`)를 patch/recordCost/ack/finish 전반에 일관 적용. `headlessSpawn(cmd,{run})` 반환 `{ok,reason|usage}`는 respawn의 spawnFn 계약과 일치. `runPreCompactHandoff(input,{root,spawnFn,now})`는 respawn/emitHandoff 시그니처와 정합.

---

## Execution Handoff

Plan complete. 핸드오프 §5 프로세스대로: 이 Plan을 **Codex-only 2-way 리뷰 루프**(`deep-review:deep-review-loop`, codex-only)로 APPROVE까지 수렴시킨 뒤, **superpowers:subagent-driven-development**(implementer=sonnet, 게이트 = `npm test` green + skills frontmatter 검증)로 구현하고, 구현 결과를 다시 Codex-only 2-way 리뷰 루프로 검증한다.
