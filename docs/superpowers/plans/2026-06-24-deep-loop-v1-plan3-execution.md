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
import { mkdtempSync } from 'node:fs';
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

test('adapter resolve returns deep-work dispatch descriptor', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'Add auth']));
  assert.equal(out.descriptor.kind, 'invoke_skill');
  assert.equal(out.descriptor.skill, 'deep-work:deep-work-orchestrator');
  assert.match(out.descriptor.args, /Add auth/);
});

test('adapter resolve guards read-only tier from implementer dispatch', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['adapter', 'resolve', '--protocol', 'deep-work', '--task', 'x', '--tier', 'read-only']));
  assert.equal(out.guard.ok, false);
});

test('adapter resolve rejects unknown protocol (exit 2)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['adapter', 'resolve', '--protocol', 'nope', '--task', 'x']), 2);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/cli-skillface.test.mjs`
Expected: FAIL — `unknown subcommand: adapter`.

- [ ] **Step 3: Add the `adapter` handler**

`scripts/deep-loop.mjs` — import 추가 + 핸들러:

```javascript
import { resolveAdapter, guardTierProtocol } from './lib/adapters.mjs';
```

handlers 객체에:

```javascript
  adapter: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest);
    if (verb !== 'resolve') { error(`unknown adapter verb: ${verb}`); return 2; }
    const protocol = strArg(f, 'protocol');
    let ad; try { ad = resolveAdapter(protocol); } catch { error(`UNKNOWN_PROTOCOL: ${protocol}`); return 2; }
    const callVerb = f.verb && f.verb !== true ? f.verb : 'dispatch';
    const descriptor = ad.dispatch({ task: f.task && f.task !== true ? f.task : '' });
    const guard = f.tier && f.tier !== true ? guardTierProtocol(f.tier, protocol, callVerb) : { ok: true, reason: 'no-tier' };
    json({ protocol, verb: callVerb, descriptor, guard }); return 0;
  },
```

(주의: `strArg`/`error`/`json`/`parseFlags`는 기존 헬퍼. `adapter resolve`는 read-only라 `requireLease` 호출하지 않음.)

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

`tests/state.test.mjs` 에 fence 단위(직접 lib):

```javascript
test('patch enforces fence inside the lock', () => {
  // seed a run, then patch with mismatched generation throws LEASE_FENCED
  // (uses existing test helpers in this file; mirror their seed pattern)
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
      requireLease(root, runId, f);
      const field = strArg(f, 'field');
      let value; try { value = JSON.parse(strArg(f, 'value')); } catch { error('INVALID_VALUE: must be JSON'); return 1; }
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

test('budget check is read-only and reports ok', () => {
  const { root } = seed();
  const r = JSON.parse(run(root, ['budget', 'check', '--now', '2026-06-24T00:00:01Z']));
  assert.equal(r.ok, true);
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
  }, (loop) => {
    if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
  });
}
```

(주의: `appendAnchored`의 3번째 인자 = mutate(loop, spent), 4번째 = preCheck(loop). 기존 호출자(테스트)는 fence 미전달 → 동작 불변.)

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
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { recordCost(root, runId, { turns: f.turns ? Number(f.turns) : 0, tokens: f.tokens ? Number(f.tokens) : 0, fence }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
      const { data } = readState(root, runId);
      json({ ok: true, spent: data.budget.spent, tokens_spent: data.budget.tokens_spent }); return 0;
    }
    error(`unknown budget verb: ${verb}`); return 2;
  },
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
    data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    const ep = data.episodes.find(e => e.id === episodeId);
    if (ep) ep.human_reviewed = true;
    writeState(root, runId, data);
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
      requireLease(root, runId, f);
      const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
      try { ackComprehension(root, runId, strArg(f, 'episode'), { fence }); }
      catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
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

circuit breaker가 latch되면(연속 REQUEST_CHANGES 3) 사람 reset 전까지 모든 진행이 막힌다(spec §15). 사람 escape hatch로 명시 확인(`--confirm`) 기반 reset CLI가 필요하다. **lease fence가 아니라 사람 확인 게이트** — 어떤 세션도 lease를 안 들고 있을 수 있는 paused 상태에서 사람이 호출하기 때문.

**Files:**
- Modify: `scripts/lib/breaker.mjs` (`resetBreaker` 신규)
- Modify: `scripts/deep-loop.mjs` (`breaker` 핸들러)
- Test: `tests/cli-skillface.test.mjs`, `tests/breaker.test.mjs`

**Interfaces:**
- Consumes: `state.withLock`/`readState`/`writeState`(기존).
- Produces:
  - `breaker.resetBreaker(root, runId)` — `withLock` 안에서 `tripped=false`, `consecutive_request_changes=0`, `trip_reason=null`; `status==='paused' && 직전 trip_reason 이 breaker 계열`이면 `status='running'` 복귀(다른 사유의 paused는 건드리지 않음). 반환 `{ok:true, status}`.
  - CLI `breaker check` → `checkBreaker`(read-only). `breaker reset --confirm` → `--confirm` 없으면 종료 2 + `error('BREAKER_RESET_REQUIRES_CONFIRM')`; 있으면 `resetBreaker`. **autonomy 플래그로 켤 수 없는 사람 전용 경로.**

- [ ] **Step 1: Write the failing test**

`tests/breaker.test.mjs` 에 추가(직접 lib + trip→reset):

```javascript
test('resetBreaker clears latch and resumes only if paused by breaker', () => {
  // seed run; recordReviewVerdict REQUEST_CHANGES x3 → tripped + status=paused
  // resetBreaker → tripped=false, counter=0, status=running
});
```

`tests/cli-skillface.test.mjs`:

```javascript
test('breaker reset requires --confirm (exit 2)', () => {
  const { root } = seed();
  assert.equal(runFail(root, ['breaker', 'reset']), 2);
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
export function resetBreaker(root, runId) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
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
      json(resetBreaker(root, runId)); return 0;
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
import { finishRun } from '../scripts/lib/finish.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-fin-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId, fence: { owner: runId, generation: 1, intent: 'business' } };
}

test('finish completed is blocked without report + settled proof', () => {
  const { root, runId, fence } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'completed', reportRel: 'final-report.md', proof: {}, fence }), /FINISH_PROOF_UNMET/);
});

test('finish completed succeeds when no episodes/workstreams and report exists', () => {
  const { root, runId, fence } = seed();
  const rel = 'final-report.md';
  writeFileSync(join(runDir(root, runId), rel), '# report');
  const r = finishRun(root, runId, { status: 'completed', reportRel: rel, proof: {}, fence });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'completed');
});

test('finish stopped requires human_reason', () => {
  const { root, runId, fence } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: {}, fence }), /FINISH_PROOF_UNMET|human_reason/);
  const r = finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'user asked' }, fence });
  assert.equal(r.status, 'stopped');
});

test('finish is fenced', () => {
  const { root, runId } = seed();
  assert.throws(() => finishRun(root, runId, { status: 'stopped', proof: { human_reason: 'x' }, fence: { owner: runId, generation: 9 } }), /LEASE_FENCED/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/finish.test.mjs`
Expected: FAIL — `Cannot find module finish.mjs`.

- [ ] **Step 3a: Write `scripts/lib/finish.mjs`**

```javascript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
  const settled = eps.every(e => settledEp(loop, e));
  const noActiveWs = (loop.active_workstreams || []).length === 0;
  const wsAll = (loop.workstreams || []).every(w => TERMINAL_WS.includes(w.status));
  const missing = [];
  if (!settled) missing.push('unsettled-episodes');
  if (!noActiveWs) missing.push('active-workstreams');
  if (!wsAll) missing.push('non-terminal-workstreams');
  return { settled, noActiveWs, allWsTerminal: wsAll, missing };
}

export function finishRun(root, runId, { status, reportRel, proof = {}, fence, now = Date.now() } = {}) {
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
      if (fence) { const r = leaseCheck(loop, fence); if (!r.ok) throw new Error('LEASE_FENCED: ' + r.reason); }
      if (status !== 'completed' && status !== 'stopped') throw new Error(`FINISH_STATUS_INVALID: ${status}`);
      if (status === 'stopped') {
        if (!proof || !proof.human_reason) throw new Error('FINISH_PROOF_UNMET: stopped requires proof.human_reason');
        return;
      }
      // completed
      const ps = finishProofState(loop);
      const reportOk = reportRel && existsSync(join(runDir(root, runId), reportRel));
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
    requireLease(root, runId, f);
    const fence = { owner: f.owner, generation: intArg(f, 'generation'), intent: 'business' };
    const status = strArg(f, 'status');
    const reportRel = f.report && f.report !== true ? String(f.report) : undefined;
    if (reportRel && (reportRel.startsWith('/') || reportRel.split('/').includes('..'))) { error('FINISH_REPORT_PATH_UNSAFE'); return 1; }
    const proof = f.proof ? JSON.parse(f.proof) : {};
    try { const r = finishRun(root, runId, { status, reportRel, proof, fence, now: parseNow(f) }); json(r); return 0; }
    catch (e) { if (String(e.message).startsWith('LEASE_FENCED')) { error(e.message); return 3; } error(e.message); return 1; }
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
  test(`skill ${dir}: never writes durable state directly`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    // loop.json/.loop.hash/event-log.jsonl 에 Write/Edit 하라는 지침 금지
    assert.ok(!/(Write|Edit)\([^)]*loop\.json/.test(src), `${dir} instructs direct loop.json write`);
    assert.ok(!/\.loop\.hash/.test(src) || /절대.*쓰|never write/i.test(src), `${dir} references hash anchor unsafely`);
  });
  if (refsCLI) {
    test(`skill ${dir}: routes mutations through the CLI with fence`, () => {
      const src = readFileSync(skillPath(dir), 'utf8');
      assert.match(src, /deep-loop\.mjs/, `${dir} must invoke kernel CLI`);
      assert.match(src, /--owner|--generation/, `${dir} mutating CLI must pass lease fence`);
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
  5. **run 생성:** `init-run --goal "<goal>" --protocol <p> --recipe '<json>' --review '<json>'` → `run_id` 회수. 이후 모든 mutating은 `--owner <run_id> --generation 1`.
  6. workstream 생성: `workstream new --title ... --branch ... --worktree ... [--depends-on '<json>'] --owner <run_id> --generation 1`.
  7. 첫 episode: `episode new --plugin <maker> --role maker --kind <k> --point <design|plan|implementation> --workstream <ws> --owner ... --generation 1`.
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
  - **dispatch:** `adapter resolve --protocol <p> --task "<brief>" [--tier <t>]`로 디스크립터(`{kind,skill,then,args}`)를 받아 → `kind==='invoke_skill'`이면 `Skill({skill, args})`로 sibling invoke, `kind==='inline'`이면 직접 도구 사용. `guard.ok===false`면 dispatch 중단(tier×protocol 모순).
  - **awaitResult:** 디스크립터의 `await.kind`가 `poll_file`이면 그 경로(`path_template` 채워진)를 `done_when` 만족까지 폴링(LLM/드라이버가 수행). deep-work는 `.deep-work/<task>/session-receipt.json`의 `current_phase=idle`.
  - **checker:** `review dispatch --point <p> --workstream <ws> --owner --generation`로 checker episode + 디스크립터 생성 → 그 reviewer 스킬을 invoke → verdict를 `review record --episode <id> --workstream <ws> --point <p> --verdict <APPROVE|REQUEST_CHANGES|CONCERN> --owner --generation`로 기록(커널이 터미널·breaker·comprehension 파생).
  - **readArtifacts:** sibling receipt 경로 + 식별 가드(§10). 불일치 시 throw 금지 → null + 경고.
- `references/review-strategy.md`: §7 확인 질문 흐름, deep-review 유/무 분기, `review` JSON 형태(`points`/`reviewer`/`mode`/`flags`/`converge`/`max_review_rounds`/`require_human_ack`).
- `references/handoff-respawn.md`: §9 호출자 3종, `handoff emit` → (interactive: `terminal/launch-command.txt`를 사람에게 제시 / headless: 드라이버가 respawn). respawn 게이트 순서. "미감시 자율은 headless 강제".

**structural test:** Task 9 하네스의 `deep-loop-workflow` 행(user-invocable:false, triggers `adapter`/`어댑터`). 추가로 references 3파일 `existsSync` 검증을 하네스에 inline(아래 Step 1).

- [ ] **Step 1: Extend the harness with references existence**

`tests/skills.test.mjs` 끝에:

```javascript
test('deep-loop-workflow references exist', () => {
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md'])
    assert.ok(existsSync(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r)), `missing reference ${r}`);
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
- 1. **게이트(항상 먼저):** `next-action --json`. `gate.allowed===false`거나 `action.type ∈ {handoff, await_human}`면: budget/breaker면 `handoff emit` + 사람 호출 후 종료; breaker면 `/deep-loop-status`로 사람 reset(`breaker reset --confirm`) 안내.
- 2. **action 분기(next-action이 반환한 `action.type`대로, 스스로 판단 추가 금지):**
  - `discover` → `/deep-loop-discover` 안내(또는 invoke).
  - `dispatch_maker` → `adapter resolve`로 디스크립터 → `episode record --status in_progress`(비-터미널) → sibling `Skill()` invoke(`deep-loop-workflow/references/adapters.md`) → 완료 후 `episode record --status done --artifacts '<json>' --proof '<json>'`.
  - `dispatch_checker` → `review dispatch` → reviewer invoke → `review record --verdict ...`.
  - `fix_episode` → fix maker episode 생성(`episode new --kind fix`) 후 dispatch.
  - `await_result` → 폴링.
  - `finish` → `/deep-loop-finish` 안내.
- 3. **record:** 각 단계 후 CLI로 기록(위). 턴 소비는 `budget record --turns N`.
- 4. **Decide:** 마일스톤(`milestone_predicate`) 통과 or `per_session_turn_cap` 도달이면 `handoff emit` + respawn(드라이버/사람). 아니면 다음 episode 안내.
- mutating은 전부 `--owner <run_id> --generation <n>`. 비가역 외부행동 proposal-only.

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

**deep-loop-status 콘텐츠 스펙:** 언어감지 + 안전. **read-only**(echo 금지 보일러플레이트 면제 — Task 9 하네스가 status는 제외). `state get`, `budget check`, `comprehension status`, `breaker check`로 표시: status·예산(turns/tokens)·debt_ratio·breaker(tripped면 `breaker reset --confirm` 안내)·미검토 episode·session_chain·workstream 표. 사람이 막힌 지점을 알 수 있게 다음 명령 제안.

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
- Create: `scripts/lib/spawn-driver.mjs`
- Test: `tests/spawn-driver.test.mjs`

**Interfaces:**
- Consumes: `node:child_process.spawnSync`(기본 runner; 테스트는 주입).
- Produces:
  - `spawn-driver.headlessSpawn(cmd, { timeoutMs = 1800000, run = defaultRun } = {})` → `{ ok:true, usage } | { ok:false, reason }`. `run(cmd,{timeoutMs}) → {code, stdout, stderr, timedOut}`. timeout/non-zero exit/usage 측정불가는 전부 `ok:false`.
  - `spawn-driver.parseUsage(stdout)` → `{num_turns?, tokens?} | null` (claude `-p --output-format json` 또는 텍스트 마커 파싱; 없으면 `null`).
  - `spawn-driver.defaultRun(cmd, {timeoutMs})` → `spawnSync('bash', ['-c', cmd], {timeout})` 래핑.

- [ ] **Step 1: Write the failing test**

`tests/spawn-driver.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headlessSpawn, parseUsage } from '../scripts/lib/spawn-driver.mjs';

const okRun = () => ({ code: 0, stdout: '{"num_turns":3,"usage":{"input_tokens":10}}', stderr: '', timedOut: false });
const timeoutRun = () => ({ code: null, stdout: '', stderr: '', timedOut: true });
const unmeasurableRun = () => ({ code: 0, stdout: 'done, no usage here', stderr: '', timedOut: false });

test('headlessSpawn ok when usage measurable', () => {
  const r = headlessSpawn('claude -p x', { run: okRun });
  assert.equal(r.ok, true);
  assert.ok(r.usage);
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

test('parseUsage reads json and returns null on miss', () => {
  assert.ok(parseUsage('{"num_turns":2}'));
  assert.equal(parseUsage('nothing'), null);
});
```

- [ ] **Step 2: Run to verify fail** — `node --test tests/spawn-driver.test.mjs` → module 없음.

- [ ] **Step 3: Write `scripts/lib/spawn-driver.mjs`**

```javascript
import { spawnSync } from 'node:child_process';

export function parseUsage(stdout) {
  const s = String(stdout || '');
  try {
    const j = JSON.parse(s);
    if (j && (j.usage || j.num_turns != null || j.total_cost_usd != null)) {
      return { num_turns: j.num_turns ?? null, tokens: j.usage?.input_tokens ?? j.usage?.output_tokens ?? null };
    }
  } catch { /* not json */ }
  const m = s.match(/"(?:num_turns|turns)"\s*:\s*(\d+)/);
  return m ? { num_turns: Number(m[1]) } : null;
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
  - `precompact-handoff.runPreCompactHandoff(input, { root, spawnFn = headlessSpawn, now = Date.now() })` → `{ ok, action: 'emitted'|'respawned'|'gate-blocked'|'no-run'|'fenced', childRunId? }`.
    - `.deep-loop/current` 없으면 `{ok:true, action:'no-run'}`(no-op).
    - `readState` → lease owner/generation. headless 판단: `input.unattended === true` 또는 `loop.autonomy.spawn_style==='headless'` 또는 비-tty(`input.tty===false`).
    - `emitHandoff(root, runId, { reason:'pre-compact', trigger:'pre-compact', headless, expect:{owner,generation} })`.
    - headless && `loop.autonomy.auto_handoff` && `respawnGate(loop,{now}).ok` → `respawn(root, runId, { childRunId, key, handoffRel, headless:true, now, spawnFn })` → 결과 매핑. 아니면 `action:'emitted'`(사람 수동 resume).
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
});
```

- [ ] **Step 2: Run to verify fail** — module 없음.

- [ ] **Step 3: Write `scripts/hooks-impl/precompact-handoff.mjs`**

```javascript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState } from '../lib/state.mjs';
import { emitHandoff } from '../lib/handoff.mjs';
import { respawn, respawnGate } from '../lib/respawn.mjs';
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
  const gate = respawnGate(loop, { now });
  if (headless && loop.autonomy?.auto_handoff && gate.ok) {
    const rr = respawn(root, runId, { childRunId: em.childRunId, key: em.key, handoffRel: em.handoffRel, headless: true, now, spawnFn });
    return { ok: rr.ok, action: rr.ok ? 'respawned' : 'gate-blocked', childRunId: em.childRunId, outcome: rr.outcome };
  }
  return { ok: true, action: 'emitted', childRunId: em.childRunId };
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

### Task 19: `recipes/automation/*.yml` (무인 자동화 템플릿)

무인 장기 실행은 headless 강제 + fail-closed(§9). 두 템플릿은 cron / GitHub Actions에서 deep-loop을 headless로 구동하는 방법을 보여준다(실행 코드가 아니라 사용자 복사용 템플릿).

**Files:**
- Create: `recipes/automation/cron-morning-triage.yml`
- Create: `recipes/automation/github-actions-loop.yml`
- Test: `tests/automation.test.mjs`

**Interfaces:**
- Produces (콘텐츠 요건 — test가 강제):
  - `cron-morning-triage.yml`: cron 스케줄 표기 + `claude -p "/deep-loop-resume"` (또는 `/deep-loop-continue`) `--permission-mode acceptEdits` headless 구동 + `unattended` 환경 표시 + fail-closed/budget 주석.
  - `github-actions-loop.yml`: GitHub Actions workflow(`on: schedule: cron`) + 동일 headless 구동 step + 비가역 외부 행동은 proposal-only 주석.

- [ ] **Step 1: Write the failing test**

`tests/automation.test.mjs`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const A = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes', 'automation');

test('cron-morning-triage template has schedule + headless drive + fail-closed note', () => {
  const f = join(A, 'cron-morning-triage.yml');
  assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /cron|schedule|\d+\s+\d+\s+\*/i);
  assert.match(s, /claude -p/);
  assert.match(s, /deep-loop-(resume|continue)/);
  assert.match(s, /headless|unattended|acceptEdits/i);
  assert.match(s, /fail-closed|budget|proposal-only/i);
});

test('github-actions-loop template is a scheduled workflow with headless drive', () => {
  const f = join(A, 'github-actions-loop.yml');
  assert.ok(existsSync(f));
  const s = readFileSync(f, 'utf8');
  assert.match(s, /on:\s*[\s\S]*schedule/);
  assert.match(s, /cron:/);
  assert.match(s, /claude -p/);
  assert.match(s, /proposal-only|사람 승인|human/i);
});
```

- [ ] **Step 2: Run to verify fail** — 파일 없음.

- [ ] **Step 3: Write both templates**

`recipes/automation/cron-morning-triage.yml`:

```yaml
# deep-loop — unattended morning triage (cron template).
# 무인 장기 실행은 headless(claude -p) 강제 + 측정불가 시 fail-closed (spec §9).
# crontab -e 에 붙여넣어 사용. <PROJECT_ROOT> 를 실제 경로로 치환.
#
# ┌ min  ┌ hour ┌ dom ┌ mon ┌ dow
# 0      8      *     *     *   cd <PROJECT_ROOT> && \
#   DEEP_LOOP_UNATTENDED=1 claude -p "/deep-loop-resume" --permission-mode acceptEdits
#
# 동작:
#   - .deep-loop/current 의 run 을 headless 로 1+ tick 진행.
#   - budget(turns/tokens/wallclock) 하드캡 + usage 측정불가 시 fail-closed(pause).
#   - 비가역 외부 행동(push/PR/merge/publish)은 v1 에서 proposal-only — cron 이 자동 실행하지 않음.
#   - run 이 없으면 no-op. breaker latch 시 사람 reset 전까지 진행 중단.
schedule: "0 8 * * *"
drive: 'claude -p "/deep-loop-resume" --permission-mode acceptEdits'
unattended: true
notes: "headless + fail-closed; external actions remain proposal-only"
```

`recipes/automation/github-actions-loop.yml`:

```yaml
# deep-loop — scheduled autonomous loop (GitHub Actions template).
# 사용자가 .github/workflows/ 로 복사. headless + fail-closed (spec §9).
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
      # headless 구동 — 비대화형(non-tty)이라 unattended=headless 자동 강제.
      - name: Drive deep-loop (headless)
        env:
          DEEP_LOOP_UNATTENDED: "1"
        run: claude -p "/deep-loop-resume" --permission-mode acceptEdits
      # 주의: 비가역 외부 행동(push/PR/merge/publish/delete)은 v1 에서 proposal-only —
      # 사람 승인 게이트. 이 workflow 는 코드 변경/세션 연속만 자동화하며 자동 머지/배포하지 않는다.
```

- [ ] **Step 4: Run to verify pass** — `node --test tests/automation.test.mjs` PASS (2 tests).
- [ ] **Step 5: Commit**

```bash
git add recipes/automation tests/automation.test.mjs
git commit -m "feat(automation): cron + GitHub Actions headless loop templates (fail-closed, proposal-only)

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
