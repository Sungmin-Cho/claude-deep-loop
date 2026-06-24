# deep-loop v1 — Plan 2: 오케스트레이션 기계 (lease·workspace·episode·review·adapters·next-action·handoff·respawn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan 1의 결정론적 커널 위에 deep-loop의 **오케스트레이션 기계**(세션 lease/fencing, workstream 생애주기, episode scaffold/record, review dispatch, 프로토콜 어댑터, next-action 디스크립터, 자율 handoff/respawn)를 TDD로 구축하고 커널 CLI에 연결한다.

**Architecture:** 2-plane 중 Control plane의 오케스트레이션 계층. 모든 모듈은 순수 Node `.mjs`(ESM). **커널은 LLM 스킬을 함수처럼 호출하지 않는다(§1.1)** — `next-action`/adapter는 *디스크립터를 반환*하고 dispatch는 Execution plane LLM이 수행한다. 유일한 실제 프로세스 실행 지점은 headless `respawn`(주입 가능한 `spawnFn`으로 테스트). 상태 변경은 Plan 1 인터페이스(`withLock`/`appendAnchored`/`writeState`)를 통해서만, **`withLock`는 비재진입**이며 **모든 이벤트는 `appendAnchored` 단일 앵커 경로**로 기록한다.

**Tech Stack:** Node >= 20, `type: module`, `node:test` + `node:assert/strict`, 의존성 0. Plan 1 모듈(`state/integrity/budget/breaker/comprehension/schema/envelope/slug/detect/recipes/initrun`)을 소비.

## Global Constraints

- Node >= 20, `package.json` `"type": "module"`. 외부 의존성 추가 금지. (spec §2)
- **`withLock`는 비재진입** — lock을 잡은 콜백 안에서 다시 lock을 잡는 함수(`patch`/`recordCost`/`appendAnchored`/`withLock`/`ack`/`tripBreaker` 등)를 호출하지 말 것. 데드락/이중획득 금지. (Plan 1 impl review 확립)
- **모든 이벤트 기록은 `integrity.appendAnchored(root, runId, {type, data}, mutate?)` 단일 경로.** `appendEvent`(raw) 직접 호출 금지 — `event_log_head` 앵커가 stale된다. `mutate(loop, spent)`로 호출자별 상태 변경을 같은 lock 안에서 수행. (Plan 1 impl review r2 🟡)
- **터미널 상태는 커널이 proof artifact에서만 파생.** episode `done/approved/rejected`, workstream `ready/merged/abandoned`는 스킬 patch 불가 — 본 plan의 커널 모듈이 proof 검증 후 `writeState`로 직접 기록. (spec §4)
- **session_chain.\*(lease 포함), review.\*, budget.spent, autonomy.tier 상향, circuit_breaker.tripped=false**는 `state.patch` 화이트리스트에서 차단됨 — 커널 모듈만 `writeState`로 변경. (spec §4)
- **비가역 외부 행동(push/merge/publish/delete)은 v1에서 전부 proposal-only.** 어떤 모듈도 외부 행동을 실행하지 않는다(respawn의 `claude` 세션 spawn은 외부 세계 변경이 아닌 세션 연속 — §9 예외). (spec §15)
- **respawn은 acting tier로 게이팅하지 않는다.** respawn 게이트 = `budget` + `breaker` + `sessions < max_sessions` + `wallclock < max_wallclock_sec` + `auto_handoff`. (spec §9)
- 무결성은 *예방이 아니라 탐지+fail-stop*, 협조적-fallible 에이전트 전제. (spec §1.2)
- 시간은 `new Date().toISOString()`. 테스트는 주입 가능한 `now`(ms)로 결정론 유지.
- project root 밖 쓰기 금지. 상태 루트 = `<project-root>/.deep-loop/`. 본 plan 산출 파일(handoff/compaction-state/launch-command/request)은 전부 `runDir(root,runId)` 하위. (spec §15)
- M3 envelope(`producer:"deep-loop"`)는 loop.json 외 산출물(compaction-state 등)에 `envelope.wrap`로 적용. (spec §4)
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

### Plan 1이 노출하는 소비 인터페이스 (정확 시그니처 — 직접 loop.json 쓰기 금지)

```
state.mjs:       runDir(root,runId) · readState(root,runId)→{data,hash} · writeState(root,runId,data)
                 patch(root,runId,field,value) · classifyPatch(field,value)→'allow'|'forbid'
                 withLock(root,runId,fn,{ttlMs,retries,backoffMs}?) [비재진입] · WHITELIST:Set
integrity.mjs:   appendAnchored(root,runId,{type,data},mutate?) [유일 앵커 append] · appendEvent(raw·직접금지)
                 verifyLog(root,runId)→{ok,errors} · verifyHead(root,runId,expected)→{ok,errors}
                 lastLogHead(root,runId)→{seq,checksum} · recomputeSpent(root,runId)→{turns,tokens} · validCost(d)
budget.mjs:      checkBudget(loop,{now,sessionStart,measurable}?)→{ok,reason,tier_after}
                 recordCost(root,runId,{turns,tokens}) · reconcileBudget(root,runId)→{turns,tokens}|throw
breaker.mjs:     checkBreaker(loop)→{tripped,reason} · tripBreaker(root,runId,reason) · recordReviewVerdict(root,runId,verdict)
comprehension.mjs: computeDebt(loop)→{debt_ratio,blocked} · ack(root,runId,episodeId) · recordReviewed(root,runId,episodeId,source)
detect.mjs:      detectPlugins(root,home?)→{[name]:boolean}
recipes.mjs:     matchRecipe(goal,detected)→{recipe,protocol,reason}
initrun.mjs:     buildInitialLoop({...})→loop · initRun(root,{goal,protocol,recipe,review,detected,now,git})→{runId,loop}
envelope.mjs:    ulid(now?,rnd?) · atomicWrite(path,contents) · contentHash(str) · wrap({...}) · unwrap(obj,{producer,artifact_kind})
slug.mjs:        slugify(text,maxWords?) · runIdSlug(goal,now?)
```

**loop.json 관련 필드(buildInitialLoop가 생성):** `session_chain.lease{owner_run_id,generation,acquired_at,expires_at,state,handoff_idempotency_key,handoff_phase}`, `session_chain.stale_lease_ttl_sec`, `session_chain.sessions[]`, `event_log_head{seq,checksum}`, `workstreams[]`, `active_workstreams`, `autonomy{tier,auto_handoff,spawn_style,max_parallel,max_sessions,milestone_predicate,...}`, `budget{...,max_wallclock_sec,per_session_turn_cap,unattended_requires_headless}`, `review{points,reviewer,mode,flags,...}`, `episodes[]`, `current_episode`, `comprehension{episodes_total,...}`.

---

### Task 1: `lease.mjs` — 세션 lease CAS + generation 펜싱 + handoff 멱등 단계기계

**Files:**
- Create: `scripts/lib/lease.mjs`
- Test: `tests/lease.test.mjs`

**Interfaces:**
- Consumes: `state.runDir/readState/writeState/withLock`, `envelope.contentHash`.
- Produces:
  - `deriveIdempotencyKey(ownerRunId, ownerGeneration, triggerReason): string` — 결정론 16-hex 키.
  - `leaseCheck(loop, {owner, generation, intent='business'}): {ok, reason}` — 펜싱 가드(읽기 외 mutating 경로용). owner/generation/state 만 검사(expiry 로 active 소유자를 fence하지 않음 — Codex r2 🔴2). `intent='lease'`는 carve-out(releasing 중 자기 lease 관리만 허용).
  - `acquireLease(root, runId, {owner, expectGeneration, now?}): {ok, generation, reason}` — CAS 인수(released/expired만 가능, `generation === expectGeneration` 필수, 성공 시 `generation+1` · `phase='acquired'` · 키 클리어). 같은 owner 활성 재획득은 멱등.
  - `releaseLease(root, runId, {owner, generation, now?}): {ok, reason}` — `state='released'`(펜싱).
  - `reserveHandoff(root, runId, {trigger, now?}): {ok, reserved, key, childRunId, reason}` — `phase∈{idle,acquired}`일 때만 CAS 예약(→reserved) + **childRunId 를 예약 시점에 결정·영속**(중복 child 방지, Codex r3 🔴1). 그 외엔 같은 키면 멱등 no-op(같은 childRunId 반환), 다른 트리거면 거부(이중 spawn 봉인).
  - `advanceHandoffPhase(root, runId, {key, toPhase, now?}): {ok, reason}` — 키 일치 + 순방향 1단계만(`reserved→emitted→spawned`). `emitted`에서 `state='releasing'`(부모 carve-out 시작).
  - `rollbackHandoff(root, runId, {owner, generation, now?}): {ok, reason}` — launch 실패용: `state='active'` · `phase='idle'` · 키 클리어(펜싱).

- [ ] **Step 1: Write the failing test**

`tests/lease.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import {
  deriveIdempotencyKey, leaseCheck, acquireLease, releaseLease,
  reserveHandoff, advanceHandoffPhase, rollbackHandoff,
} from '../scripts/lib/lease.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('deriveIdempotencyKey is deterministic and trigger-sensitive', () => {
  const a = deriveIdempotencyKey('R', 1, 'milestone');
  assert.equal(a, deriveIdempotencyKey('R', 1, 'milestone'));
  assert.notEqual(a, deriveIdempotencyKey('R', 1, 'precompact'));
  assert.notEqual(a, deriveIdempotencyKey('R', 2, 'milestone'));
});

test('leaseCheck passes for current owner+generation, rejects mismatch; active owner never time-fenced', () => {
  const { root, runId } = seed();
  const { data } = readState(root, runId);
  assert.equal(leaseCheck(data, { owner: runId, generation: 1 }).ok, true);
  assert.equal(leaseCheck(data, { owner: 'OTHER', generation: 1 }).ok, false);
  assert.equal(leaseCheck(data, { owner: runId, generation: 2 }).ok, false);
  // Codex r2 🔴2: active 소유자는 expires_at 가 과거여도 fence 되지 않는다 (deadlock 방지). leaseCheck 는 시간을 안 본다.
  data.session_chain.lease.expires_at = '2000-01-01T00:00:00Z';
  assert.equal(leaseCheck(data, { owner: runId, generation: 1 }).ok, true);
});

test('reserveHandoff dedups concurrent triggers (PreCompact no-op after Decide)', () => {
  const { root, runId } = seed();
  const decide = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(decide.reserved, true);
  const precompact = reserveHandoff(root, runId, { trigger: 'precompact' });
  assert.equal(precompact.ok, false);
  assert.equal(precompact.reason, 'handoff-in-flight');
  // same trigger re-entry is idempotent (ok, not re-reserved)
  const retry = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(retry.ok, true);
  assert.equal(retry.reserved, false);
  assert.equal(readState(root, runId).data.session_chain.lease.handoff_phase, 'reserved');
});

test('advanceHandoffPhase enforces forward-only and sets releasing on emitted', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'spawned' }).ok, false); // skip
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'emitted' }).ok, true);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
  assert.equal(advanceHandoffPhase(root, runId, { key: 'wrong', toPhase: 'spawned' }).ok, false); // key fence
  assert.equal(advanceHandoffPhase(root, runId, { key, toPhase: 'spawned' }).ok, true);
});

test('acquireLease: child takes over released lease, generation+1; stale generation rejected', () => {
  const { root, runId } = seed();
  // parent releases (after spawning a child)
  releaseLease(root, runId, { owner: runId, generation: 1 });
  // wrong expectGeneration → fenced
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 5 }).ok, false);
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.owner_run_id, 'CHILD');
  assert.equal(lease.state, 'active');
  assert.equal(lease.handoff_phase, 'acquired');
  assert.equal(lease.handoff_idempotency_key, null);
});

test('acquireLease: active lease is never stolen (even past expires_at); released is takeable', () => {
  const { root, runId } = seed();
  // active → not takeable by another owner
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1 }).ok, false);
  // 심지어 active 에 과거 expires_at 이 있어도 탈취 불가 (active 는 deadline 없음 — Codex r2 🔴2)
  const { data } = readState(root, runId);
  data.session_chain.lease.expires_at = new Date(Date.parse('2026-06-24T00:00:00Z') + 1000).toISOString();
  writeState(root, runId, data);
  const future = Date.parse('2026-06-24T01:00:00Z');
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: future }).ok, false);
  // released → takeable, generation+1
  releaseLease(root, runId, { owner: runId, generation: 1 });
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: future });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
  assert.equal(readState(root, runId).data.session_chain.lease.expires_at, null);  // active = no deadline
});

test('rollbackHandoff restores active/idle (launch-failure path)', () => {
  const { root, runId } = seed();
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted' });
  const r = rollbackHandoff(root, runId, { owner: runId, generation: 1 });
  assert.equal(r.ok, true);
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'active');
  assert.equal(lease.handoff_phase, 'idle');
  assert.equal(lease.handoff_idempotency_key, null);
});

// Codex r1 🔴4: emitted 진입이 expires_at 를 설정해야 부모 크래시(releaseLease 누락) 후에도 자식이 TTL 경과로 인수 가능.
test('emitted sets expires_at → child can take over after stale TTL without explicit release', () => {
  const { root, runId } = seed();
  const now0 = Date.parse('2026-06-24T00:00:00Z');
  const { key } = reserveHandoff(root, runId, { trigger: 'milestone' });
  advanceHandoffPhase(root, runId, { key, toPhase: 'emitted', now: now0 });
  const lease = readState(root, runId).data.session_chain.lease;
  assert.equal(lease.state, 'releasing');
  assert.ok(lease.expires_at, 'expires_at must be set on emitted');
  // 부모가 releaseLease 를 못 하고 죽음. TTL(900s) 경과 전: 인수 불가(releasing 은 takeable 아님)
  assert.equal(acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: now0 + 1000 }).ok, false);
  // TTL 경과 후: stale → 인수 가능
  const ok = acquireLease(root, runId, { owner: 'CHILD', expectGeneration: 1, now: now0 + 901 * 1000 });
  assert.equal(ok.ok, true);
  assert.equal(ok.generation, 2);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/lease.test.mjs`
Expected: FAIL ("Cannot find module lease.mjs")

- [ ] **Step 3: Write `scripts/lib/lease.mjs`**

```javascript
import { contentHash, ulid } from './envelope.mjs';
import { readState, writeState, withLock } from './state.mjs';

const PHASE_ORDER = { idle: 0, reserved: 1, emitted: 2, spawned: 3, acquired: 4 };

export function deriveIdempotencyKey(ownerRunId, ownerGeneration, triggerReason) {
  return contentHash(`${ownerRunId}|${ownerGeneration}|${triggerReason}`).slice(0, 16);
}

// 펜싱 가드 — 읽기를 제외한 모든 커널 mutating 경로가 진입 전에 호출 (spec §9.1).
export function leaseCheck(loop, { owner, generation, intent = 'business' } = {}) {
  const lease = loop?.session_chain?.lease;
  if (!lease) return { ok: false, reason: 'no-lease' };
  if (lease.owner_run_id !== owner) return { ok: false, reason: 'owner-mismatch' };
  if (lease.generation !== generation) return { ok: false, reason: 'generation-mismatch' };
  if (lease.state === 'released') return { ok: false, reason: 'lease-released' };
  // 부모 carve-out: releasing 중 업무 write 거부, 자기 lease 관리(intent='lease')만 허용
  if (lease.state === 'releasing' && intent === 'business') return { ok: false, reason: 'lease-releasing-carveout' };
  // Codex r2 🔴2: expires_at 로 active 소유자를 fence 하지 않는다 — 살아있는 소유자가 TTL(15분) 후 자기 write 에서
  // 죽으면 안 됨. stale 소유자(자식이 인수해 generation 이 올라간 경우)는 generation-mismatch 로 이미 펜싱된다.
  // expires_at 는 오직 acquireLease 의 takeover 판단(releasing 크래시)에만 쓰인다.
  return { ok: true, reason: 'ok' };
}

// CAS 인수: released 또는 stale(expired)만, generation === expectGeneration 펜싱. 성공 시 generation+1.
export function acquireLease(root, runId, { owner, expectGeneration, now = Date.now() }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    // 같은 owner 가 이미 active 면 멱등 (active 는 만료 deadline 이 없다 — Codex r2 🔴2)
    if (lease.owner_run_id === owner && lease.state === 'active') {
      return { ok: true, generation: lease.generation, reason: 'already-owned' };
    }
    if (lease.generation !== expectGeneration) {
      return { ok: false, generation: lease.generation, reason: 'generation-mismatch' };
    }
    // takeover 가능: released(정상 인수) 또는 releasing+expired(부모가 handoff 중 크래시). active 는 절대 탈취 안 됨.
    const expired = lease.expires_at && now > Date.parse(lease.expires_at);
    const takeable = lease.state === 'released' || (lease.state === 'releasing' && expired);
    if (!takeable) return { ok: false, generation: lease.generation, reason: 'lease-not-takeable' };
    const iso = new Date(now).toISOString();
    data.session_chain.lease = {
      ...lease, owner_run_id: owner, generation: expectGeneration + 1,
      acquired_at: iso, expires_at: null,   // active 소유자는 deadline 없음 → 무기한 write (renewal 불필요)
      state: 'active', handoff_phase: 'acquired', handoff_idempotency_key: null, handoff_child_run_id: null,
    };
    const childEntry = data.session_chain.sessions.find(s => s.run_id === owner);
    if (childEntry && !childEntry.started_at) childEntry.started_at = iso;
    const parentEntry = data.session_chain.sessions.find(s => s.superseded_by === owner);
    if (parentEntry) parentEntry.outcome = 'took_over';
    writeState(root, runId, data);
    return { ok: true, generation: expectGeneration + 1, reason: 'acquired' };
  });
}

export function releaseLease(root, runId, { owner, generation }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    if (lease.owner_run_id !== owner || lease.generation !== generation) return { ok: false, reason: 'fenced' };
    data.session_chain.lease = { ...lease, state: 'released' };
    writeState(root, runId, data);
    return { ok: true, reason: 'released' };
  });
}

// 멱등키 선예약 CAS — phase∈{idle,acquired}에서만 신규 예약. 이중 트리거를 phase로 봉인 (spec §9.1).
export function reserveHandoff(root, runId, { trigger, now = Date.now() }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    const key = deriveIdempotencyKey(lease.owner_run_id, lease.generation, trigger);
    if (lease.handoff_phase === 'idle' || lease.handoff_phase === 'acquired') {
      // Codex r3 🔴1: childRunId 를 **예약 시점에 결정·영속**한다. 동시/재진입 emit 이 같은 child 를 보게 되어
      // (reserved:false fall-through 가 fresh child 를 만들지 않음) 중복 child 를 봉인한다.
      const childRunId = ulid(now);
      data.session_chain.lease = { ...lease, handoff_phase: 'reserved', handoff_idempotency_key: key, handoff_child_run_id: childRunId };
      writeState(root, runId, data);
      return { ok: true, reserved: true, key, childRunId, reason: 'reserved' };
    }
    if (lease.handoff_idempotency_key === key) return { ok: true, reserved: false, key, childRunId: lease.handoff_child_run_id, reason: 'already-reserved-same-trigger' };
    return { ok: false, reserved: false, key: lease.handoff_idempotency_key, childRunId: lease.handoff_child_run_id, reason: 'handoff-in-flight' };
  });
}

export function advanceHandoffPhase(root, runId, { key, toPhase, now = Date.now() }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    if (lease.handoff_idempotency_key !== key) return { ok: false, reason: 'key-mismatch' };
    const cur = PHASE_ORDER[lease.handoff_phase];
    const next = PHASE_ORDER[toPhase];
    if (next === undefined) return { ok: false, reason: `unknown-phase ${toPhase}` };
    if (next === cur) return { ok: true, reason: 'idempotent-noop' };
    if (next !== cur + 1) return { ok: false, reason: `illegal-transition ${lease.handoff_phase}->${toPhase}` };
    const patch = { handoff_phase: toPhase };
    if (toPhase === 'emitted') {
      // 부모 carve-out 시작 + stale TTL 설정. 부모가 emitted 후 죽어 releaseLease 를 못 해도
      // expires_at 경과 시 자식이 인수 가능 (Codex r1 🔴4: null expires_at 은 영원히 안 만료 → 데드락).
      patch.state = 'releasing';
      const ttlMs = (data.session_chain.stale_lease_ttl_sec || 900) * 1000;
      patch.expires_at = new Date(now + ttlMs).toISOString();
    }
    data.session_chain.lease = { ...lease, ...patch };
    writeState(root, runId, data);
    return { ok: true, reason: 'advanced' };
  });
}

export function rollbackHandoff(root, runId, { owner, generation }) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const lease = data.session_chain.lease;
    if (lease.owner_run_id !== owner || lease.generation !== generation) return { ok: false, reason: 'fenced' };
    // active 복귀 시 expires_at=null — 롤백된 부모가 emit 때 설정된 stale TTL 로 나중에 인수당하지 않게 (Codex r2 🔴2)
    data.session_chain.lease = { ...lease, state: 'active', handoff_phase: 'idle', handoff_idempotency_key: null, handoff_child_run_id: null, expires_at: null };
    writeState(root, runId, data);
    return { ok: true, reason: 'rolled-back' };
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/lease.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/lease.mjs tests/lease.test.mjs
git commit -m "feat(orch): lease — CAS acquire/release, generation fencing, handoff idempotency phase machine"
```

---

### Task 2: `workspace.mjs` — workstream 생애주기 + max_parallel + 터미널-from-proof + respawn 인수

**Files:**
- Create: `scripts/lib/workspace.mjs`
- Test: `tests/workspace.test.mjs`

**Interfaces:**
- Consumes: `state.runDir/readState/writeState/withLock`, `slug.slugify`, `integrity.appendAnchored`.
- Produces:
  - `newWorkstream(root, runId, {title, branch, worktree, baseCommit, dependsOn=[]}): {id}` — `id='ws-NN-<slug>'`, `status='planned'`, kernel-only 필드(branch/worktree/base_commit/depends_on) 기록, `'workstream-new'` 이벤트 append.
  - `setWorkstreamStatus(root, runId, wsId, status): void` — **비-터미널만**(planned/in_progress/in_review/parked). 터미널 값이면 throw `WORKSTREAM_TERMINAL_NO_PROOF`. `in_progress`로 전이 시 `active_workstreams`에 추가(≤ `max_parallel`, 초과 시 throw `MAX_PARALLEL_EXCEEDED`); `parked`면 active에서 제거.
  - `recordWorkstreamTerminal(root, runId, wsId, {status, proof}): void` — **커널 파생 터미널**(ready/merged/abandoned). `proof` 없거나 빈 객체면 throw `WORKSTREAM_TERMINAL_NO_PROOF`. active에서 제거 + `'workstream-terminal'` 이벤트.
  - `inheritWorkstreams(root, runId): {inherited, missing}` — active workstream worktree 경로 디스크 존재 확인. 누락은 **재생성하지 않고** `missing[]` 반환(fail-safe; 호출자가 needs-human). (spec §8)
  - `integrationOrder(loop): {order, cycle}` — `depends_on` 위상정렬(머지 순서), 순환 시 `cycle=true`. (spec §8.1)

- [ ] **Step 1: Write the failing test**

`tests/workspace.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import {
  newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal,
  inheritWorkstreams, integrationOrder,
} from '../scripts/lib/workspace.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('newWorkstream creates planned workstream with kernel fields', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'Auth Core', branch: 'dl/auth', worktree: '.worktrees/dl/auth', baseCommit: 'abc' });
  const ws = readState(root, runId).data.workstreams.find(w => w.id === id);
  assert.match(id, /^ws-01-auth-core$/);
  assert.equal(ws.status, 'planned');
  assert.equal(ws.branch, 'dl/auth');
  assert.equal(ws.worktree, '.worktrees/dl/auth');
});

test('setWorkstreamStatus non-terminal ok; terminal value rejected', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' });
  setWorkstreamStatus(root, runId, id, 'in_progress');
  assert.deepEqual(readState(root, runId).data.active_workstreams, [id]);
  assert.throws(() => setWorkstreamStatus(root, runId, id, 'merged'), /WORKSTREAM_TERMINAL_NO_PROOF/);
});

test('max_parallel enforced on activation', () => {
  const { root, runId } = seed(); // max_parallel default 2
  const a = newWorkstream(root, runId, { title: 'A', branch: 'a', worktree: 'wa' }).id;
  const b = newWorkstream(root, runId, { title: 'B', branch: 'b', worktree: 'wb' }).id;
  const c = newWorkstream(root, runId, { title: 'C', branch: 'c', worktree: 'wc' }).id;
  setWorkstreamStatus(root, runId, a, 'in_progress');
  setWorkstreamStatus(root, runId, b, 'in_progress');
  assert.throws(() => setWorkstreamStatus(root, runId, c, 'in_progress'), /MAX_PARALLEL_EXCEEDED/);
});

test('recordWorkstreamTerminal derives terminal from proof content; clears active', () => {
  const { root, runId } = seed();
  const { id } = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' });
  setWorkstreamStatus(root, runId, id, 'in_progress');
  // 빈/무관 proof 로는 ready 불가 (Codex r2 🔴5)
  assert.throws(() => recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: {} }), /WORKSTREAM_TERMINAL_NO_PROOF/);
  recordWorkstreamTerminal(root, runId, id, { status: 'ready', proof: { review_approved: true } });
  const { data } = readState(root, runId);
  assert.equal(data.workstreams.find(w => w.id === id).status, 'ready');
  assert.equal(data.active_workstreams.includes(id), false);
  // merged 는 사람 승인(merge_commit + human_approved) 필수 — 임의 proof 거부 (proposal-only)
  const { id: id2 } = newWorkstream(root, runId, { title: 'B', branch: 'b2', worktree: 'w2' });
  assert.throws(() => recordWorkstreamTerminal(root, runId, id2, { status: 'merged', proof: { x: true } }), /WORKSTREAM_TERMINAL_NO_PROOF/);
  recordWorkstreamTerminal(root, runId, id2, { status: 'merged', proof: { merge_commit: 'abc123', human_approved: true } });
  assert.equal(readState(root, runId).data.workstreams.find(w => w.id === id2).status, 'merged');
});

test('inheritWorkstreams reports missing worktree paths (no silent recreate)', () => {
  const { root, runId } = seed();
  const present = join(root, 'wt-present'); mkdirSync(present, { recursive: true });
  const a = newWorkstream(root, runId, { title: 'A', branch: 'a', worktree: present }).id;
  const b = newWorkstream(root, runId, { title: 'B', branch: 'b', worktree: join(root, 'wt-gone') }).id;
  setWorkstreamStatus(root, runId, a, 'in_progress');
  setWorkstreamStatus(root, runId, b, 'in_progress');
  const r = inheritWorkstreams(root, runId);
  assert.deepEqual(r.inherited, [a]);
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].id, b);
});

test('integrationOrder topo-sorts by depends_on and detects cycles', () => {
  const { root, runId } = seed();
  const core = newWorkstream(root, runId, { title: 'Core', branch: 'c', worktree: 'wc' }).id;
  const ui = newWorkstream(root, runId, { title: 'UI', branch: 'u', worktree: 'wu', dependsOn: [core] }).id;
  const { data } = readState(root, runId);
  const r = integrationOrder(data);
  assert.equal(r.cycle, false);
  assert.ok(r.order.indexOf(core) < r.order.indexOf(ui));
  // inject a cycle
  data.workstreams[0].depends_on = [ui];
  assert.equal(integrationOrder(data).cycle, true);
  // 미지 의존 → missing 보고 + order 비움 (Codex r2 🟡9)
  data.workstreams[0].depends_on = ['ws-99-nonexistent'];
  data.workstreams[1].depends_on = [];
  const m = integrationOrder(data);
  assert.equal(m.missing.length, 1);
  assert.deepEqual(m.order, []);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/workspace.test.mjs` → FAIL

- [ ] **Step 3: Write `scripts/lib/workspace.mjs`**

```javascript
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readState, writeState, withLock } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { slugify } from './slug.mjs';

const NON_TERMINAL = ['planned', 'in_progress', 'in_review', 'parked'];
const TERMINAL = ['ready', 'merged', 'abandoned'];

export function newWorkstream(root, runId, { title, branch, worktree, baseCommit = null, dependsOn = [] }) {
  let id;
  appendAnchored(root, runId, { type: 'workstream-new', data: { title } }, (loop) => {
    const n = String(loop.workstreams.length + 1).padStart(2, '0');
    id = `ws-${n}-${slugify(title) || 'ws'}`;
    loop.workstreams.push({
      id, title, status: 'planned', branch, worktree, base_commit: baseCommit,
      dirty_on_handoff: false, pr: { intended: true, state: 'none', url: null },
      episodes: [], review_points_done: [], depends_on: dependsOn,
    });
  });
  return { id };
}

export function setWorkstreamStatus(root, runId, wsId, status) {
  if (TERMINAL.includes(status)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${status} is kernel-derived (use recordWorkstreamTerminal)`);
  if (!NON_TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status}`);
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const ws = data.workstreams.find(w => w.id === wsId);
    if (!ws) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    if (status === 'in_progress' && !data.active_workstreams.includes(wsId)) {
      const cap = data.autonomy?.max_parallel ?? 2;
      if (data.active_workstreams.length >= cap) throw new Error(`MAX_PARALLEL_EXCEEDED: ${data.active_workstreams.length}/${cap}`);
      data.active_workstreams.push(wsId);
    }
    if (status === 'parked') data.active_workstreams = data.active_workstreams.filter(x => x !== wsId);
    ws.status = status;
    writeState(root, runId, data);
  });
}

export function recordWorkstreamTerminal(root, runId, wsId, { status, proof = {} }) {
  if (!TERMINAL.includes(status)) throw new Error(`WORKSTREAM_STATUS_INVALID: ${status} is not terminal`);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} requires proof object`);
  // Codex r2 🔴5: 터미널은 proof **내용**에서 파생/검증 — 임의 status+빈/무관 proof 로 ready/merged/abandoned 못 함 (spec §4).
  // 검증은 appendAnchored 이전(이벤트 append 전)에 — mutate 안에서 throw 하면 event_log_head 앵커가 stale 된다.
  const { data } = readState(root, runId);
  const ws = data.workstreams.find(w => w.id === wsId);
  if (!ws) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
  const reviewPoints = (data.review?.points || []);
  const ok =
    status === 'ready'     ? (proof.review_approved === true || (reviewPoints.length > 0 && reviewPoints.every(p => (ws.review_points_done || []).includes(p)))) :
    status === 'merged'    ? (typeof proof.merge_commit === 'string' && proof.human_approved === true) :   // 비가역 = 사람 승인 (proposal-only, §15)
    status === 'abandoned' ? (typeof proof.reason === 'string' && proof.reason.length > 0) : false;
  if (!ok) throw new Error(`WORKSTREAM_TERMINAL_NO_PROOF: ${wsId} -> ${status} proof insufficient`);
  appendAnchored(root, runId, { type: 'workstream-terminal', data: { id: wsId, status, proof } }, (loop) => {
    const w = loop.workstreams.find(x => x.id === wsId);
    if (!w) throw new Error(`WORKSTREAM_NOT_FOUND: ${wsId}`);
    w.status = status;
    loop.active_workstreams = loop.active_workstreams.filter(x => x !== wsId);
  });
}

// respawn 인수: active worktree 경로가 디스크에 존재하는지만 확인. 누락은 조용히 재생성 ❌ → fail-safe.
export function inheritWorkstreams(root, runId) {
  const { data } = readState(root, runId);
  const inherited = [], missing = [];
  for (const id of data.active_workstreams) {
    const ws = data.workstreams.find(w => w.id === id);
    if (!ws) { missing.push({ id, reason: 'workstream-record-missing' }); continue; }
    const path = isAbsolute(ws.worktree) ? ws.worktree : join(root, ws.worktree);
    if (existsSync(path)) inherited.push(id);
    else missing.push({ id, worktree: ws.worktree, reason: 'worktree-path-missing' });
  }
  return { inherited, missing };
}

// 머지 순서 = depends_on 위상정렬 (spec §8.1). 순환 + 미지 의존 탐지.
export function integrationOrder(loop) {
  const ws = loop.workstreams || [];
  const ids = new Set(ws.map(w => w.id));
  // Codex r2 🟡9: 미지 의존을 silent drop 하지 않는다 — 오타/누락 id 는 needs-human 에스컬레이션.
  const missing = [];
  for (const w of ws) for (const d of (w.depends_on || [])) if (!ids.has(d)) missing.push({ id: w.id, missing_dep: d });
  if (missing.length) return { order: [], cycle: false, missing };
  const deps = new Map(ws.map(w => [w.id, (w.depends_on || [])]));
  const order = [], state = new Map(); // 0=unseen 1=visiting 2=done
  let cycle = false;
  const visit = (id) => {
    if (cycle) return;
    const s = state.get(id) || 0;
    if (s === 2) return;
    if (s === 1) { cycle = true; return; }
    state.set(id, 1);
    for (const d of deps.get(id) || []) visit(d);
    state.set(id, 2);
    order.push(id);
  };
  for (const w of ws) visit(w.id);
  return { order: cycle ? [] : order, cycle, missing: [] };
}
```

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/workspace.test.mjs` → PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/workspace.mjs tests/workspace.test.mjs
git commit -m "feat(orch): workspace — workstream lifecycle, max_parallel, terminal-from-proof, respawn inherit, fan-in order"
```

---

### Task 3: `episode.mjs` — episode scaffold + record (터미널은 proof 파생)

**Files:**
- Create: `scripts/lib/episode.mjs`
- Test: `tests/episode.test.mjs`

**Interfaces:**
- Consumes: `state.runDir/readState/writeState/withLock`, `integrity.appendAnchored`, `envelope.atomicWrite`.
- Produces:
  - `newEpisode(root, runId, {plugin, role, kind, point, workstream, expectedArtifacts=[]}): {id, requestPath}` — `id='NNN-<plugin>'`, `status='pending'`, `runDir/episodes/<id>/request.md` 골격 작성, `verification`(checker 요구·proof_required) 채움, `comprehension.episodes_total++`, 워크스트림 `episodes[]`에 등록, `current_episode` 갱신, `'episode-new'` 이벤트.
  - `recordEpisode(root, runId, episodeId, {status, artifacts=[], proof}): void` — 비-터미널(pending/in_progress/blocked)은 직접 기록 + `result_*` 허용. 터미널(done/approved/rejected)은 **proof 파생**: `done`은 `expectedArtifacts` 경로가 모두 디스크 존재해야, `approved`는 `proof.verdict==='APPROVE'`, `rejected`는 `proof.verdict==='REQUEST_CHANGES'`. 불충족 시 throw `EPISODE_TERMINAL_NO_PROOF`. `'episode-record'` 이벤트.

- [ ] **Step 1: Write the failing test**

`tests/episode.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { newEpisode, recordEpisode } from '../scripts/lib/episode.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('newEpisode scaffolds request.md, bumps episodes_total, sets current', () => {
  const { root, runId } = seed();
  const { id, requestPath } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'implementation', point: 'implementation' });
  assert.match(id, /^001-deep-work$/);
  assert.ok(existsSync(requestPath));
  const { data } = readState(root, runId);
  assert.equal(data.comprehension.episodes_total, 1);
  assert.equal(data.current_episode, id);
  assert.equal(data.episodes[0].status, 'pending');
  assert.equal(data.episodes[0].verification.checker_episode_required, true);
});

test('recordEpisode non-terminal status + result_* allowed', () => {
  const { root, runId } = seed();
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation' });
  recordEpisode(root, runId, id, { status: 'in_progress', proof: { result_summary: 'started' } });
  assert.equal(readState(root, runId).data.episodes[0].status, 'in_progress');
});

test('recordEpisode done requires expected artifacts to exist', () => {
  const { root, runId } = seed();
  const art = join(root, 'out.txt');
  const { id } = newEpisode(root, runId, { plugin: 'deep-work', role: 'maker', kind: 'impl', point: 'implementation', expectedArtifacts: ['out.txt'] });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'] }), /EPISODE_TERMINAL_NO_PROOF/);
  writeFileSync(art, 'x');
  recordEpisode(root, runId, id, { status: 'done', artifacts: ['out.txt'] });
  assert.equal(readState(root, runId).data.episodes[0].status, 'done');
});

test('recordEpisode approved/rejected derive from verdict proof', () => {
  const { root, runId } = seed();
  const { id } = newEpisode(root, runId, { plugin: 'deep-review', role: 'checker', kind: 'impl-review', point: 'implementation' });
  assert.throws(() => recordEpisode(root, runId, id, { status: 'approved', proof: { verdict: 'REQUEST_CHANGES' } }), /EPISODE_TERMINAL_NO_PROOF/);
  recordEpisode(root, runId, id, { status: 'approved', proof: { verdict: 'APPROVE' } });
  assert.equal(readState(root, runId).data.episodes[0].status, 'approved');
});
```

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/episode.test.mjs` → FAIL

- [ ] **Step 3: Write `scripts/lib/episode.mjs`**

```javascript
import { mkdirSync, existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readState, writeState, withLock, runDir } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { atomicWrite } from './envelope.mjs';

const NON_TERMINAL = ['pending', 'in_progress', 'blocked'];
const TERMINAL = ['done', 'approved', 'rejected'];

function requestSkeleton({ id, plugin, role, kind, point, workstream, expectedArtifacts }) {
  return [
    `# Episode ${id} — request`, '',
    `- plugin: ${plugin}`, `- role: ${role}`, `- kind: ${kind}`,
    `- review point: ${point}`, `- workstream: ${workstream || '(none)'}`, '',
    '## Task', '', '<!-- Execution plane: fill the maker/checker task here -->', '',
    '## Expected artifacts', '', ...(expectedArtifacts.length ? expectedArtifacts.map(a => `- ${a}`) : ['- <!-- list proof artifacts -->']), '',
    '## Constraints', '', '- 이전 대화 컨텍스트를 가정하지 말라. loop.json + 이 request가 source of truth.', '',
  ].join('\n');
}

export function newEpisode(root, runId, { plugin, role, kind, point, workstream = null, expectedArtifacts = [] }) {
  let id, requestPath;
  appendAnchored(root, runId, { type: 'episode-new', data: { plugin, role, kind, point } }, (loop) => {
    const n = String(loop.episodes.length + 1).padStart(3, '0');
    id = `${n}-${plugin}`;
    const dir = join(runDir(root, runId), 'episodes', id);
    mkdirSync(dir, { recursive: true });
    requestPath = join(dir, 'request.md');
    atomicWrite(requestPath, requestSkeleton({ id, plugin, role, kind, point, workstream, expectedArtifacts }));
    loop.episodes.push({
      id, plugin, role, kind, point, workstream_id: workstream, status: 'pending',
      request_path: requestPath, expected_artifacts: expectedArtifacts,
      verification: { checker_episode_required: role === 'maker', checker_plugin: 'deep-review', review_point: point, proof_required: expectedArtifacts },
    });
    loop.current_episode = id;
    loop.comprehension.episodes_total = (loop.comprehension.episodes_total || 0) + 1;
    if (workstream) {
      const ws = loop.workstreams.find(w => w.id === workstream);
      if (ws) ws.episodes.push(id);
    }
  });
  return { id, requestPath };
}

export function recordEpisode(root, runId, episodeId, { status, artifacts = [], proof = {} }) {
  if (![...NON_TERMINAL, ...TERMINAL].includes(status)) throw new Error(`EPISODE_STATUS_INVALID: ${status}`);
  // Codex r3 🔴5: appendAnchored 의 mutate 가 throw 하면 event 가 이미 append 된 뒤라 event_log_head 앵커가 stale 된다.
  // → 모든 실패 조건(존재 + 터미널 proof)을 appendAnchored **이전에** 검증한다.
  const ep0 = readState(root, runId).data.episodes.find(e => e.id === episodeId);
  if (!ep0) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  // 터미널은 커널이 proof에서 파생 — 검증 후에만 (spec §4)
  if (TERMINAL.includes(status)) {
    if (status === 'done') {
      const expected = (ep0.expected_artifacts || []);
      const missing = expected.filter(a => !existsSync(isAbsolute(a) ? a : join(root, a)));
      if (expected.length === 0 || missing.length) {
        throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} done requires existing artifacts (missing: ${missing.join(',') || 'none-declared'})`);
      }
    } else if (status === 'approved' && !['APPROVE', 'CONCERN'].includes(proof.verdict)) {
      throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} approved requires proof.verdict=APPROVE|CONCERN (accepted concern)`);
    } else if (status === 'rejected' && proof.verdict !== 'REQUEST_CHANGES') {
      throw new Error(`EPISODE_TERMINAL_NO_PROOF: ${episodeId} rejected requires proof.verdict=REQUEST_CHANGES`);
    }
  }
  appendAnchored(root, runId, { type: 'episode-record', data: { id: episodeId, status, artifacts } }, (loop) => {
    const ep = loop.episodes.find(e => e.id === episodeId);
    if (!ep) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);   // 방어적(이미 위에서 검증됨)
    ep.status = status;
    if (artifacts.length) ep.artifacts = artifacts;
    for (const [k, v] of Object.entries(proof)) if (/^result_[A-Za-z0-9_]+$/.test(k)) ep[k] = v;
  });
}
```

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/episode.test.mjs` → PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/episode.mjs tests/episode.test.mjs
git commit -m "feat(orch): episode — request.md scaffold + record, terminal status derived from proof artifacts"
```

---

### Task 4: `review.mjs` — review dispatch 설정 + verdict 파싱 + outcome 기록

**Files:**
- Create: `scripts/lib/review.mjs`
- Test: `tests/review.test.mjs`

**Interfaces:**
- Consumes: `state.readState/writeState/withLock`, `episode.newEpisode`, `breaker.recordReviewVerdict`, `comprehension.recordReviewed`.
- Produces:
  - `resolveReviewer(loop, detected): {reviewer, flags, mode}` — `review.reviewer`가 `deep-review-loop`인데 deep-review 미설치면 폴백(codex 감지 시 `codex-cross`, 아니면 `subagent-checker`). (spec §7)
  - `dispatchReview(root, runId, {point, workstreamId, detected}): {checkerEpisodeId, reviewer, descriptor}` — checker episode 생성(role='checker', `kind='<point>-review'`) + Execution LLM이 dispatch할 디스크립터 반환(**커널은 호출 안 함**, §1.1).
  - `parseVerdict(text): 'APPROVE'|'REQUEST_CHANGES'|'CONCERN'|null` — 결정론 파싱(JSON `verdict` 우선, 아니면 키워드).
  - `recordReviewOutcome(root, runId, {episodeId, workstreamId, point, verdict, source='deep-review-approve'}): void` — APPROVE: workstream `review_points_done`에 point 추가 + breaker 리셋 + comprehension 카운트. REQUEST_CHANGES: breaker 카운터++. (각각 자기 lock — 순차 호출, 비중첩)

- [ ] **Step 1: Write the failing test**

`tests/review.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { resolveReviewer, dispatchReview, parseVerdict, recordReviewOutcome } from '../scripts/lib/review.mjs';

function seed(detected = { 'deep-review': true }) {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', detected, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('resolveReviewer falls back when deep-review absent', () => {
  const { root, runId } = seed({ 'deep-review': false, codex: true });
  const { data } = readState(root, runId);
  assert.equal(resolveReviewer(data, { 'deep-review': false, codex: true }).reviewer, 'codex-cross');
  assert.equal(resolveReviewer(data, { 'deep-review': false, codex: false }).reviewer, 'subagent-checker');
});

test('parseVerdict reads JSON verdict then keywords', () => {
  assert.equal(parseVerdict('{"verdict":"APPROVE","summary":"ok"}'), 'APPROVE');
  assert.equal(parseVerdict('Overall: REQUEST_CHANGES on 2 findings'), 'REQUEST_CHANGES');
  assert.equal(parseVerdict('looks good, APPROVE'), 'APPROVE');
  assert.equal(parseVerdict('no verdict here'), null);
  assert.equal(parseVerdict('do not APPROVE this'), null);   // 부정문 (Codex r4 ℹ️2)
});

test('dispatchReview creates checker episode + returns descriptor (no call)', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'implementation', workstreamId: ws, detected: { 'deep-review': true } });
  assert.equal(r.reviewer, 'deep-review-loop');
  assert.equal(r.descriptor.kind, 'invoke_skill');
  const ep = readState(root, runId).data.episodes.find(e => e.id === r.checkerEpisodeId);
  assert.equal(ep.role, 'checker');
  assert.equal(ep.kind, 'implementation-review');
});

test('recordReviewOutcome derives checker terminal + drives breaker/comprehension/points', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  // REQUEST_CHANGES → checker rejected + breaker++ (Codex r1 🔴5: checker 터미널 파생)
  const r1 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  recordReviewOutcome(root, runId, { episodeId: r1.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES' });
  let d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r1.checkerEpisodeId).status, 'rejected');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 1);
  // APPROVE (new round) → checker approved + point done + breaker reset + comprehension
  const r2 = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  recordReviewOutcome(root, runId, { episodeId: r2.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROVE' });
  d = readState(root, runId).data;
  assert.equal(d.episodes.find(e => e.id === r2.checkerEpisodeId).status, 'approved');
  assert.equal(d.circuit_breaker.consecutive_request_changes, 0);
  assert.ok(d.workstreams.find(w => w.id === ws).review_points_done.includes('plan'));
});

// (RC → nextAction=fix_episode 종단 테스트는 Task 6 next-action.test.mjs 로 이동 — Task 4 는 next-action.mjs 미존재. Codex r5 🟡1)

// Codex r2 🔴6: invalid verdict 는 어떤 변경(breaker) 전에 거부.
test('recordReviewOutcome rejects invalid verdict before mutating breaker', () => {
  const { root, runId } = seed();
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  const before = readState(root, runId).data.circuit_breaker.consecutive_request_changes;
  assert.throws(() => recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'APPROV' }), /REVIEW_VERDICT_INVALID/);
  assert.equal(readState(root, runId).data.circuit_breaker.consecutive_request_changes, before);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/review.test.mjs` → FAIL

- [ ] **Step 3: Write `scripts/lib/review.mjs`**

```javascript
import { readState, writeState, withLock } from './state.mjs';
import { newEpisode, recordEpisode } from './episode.mjs';
import { recordReviewVerdict } from './breaker.mjs';
import { recordReviewed } from './comprehension.mjs';

export function resolveReviewer(loop, detected = {}) {
  const r = loop.review || {};
  let reviewer = r.reviewer || 'subagent-checker';
  if ((reviewer === 'deep-review-loop' || reviewer === 'deep-review') && !detected['deep-review']) {
    reviewer = detected['codex'] ? 'codex-cross' : 'subagent-checker';
  }
  return { reviewer, flags: r.flags || [], mode: r.mode || 'cross-model' };
}

export function parseVerdict(text) {
  if (text == null) return null;
  const s = String(text);
  try { const v = JSON.parse(s)?.verdict; if (['APPROVE', 'REQUEST_CHANGES', 'CONCERN'].includes(v)) return v; } catch { /* not json */ }
  if (/REQUEST_CHANGES/.test(s)) return 'REQUEST_CHANGES';
  if (/\bCONCERN\b/.test(s)) return 'CONCERN';
  if (/\b(?:do not|don't|not|never|cannot|can't)\s+approve\b/i.test(s)) return null;  // 부정문 오분류 방지 (Codex r4 ℹ️2)
  if (/\bAPPROVE\b/.test(s)) return 'APPROVE';
  return null;
}

// checker episode 생성 + dispatch 디스크립터 반환 — 커널은 sibling을 호출하지 않음 (spec §1.1·§6).
export function dispatchReview(root, runId, { point, workstreamId, detected = {} }) {
  const { data } = readState(root, runId);
  const { reviewer, flags, mode } = resolveReviewer(data, detected);
  const { id } = newEpisode(root, runId, { plugin: reviewer === 'deep-review-loop' ? 'deep-review' : reviewer, role: 'checker', kind: `${point}-review`, point, workstream: workstreamId });
  const skillByReviewer = {
    'deep-review-loop': 'deep-review:deep-review-loop',
    'codex-cross': 'codex:rescue',
    'subagent-checker': 'Task(code-reviewer)',
    'standalone': 'inline-review',
  };
  const descriptor = { kind: reviewer === 'standalone' ? 'inline' : 'invoke_skill', skill: skillByReviewer[reviewer] || 'inline-review', args: flags.join(' '), mode, review_point: point, workstream: workstreamId };
  return { checkerEpisodeId: id, reviewer, descriptor };
}

export function recordReviewOutcome(root, runId, { episodeId, workstreamId, point, verdict, source = 'deep-review-approve' }) {
  // Codex r2 🔴6 / r3 🔴5: 어떤 상태 변경(breaker/episode) 전에 verdict + episode/workstream 존재를 검증 — 부분 변조/앵커 stale 방지.
  if (!['APPROVE', 'CONCERN', 'REQUEST_CHANGES'].includes(verdict)) throw new Error(`REVIEW_VERDICT_INVALID: ${verdict}`);
  const pre = readState(root, runId).data;
  if (!pre.episodes.find(e => e.id === episodeId)) throw new Error(`EPISODE_NOT_FOUND: ${episodeId}`);
  if (workstreamId && !pre.workstreams.find(w => w.id === workstreamId)) throw new Error(`WORKSTREAM_NOT_FOUND: ${workstreamId}`);
  recordReviewVerdict(root, runId, verdict);              // 자기 lock — breaker 카운터
  // Codex r1 🔴5: checker episode 터미널 상태를 verdict proof 에서 파생 — 안 하면 checker 가 pending 으로 남아
  // nextAction 이 fix_episode 로 진입 못 하고 finish 로 오폴백한다. 'accepted concern'(CONCERN)도 pass (spec §7).
  const passed = verdict === 'APPROVE' || verdict === 'CONCERN';
  recordEpisode(root, runId, episodeId, { status: passed ? 'approved' : 'rejected', proof: { verdict } });  // 자기 lock(appendAnchored)
  if (passed) {
    withLock(root, runId, () => {                          // review_points_done(kernel 필드) 기록
      const { data } = readState(root, runId);
      const ws = data.workstreams.find(w => w.id === workstreamId);
      if (ws && !ws.review_points_done.includes(point)) ws.review_points_done.push(point);
      writeState(root, runId, data);
    });
    recordReviewed(root, runId, episodeId, source);        // 자기 lock — comprehension
  }
  // REQUEST_CHANGES → checker='rejected'. nextAction 이 fix_episode 디스크립터를 반환하고 Execution 이 fix maker 를 생성.
  return { verdict, passed, terminal: passed ? 'approved' : 'rejected' };
}
```

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/review.test.mjs` → PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/review.mjs tests/review.test.mjs
git commit -m "feat(orch): review — reviewer resolution/fallback, verdict parse, dispatch descriptor, outcome recording"
```

---

### Task 5: `adapters.mjs` + `protocols/*.json` — 4-verb 프로토콜 어댑터 (디스크립터 반환)

**Files:**
- Create: `protocols/deep-work.json`, `protocols/superpowers.json`, `protocols/standalone.json`
- Create: `scripts/lib/adapters.mjs`
- Test: `tests/adapters.test.mjs`

**Interfaces:**
- Consumes: `envelope.unwrap`, `log.warn`.
- Produces:
  - `loadProtocol(name): object` — `protocols/<name>.json` 로드.
  - `resolveAdapter(name): {protocol, dispatch, awaitResult, checker, readArtifacts}` — 4-verb. `dispatch(brief)`/`awaitResult(ref)`/`checker(ref,reviewConfig)`는 **디스크립터 반환**(실제 호출/폴링은 Execution LLM, §6). `readArtifacts(ref)`는 receipt 파일을 읽어 identity guard(§10) 적용 — 불일치 시 throw 금지 → `null` + stderr 경고.
  - `guardTierProtocol(tier, protocol, verb): {ok, reason}` — `read-only`+superpowers의 implementer dispatch 등 모순 조합 차단(§6).

- [ ] **Step 1: 프로토콜 JSON 3개 작성**

`protocols/deep-work.json`:
```json
{
  "protocol": "deep-work",
  "dispatch": { "kind": "invoke_skill", "skill": "deep-work:deep-work-orchestrator", "args_template": "\"<task>\" --tdd=strict" },
  "await": { "kind": "poll_file", "path_template": ".deep-work/<task>/session-receipt.json", "done_when": { "field": "current_phase", "equals": "idle" } },
  "read": { "receipt_path_template": ".deep-work/<task>/session-receipt.json", "producer": "deep-work", "artifact_kind": "session-receipt" },
  "implementer_verb": "dispatch"
}
```
`protocols/superpowers.json`:
```json
{
  "protocol": "superpowers",
  "dispatch": { "kind": "invoke_skill", "skill": "superpowers:writing-plans", "args_template": "<task>", "then": "superpowers:subagent-driven-development" },
  "await": { "kind": "poll_file", "path_template": "docs/superpowers/plans/<task>.md", "done_when": { "exists": true } },
  "read": { "receipt_path_template": "docs/superpowers/plans/<task>.md", "producer": null, "artifact_kind": null },
  "implementer_verb": "then"
}
```
`protocols/standalone.json`:
```json
{
  "protocol": "standalone",
  "dispatch": { "kind": "inline", "skill": null, "args_template": "<task>" },
  "await": { "kind": "inline", "path_template": null, "done_when": { "inline": true } },
  "read": { "receipt_path_template": null, "producer": "deep-loop", "artifact_kind": "minimal-receipt" },
  "implementer_verb": "dispatch"
}
```

- [ ] **Step 2: Write the failing test**

`tests/adapters.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wrap } from '../scripts/lib/envelope.mjs';
import { loadProtocol, resolveAdapter, guardTierProtocol } from '../scripts/lib/adapters.mjs';

test('loadProtocol reads declarative protocol', () => {
  assert.equal(loadProtocol('deep-work').protocol, 'deep-work');
  assert.equal(loadProtocol('standalone').dispatch.kind, 'inline');
});

test('dispatch verb fills template + returns descriptor (no call)', () => {
  const a = resolveAdapter('deep-work');
  const d = a.dispatch({ task: 'auth-core' });
  assert.equal(d.kind, 'invoke_skill');
  assert.equal(d.skill, 'deep-work:deep-work-orchestrator');
  assert.match(d.args, /auth-core/);
});

test('awaitResult returns poll descriptor with concrete path', () => {
  const a = resolveAdapter('deep-work');
  const d = a.awaitResult({ task: 'auth-core' });
  assert.equal(d.kind, 'poll_file');
  assert.match(d.path, /\.deep-work\/auth-core\/session-receipt\.json$/);
});

test('readArtifacts applies identity guard: null on mismatch, payload on match', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const dir = join(root, '.deep-work', 'auth-core'); mkdirSync(dir, { recursive: true });
  const p = join(dir, 'session-receipt.json');
  writeFileSync(p, JSON.stringify(wrap({ producer: 'deep-work', artifact_kind: 'session-receipt', schema: { name: 'session-receipt', version: '1.0' }, run_id: 'X', payload: { outcome: 'done' } })));
  const a = resolveAdapter('deep-work');
  const ok = a.readArtifacts({ root, task: 'auth-core' });
  assert.equal(ok.receipt.payload.outcome, 'done');
  // wrong producer → guard returns null receipt + no throw
  writeFileSync(p, JSON.stringify(wrap({ producer: 'evil', artifact_kind: 'session-receipt', schema: { name: 'session-receipt', version: '1.0' }, run_id: 'X', payload: {} })));
  assert.equal(a.readArtifacts({ root, task: 'auth-core' }).receipt, null);
});

// Codex r4 🟡1: superpowers(producer:null) 는 markdown 을 JSON.parse 하지 않고 원문 receipt 로 반환.
test('superpowers readArtifacts returns raw markdown (producer:null)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const dir = join(root, 'docs', 'superpowers', 'plans'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'auth-core.md'), '# Plan\n\nbody');
  const r = resolveAdapter('superpowers').readArtifacts({ root, task: 'auth-core' });
  assert.equal(r.receipt.kind, 'raw');
  assert.match(r.receipt.content, /# Plan/);
  assert.equal(r.proofs.length, 1);
});

test('guardTierProtocol blocks read-only superpowers implementer dispatch', () => {
  assert.equal(guardTierProtocol('read-only', 'superpowers', 'then').ok, false);
  assert.equal(guardTierProtocol('recommend', 'superpowers', 'then').ok, true);
  assert.equal(guardTierProtocol('read-only', 'deep-work', 'awaitResult').ok, true);
});
```

- [ ] **Step 3: Run to verify fail** — Run: `node --test tests/adapters.test.mjs` → FAIL

- [ ] **Step 4: Write `scripts/lib/adapters.mjs`**

```javascript
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unwrap } from './envelope.mjs';
import { warn } from './log.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const protocolsDir = join(here, '../../protocols');

export function loadProtocol(name) {
  return JSON.parse(readFileSync(join(protocolsDir, `${name}.json`), 'utf8'));
}

const fill = (tpl, brief) => String(tpl || '').replace(/<task>/g, brief.task ?? '');

export function resolveAdapter(name) {
  const p = loadProtocol(name);
  return {
    protocol: p.protocol,
    dispatch: (brief) => ({ kind: p.dispatch.kind, skill: p.dispatch.skill, then: p.dispatch.then || null, args: fill(p.dispatch.args_template, brief) }),
    awaitResult: (ref) => ({ kind: p.await.kind, path: p.await.path_template ? fill(p.await.path_template, ref) : null, doneWhen: p.await.done_when }),
    checker: (ref, reviewConfig = {}) => ({ kind: 'invoke_skill', review_point: ref.point, reviewer: reviewConfig.reviewer || null }),
    readArtifacts: (ref) => {
      const rel = p.read.receipt_path_template ? fill(p.read.receipt_path_template, ref) : null;
      if (!rel) return { receipt: null, proofs: [] };
      const path = join(ref.root || '.', rel);
      if (!existsSync(path)) return { receipt: null, proofs: [] };
      const raw = readFileSync(path, 'utf8');
      // producer:null (superpowers 등 비-envelope, 예: markdown 플랜/리포트) → JSON.parse 하지 않고 원문을 정규화 receipt 로 반환 (Codex r4 🟡1)
      if (!p.read.producer) return { receipt: { kind: 'raw', path: rel, content: raw }, proofs: [path] };
      let obj; try { obj = JSON.parse(raw); } catch { warn(`adapter ${name}: non-JSON receipt at ${rel}`); return { receipt: null, proofs: [path] }; }
      const guarded = unwrap(obj, { producer: p.read.producer, artifact_kind: p.read.artifact_kind });
      if (!guarded) { warn(`adapter ${name}: identity guard mismatch at ${rel} (legacy/foreign artifact ignored)`); return { receipt: null, proofs: [path] }; }
      return { receipt: guarded, proofs: [path] };
    },
  };
}

// tier×protocol 모순 가드 (spec §6). read-only는 maker dispatch(implementer 전이) 금지.
export function guardTierProtocol(tier, protocol, verb) {
  const p = loadProtocol(protocol);
  if (tier === 'read-only' && verb === p.implementer_verb && (p.dispatch.kind === 'invoke_skill' || p.dispatch.kind === 'inline')) {
    return { ok: false, reason: `read-only tier cannot dispatch implementer for ${protocol}` };
  }
  return { ok: true, reason: 'ok' };
}
```

- [ ] **Step 5: Run to verify pass** — Run: `node --test tests/adapters.test.mjs` → PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add protocols scripts/lib/adapters.mjs tests/adapters.test.mjs
git commit -m "feat(orch): adapters — 4-verb protocol adapters (descriptor-returning) + identity guard + tier guard"
```

---

### Task 6: `next-action.mjs` — 다음 행동 디스크립터 + 게이트 판정 (dispatch 안 함)

**Files:**
- Create: `scripts/lib/next-action.mjs`
- Test: `tests/next-action.test.mjs`

**Interfaces:**
- Consumes: `budget.checkBudget`, `breaker.checkBreaker`, `comprehension.computeDebt`.
- Produces:
  - `nextAction(loop, {now?}): {gate, action, next_command}` — **순수 함수**(상태 변경/ dispatch ❌, §1.1). `gate={allowed, blocked_by:[], reason, tier_after}`. **budget hard-stop/breaker 는 전역 차단**(handoff/await_human). **comprehension-debt 는 `discover`(새 fan-out)만 차단** — 현재 episode 진행/fix/리뷰/finish 는 허용(spec §15). action 타입:
    - episode 없음 + 전체 비어있음 → `'discover'` (debt blocked 면 `'await_human'`)
    - maker `pending`→`'dispatch_maker'` / `in_progress`→`'await_result'` / `blocked`→`'await_human'` / `done`→`'dispatch_checker'`
    - checker `pending`→`'dispatch_checker'` / `in_progress`→`'await_result'`(재dispatch ❌) / `rejected`→`'fix_episode'` / `approved`→finishOrAdvance
    - `per_session_turn_cap` 도달 → `'handoff'`
    - `'finish'`는 **active_workstreams 0 AND 모든 episode ∈ {done,approved}** 일 때만; 그 외 미완 작업 잔존 시 `'await_human'`

- [ ] **Step 1: Write the failing test**

`tests/next-action.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInitialLoop, initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';
import { newWorkstream } from '../scripts/lib/workspace.mjs';
import { dispatchReview, recordReviewOutcome } from '../scripts/lib/review.mjs';
import { nextAction } from '../scripts/lib/next-action.mjs';

function loop(over = {}) {
  const l = buildInitialLoop({ goal: 'g', protocol: 'deep-work', recipe: { id: 'r', name: 'r', reason: '' }, runId: 'R', now: new Date('2026-06-24T00:00:00Z') });
  return Object.assign(l, over);
}

test('fresh run with no episodes → discover', () => {
  const r = nextAction(loop(), { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.gate.allowed, true);
  assert.equal(r.action.type, 'discover');
});

test('budget hard stop → gate blocked, handoff', () => {
  const l = loop(); l.budget.spent = l.budget.total;
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.gate.allowed, false);
  assert.ok(r.gate.blocked_by.includes('budget'));
  assert.equal(r.action.type, 'handoff');
});

test('breaker tripped → gate blocked, await_human', () => {
  const l = loop(); l.circuit_breaker.tripped = true;
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.gate.allowed, false);
  assert.ok(r.gate.blocked_by.includes('breaker'));
  assert.equal(r.action.type, 'await_human');
});

test('pending maker episode → dispatch_maker', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'pending', point: 'implementation', workstream_id: 'ws-01' }];
  l.current_episode = '001-deep-work';
  const r = nextAction(l, { now: Date.parse('2026-06-24T00:00:00Z') });
  assert.equal(r.action.type, 'dispatch_maker');
  assert.equal(r.action.episode_id, '001-deep-work');
});

test('done maker at review point → dispatch_checker', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'done', point: 'implementation', workstream_id: 'ws-01' }];
  l.current_episode = '001-deep-work';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'dispatch_checker');
});

test('per_session_turn_cap reached → handoff', () => {
  const l = loop();
  l.budget.per_session_turn_cap = 5;
  l.session_chain.sessions = [{ run_id: 'R', started_at: l.created_at, ended_at: null, turns: 5, outcome: null, superseded_by: null }];
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'pending', point: 'implementation' }];
  l.current_episode = '001-deep-work';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'handoff');
});

// Codex r1 🔴5: 리뷰 outcome 이 checker 터미널을 세팅한 뒤 nextAction 이 fix flow 로 진입해야 (finish 오폴백 금지).
test('checker rejected → fix_episode; checker approved → finish (no fall-through)', () => {
  const l = loop();
  l.episodes = [{ id: '002-deep-review', role: 'checker', status: 'rejected', point: 'plan', workstream_id: 'ws-01' }];
  l.current_episode = '002-deep-review';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'fix_episode');
  l.episodes[0].status = 'approved';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'finish');
});

// Codex r2 🔴7: in_progress/blocked 는 finish/재dispatch 가 아니라 await.
test('in-progress→await_result, blocked→await_human, checker in_progress not re-dispatched', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'in_progress', point: 'implementation' }];
  l.current_episode = '001-deep-work';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_result');
  l.episodes[0].status = 'blocked';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_human');
  l.episodes = [{ id: '002-deep-review', role: 'checker', status: 'in_progress', point: 'plan' }];
  l.current_episode = '002-deep-review';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_result');
});

// Codex r2 🔴7 / r3 🔴4: finish 는 active workstream 0 + done maker 가 리뷰 통과일 때만.
test('finish gated on review of done makers AND zero active workstreams', () => {
  const l = loop();
  l.episodes = [{ id: '001-deep-work', role: 'maker', status: 'done', point: 'implementation', workstream_id: 'ws-01' }];
  l.current_episode = null;
  l.workstreams = [{ id: 'ws-01', review_points_done: [] }];
  l.active_workstreams = [];
  // 리뷰 안 된 done maker → finish 가 아니라 checker dispatch (리뷰 게이트)
  assert.equal(nextAction(l, { now: 0 }).action.type, 'dispatch_checker');
  l.workstreams[0].review_points_done = ['implementation'];   // 리뷰 통과 처리
  l.active_workstreams = ['ws-01'];                            // 그러나 active workstream 잔존 → finish 금지
  assert.equal(nextAction(l, { now: 0 }).action.type, 'await_human');
  l.active_workstreams = [];                                   // active 0 + 리뷰 통과 → finish
  assert.equal(nextAction(l, { now: 0 }).action.type, 'finish');
});

// Codex r2 🔴4: comprehension-debt 는 discover(새 fan-out)만 막고 fix flow 는 막지 않는다.
test('comprehension-debt blocks discover but not the fix flow', () => {
  const l = loop();
  l.comprehension = { episodes_total: 4, episodes_human_reviewed: 0, debt_threshold: 0.5 };  // debt=1.0 blocked
  l.episodes = []; l.current_episode = null;
  const r0 = nextAction(l, { now: 0 });
  assert.equal(r0.action.type, 'await_human');
  assert.ok(r0.gate.blocked_by.includes('comprehension-debt'));
  l.episodes = [{ id: '002-deep-review', role: 'checker', status: 'rejected', point: 'plan', workstream_id: 'ws-01' }];
  l.current_episode = '002-deep-review';
  assert.equal(nextAction(l, { now: 0 }).action.type, 'fix_episode');  // debt 무관
});

// Codex r2 🔴4 / r5 🟡1: review.mjs+next-action.mjs 종단 — RC 후 debt(=1.0)에도 fix_episode 진입.
// (Task 4 가 아니라 여기 둠 — 이 시점에 review.mjs·next-action.mjs 둘 다 존재.)
test('dispatchReview → recordReviewOutcome(RC) → nextAction returns fix_episode (end-to-end)', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', detected: { 'deep-review': true }, now: new Date('2026-06-24T00:00:00Z') });
  const ws = newWorkstream(root, runId, { title: 'A', branch: 'b', worktree: 'w' }).id;
  const r = dispatchReview(root, runId, { point: 'plan', workstreamId: ws, detected: { 'deep-review': true } });
  recordReviewOutcome(root, runId, { episodeId: r.checkerEpisodeId, workstreamId: ws, point: 'plan', verdict: 'REQUEST_CHANGES' });
  const { data } = readState(root, runId);
  assert.equal(nextAction(data, { now: Date.parse('2026-06-24T00:00:00Z') }).action.type, 'fix_episode');
});
```

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/next-action.test.mjs` → FAIL

- [ ] **Step 3: Write `scripts/lib/next-action.mjs`**

```javascript
import { checkBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { computeDebt } from './comprehension.mjs';

function currentSessionTurns(loop) {
  const s = (loop.session_chain?.sessions || []).find(x => x.run_id === loop.session_chain?.lease?.owner_run_id);
  return s ? (s.turns || 0) : 0;
}

const A = (gate, action, next_command) => ({ gate, action, next_command });

// maker 의 review point 가 통과됐는지 — 같은 workstream+point 의 approved checker 또는 review_points_done 포함.
function reviewSatisfied(loop, makerEp) {
  const ws = (loop.workstreams || []).find(w => w.id === makerEp.workstream_id);
  if (ws && (ws.review_points_done || []).includes(makerEp.point)) return true;
  return (loop.episodes || []).some(e => e.role === 'checker' && e.status === 'approved' && e.workstream_id === makerEp.workstream_id && e.point === makerEp.point);
}

// 현재 actionable episode 가 없을 때: 미완 maker/거부 checker/in-progress/미리뷰 done maker 를 우선 처리하고, 전부 정리됐을 때만 finish.
function finishOrAdvance(loop, gate, fanoutBlocked) {
  const eps = loop.episodes || [];
  const pendingMaker = eps.find(e => e.role === 'maker' && e.status === 'pending');
  if (pendingMaker) {
    // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
    if (fanoutBlocked && pendingMaker.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: pendingMaker.id, reason: 'comprehension-debt' }, '/deep-loop-status');
    return A(gate, { type: 'dispatch_maker', episode_id: pendingMaker.id, point: pendingMaker.point, workstream_id: pendingMaker.workstream_id }, '/deep-loop-continue');
  }
  const rejected = eps.find(e => e.role === 'checker' && e.status === 'rejected');
  if (rejected) return A(gate, { type: 'fix_episode', episode_id: rejected.id, point: rejected.point, workstream_id: rejected.workstream_id }, '/deep-loop-continue');
  const inProg = eps.find(e => e.status === 'in_progress');
  if (inProg) return A(gate, { type: 'await_result', episode_id: inProg.id }, '/deep-loop-continue');
  // Codex r3 🔴4: 리뷰 안 된 done maker 가 있으면 finish 금지 → checker dispatch (리뷰 게이트 불변식).
  const unreviewed = eps.find(e => e.role === 'maker' && e.status === 'done' && !reviewSatisfied(loop, e));
  if (unreviewed) return A(gate, { type: 'dispatch_checker', episode_id: unreviewed.id, point: unreviewed.point, workstream_id: unreviewed.workstream_id }, '/deep-loop-continue');
  // finish 는 active workstream 0 + 모든 episode 가 done/approved + 모든 done maker 리뷰 통과일 때만 (Codex r2 🔴7 / r3 🔴4)
  const noActiveWs = (loop.active_workstreams || []).length === 0;
  const allPositive = eps.length > 0 && eps.every(e => ['done', 'approved'].includes(e.status));
  if (noActiveWs && allPositive) return A(gate, { type: 'finish' }, '/deep-loop-finish');
  return A(gate, { type: 'await_human', reason: 'active-work-remains' }, '/deep-loop-status');
}

export function nextAction(loop, { now = Date.now() } = {}) {
  const b = checkBudget(loop, { now });
  const br = checkBreaker(loop);
  const debt = computeDebt(loop);

  // budget hard-stop / breaker 는 모든 행동을 막는 전역 게이트.
  if (!b.ok) return A({ allowed: false, blocked_by: ['budget'], reason: b.reason, tier_after: b.tier_after }, { type: 'handoff', reason: 'budget' }, '/deep-loop-handoff');
  if (br.tripped) return A({ allowed: false, blocked_by: ['breaker'], reason: br.reason, tier_after: b.tier_after }, { type: 'await_human', reason: 'breaker' }, '/deep-loop-status');

  // comprehension-debt 는 **새 fan-out(discover)만** 막는다 — 현재 episode 진행/fix/리뷰/handoff/finish 는 허용 (spec §15, Codex r2 🔴4).
  const gate = { allowed: true, blocked_by: debt.blocked ? ['comprehension-debt'] : [], reason: b.reason, tier_after: b.tier_after };

  // 마일스톤: per_session_turn_cap 도달 → 선제 handoff
  const cap = loop.budget?.per_session_turn_cap;
  if (cap && currentSessionTurns(loop) >= cap) return A(gate, { type: 'handoff', reason: 'per_session_turn_cap' }, '/deep-loop-handoff');

  const ep = (loop.episodes || []).find(e => e.id === loop.current_episode);
  if (!ep) {
    if (!loop.episodes || loop.episodes.length === 0) {
      if (debt.blocked) return A(gate, { type: 'await_human', reason: 'comprehension-debt' }, '/deep-loop-status');  // discover=fan-out → debt 면 사람 검토 먼저
      return A(gate, { type: 'discover' }, '/deep-loop-discover');
    }
    return finishOrAdvance(loop, gate, debt.blocked);
  }
  if (ep.role === 'maker') {
    if (ep.status === 'pending') {
      // Codex r3 🔴3: debt 면 새 fan-out maker(kind≠fix) 차단. fix maker 는 현재 진행이라 허용.
      if (debt.blocked && ep.kind !== 'fix') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'comprehension-debt' }, '/deep-loop-status');
      return A(gate, { type: 'dispatch_maker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    }
    if (ep.status === 'in_progress') return A(gate, { type: 'await_result', episode_id: ep.id }, '/deep-loop-continue');
    if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
    if (ep.status === 'done') return A(gate, { type: 'dispatch_checker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
  }
  if (ep.role === 'checker') {
    if (ep.status === 'pending') return A(gate, { type: 'dispatch_checker', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');
    if (ep.status === 'in_progress') return A(gate, { type: 'await_result', episode_id: ep.id }, '/deep-loop-continue');   // 재dispatch 금지 (Codex r2 🔴7)
    if (ep.status === 'blocked') return A(gate, { type: 'await_human', episode_id: ep.id, reason: 'episode-blocked' }, '/deep-loop-status');
    if (ep.status === 'rejected') return A(gate, { type: 'fix_episode', episode_id: ep.id, point: ep.point, workstream_id: ep.workstream_id }, '/deep-loop-continue');  // Codex r1 🔴5
    if (ep.status === 'approved') return finishOrAdvance(loop, gate, debt.blocked);
  }
  return finishOrAdvance(loop, gate, debt.blocked);
}
```

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/next-action.test.mjs` → PASS (11 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/next-action.mjs tests/next-action.test.mjs
git commit -m "feat(orch): next-action — pure gate+action descriptor (no dispatch, spec 1.1)"
```

---

### Task 7: `handoff.mjs` — handoff emit (멱등 예약 + md + compaction-state M3 + launch-command + session_chain)

**Files:**
- Create: `scripts/lib/handoff.mjs`
- Test: `tests/handoff.test.mjs`

**Interfaces:**
- Consumes: `lease.reserveHandoff/advanceHandoffPhase`, `state.readState/runDir`, `integrity.appendAnchored`, `envelope.wrap/ulid/atomicWrite`.
- Produces:
  - `buildLaunchCommand({root, parentRunId, childRunId, handoffRel, headless}): {interactive, headless, macos, windows, tmux}` — 전 OS 진입 명령 문자열. handoff 파일은 **부모** run 디렉터리(`.deep-loop/runs/<parentRunId>/<handoffRel>`)를 가리킨다.
  - `emitHandoff(root, runId, {reason='milestone', trigger='milestone', now?, headless=false}): {ok, reason, handoffPath, childRunId, key, csName, mdName, handoffRel}` — (1) `reserveHandoff(trigger)` — 다른 트리거 in-flight면 `{ok:false}` no-op, 같은 트리거 재진입이면 기존 emit 멱등 반환(전체 메타데이터). (2) childRunId=ulid. (3) `handoffs/<ts>-next-session.md`. (4) `handoffs/<ts>-compaction-state.json`(M3, `parent_run_id=runId`). (5) `terminal/launch-command.txt`. (6) `appendAnchored('handoff-emitted')`로 session_chain entry(handoff 메타 포함) append + `superseded_by`. (7) `advanceHandoffPhase('emitted')` → `lease.state='releasing'`, `expires_at` 설정.

- [ ] **Step 1: Write the failing test**

`tests/handoff.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';
import { reserveHandoff } from '../scripts/lib/lease.mjs';
import { emitHandoff, buildLaunchCommand } from '../scripts/lib/handoff.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('buildLaunchCommand produces per-OS commands referencing child run + resume', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'PARENT', childRunId: 'CHILD', handoffRel: 'handoffs/x.md', headless: false });
  assert.match(c.interactive, /claude -n/);
  assert.match(c.macos, /osascript/);
  assert.match(c.windows, /wt\.exe/);
  assert.match(c.tmux, /tmux/);
  assert.match(c.interactive, /deep-loop-resume/);
});

test('emitHandoff writes md + compaction-state(M3) + launch-command, chains session, sets releasing', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const r = emitHandoff(root, runId, { reason: 'milestone', trigger: 'milestone', now });
  assert.equal(r.ok, true);
  assert.ok(existsSync(r.handoffPath));
  // compaction-state는 M3 envelope (producer=deep-loop, parent_run_id=runId)
  const cs = JSON.parse(readFileSync(join(runDir(root, runId), 'handoffs', r.csName), 'utf8'));
  assert.equal(cs.envelope.producer, 'deep-loop');
  assert.equal(cs.envelope.parent_run_id, runId);
  const { data } = readState(root, runId);
  assert.equal(data.session_chain.lease.handoff_phase, 'emitted');
  assert.equal(data.session_chain.lease.state, 'releasing');
  const cur = data.session_chain.sessions.find(s => s.run_id === runId);
  assert.equal(cur.superseded_by, r.childRunId);
  assert.ok(data.session_chain.sessions.some(s => s.run_id === r.childRunId));
  const md = readFileSync(r.handoffPath, 'utf8');
  assert.match(md, /이전 대화/);
  assert.match(md, /\/deep-loop-resume/);
});

test('emitHandoff dedups: second trigger while in-flight is a no-op', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  assert.equal(emitHandoff(root, runId, { trigger: 'milestone', now }).ok, true);
  const second = emitHandoff(root, runId, { trigger: 'precompact', now });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'handoff-in-flight');
});

// Codex r1 🔴1: 같은 트리거 재호출은 새 child/session 을 만들지 않고 기존 emit 을 멱등 반환.
test('emitHandoff same-trigger re-entry is idempotent (one child, no duplicate session)', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const first = emitHandoff(root, runId, { trigger: 'milestone', now });
  const again = emitHandoff(root, runId, { trigger: 'milestone', now });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'already-emitted');
  assert.equal(again.childRunId, first.childRunId);
  assert.equal(again.handoffRel, first.handoffRel);  // 전체 메타데이터 멱등 반환 (Codex r2 🔴1) → respawn 이 올바른 경로 사용
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});

// launch 명령이 **부모** run 경로의 handoff 파일을 가리키는지 (Codex r1 🔴3)
test('launch command references parent run dir handoff path', () => {
  const c = buildLaunchCommand({ root: '/p', parentRunId: 'PARENT', childRunId: 'CHILD', handoffRel: 'handoffs/x.md', headless: false });
  assert.match(c.interactive, /\.deep-loop\/runs\/PARENT\/handoffs\/x\.md/);
  assert.match(c.interactive, /deep-loop-CHILD/);
});

// Codex r3 🔴1: reserve 후 session 미생성(첫 emit 중단) 상태에서 재진입해도 reserve 가 영속한 childRunId 로 1개만 생성.
test('emitHandoff fall-through after bare reserve reuses reserved childRunId (no duplicate child)', () => {
  const { root, runId } = seed();
  const now = Date.parse('2026-06-24T01:00:00Z');
  const r = reserveHandoff(root, runId, { trigger: 'milestone', now });
  assert.equal(r.reserved, true);
  const e1 = emitHandoff(root, runId, { trigger: 'milestone', now });
  assert.equal(e1.childRunId, r.childRunId);
  const e2 = emitHandoff(root, runId, { trigger: 'milestone', now });
  assert.equal(e2.childRunId, r.childRunId);
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});
```
(주의: 테스트는 `r.handoffPath`/`r.childRunId`/`r.csName`를 사용 — emitHandoff 반환에 `csName`(compaction-state 파일명)을 포함시켜라.)

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/handoff.test.mjs` → FAIL

- [ ] **Step 3: Write `scripts/lib/handoff.mjs`**

```javascript
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readState, runDir } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { wrap, atomicWrite } from './envelope.mjs';
import { reserveHandoff, advanceHandoffPhase } from './lease.mjs';

function tsName(now) { return new Date(now).toISOString().replace(/[:.]/g, '-'); }

export function buildLaunchCommand({ root, parentRunId, childRunId, handoffRel, headless }) {
  // handoff 파일은 **부모** run 디렉터리에 있다 → 자식은 부모 경로에서 읽는다 (Codex r1 🔴3).
  const resumePrompt = `Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume`;
  const interactive = `cd ${root} && claude -n deep-loop-${childRunId} "${resumePrompt}"`;
  const headlessCmd = `cd ${root} && claude -p "${resumePrompt}" --permission-mode acceptEdits`;
  return {
    interactive: headless ? headlessCmd : interactive,
    headless: headlessCmd,
    macos: `osascript -e 'tell application "Terminal" to do script "${interactive.replace(/"/g, '\\"')}"'`,
    windows: `wt.exe -d ${root} cmd /k claude -n deep-loop-${childRunId} "${resumePrompt}"`,
    tmux: `tmux new-window -c ${root} '${interactive}'`,
  };
}

function handoffMarkdown(loop, childRunId, reason) {
  const wsLines = (loop.workstreams || []).map(w => `- ${w.id} [${w.status}] branch=${w.branch} worktree=${w.worktree}`).join('\n') || '- (none)';
  const doneEp = (loop.episodes || []).filter(e => ['done', 'approved'].includes(e.status)).map(e => e.id).join(', ') || '(none)';
  return [
    `# Handoff — next session (${childRunId})`, '',
    `> source of truth: 이 파일 + loop.json. **이전 대화 컨텍스트를 가정하지 말라.**`, '',
    `## Goal`, '', loop.goal, '',
    `## Routing`, `- recipe: ${loop.recipe?.id}`, `- protocol: ${loop.routing?.protocol}`, `- reason for handoff: ${reason}`, '',
    `## Episodes`, `- completed: ${doneEp}`, `- current: ${loop.current_episode || '(none)'}`, '',
    `## Workstreams`, wsLines, '',
    `## Triage`, `- actionable: ${(loop.triage?.actionable || []).length}, needs_human: ${(loop.triage?.needs_human || []).length}`, '',
    `## Git`, `- branch: ${loop.project?.branch}  head: ${loop.project?.head}  dirty: ${loop.project?.dirty}`, '',
    `## Human verification checklist`, '- [ ] 미검토 episode/diff 확인', '- [ ] 진행 중 workstream worktree 무결성 확인', '',
    `## Next prompt (정확히)`, '', '```', '/deep-loop-resume', '```', '',
  ].join('\n');
}

export function emitHandoff(root, runId, { reason = 'milestone', trigger = 'milestone', now = Date.now(), headless = false } = {}) {
  const res = reserveHandoff(root, runId, { trigger, now });
  if (!res.ok) return { ok: false, reason: res.reason, key: res.key };
  // Codex r1 🔴1 / r2 🔴1 / r3 🔴1: 같은 트리거 재진입(reserved:false)이면 이미 in-flight handoff 가 있다.
  // childRunId 는 reserve 가 영속한 값(res.childRunId)이라 동시/재진입이 같은 child 를 본다.
  if (!res.reserved) {
    const { data } = readState(root, runId);
    const child = data.session_chain.sessions.find(s => s.run_id === res.childRunId);
    if (child) {
      // 이미 emit 됨(session 존재). phase 가 reserved 에 멈췄으면 emitted 까지 마무리 (respawn 이 phase!==emitted 로 거부하는 데드락 방지)
      if (data.session_chain.lease.handoff_phase === 'reserved') advanceHandoffPhase(root, runId, { key: res.key, toPhase: 'emitted', now });
      return { ok: true, reason: 'already-emitted', childRunId: res.childRunId, key: res.key,
        handoffRel: child.handoff_rel ?? null, handoffPath: child.handoff_path ?? null,
        csName: child.handoff_cs ?? null, mdName: child.handoff_md ?? null };
    }
    // reserved 됐지만 session 미생성 → fall-through 해 emit 완료 (res.childRunId 재사용 → 중복 child 없음)
  }
  const { data: loop } = readState(root, runId);
  const childRunId = res.childRunId;
  const dir = join(runDir(root, runId), 'handoffs');
  const termDir = join(runDir(root, runId), 'terminal');
  mkdirSync(dir, { recursive: true });
  mkdirSync(termDir, { recursive: true });
  const stamp = tsName(now);
  const mdName = `${stamp}-next-session.md`;
  const csName = `${stamp}-compaction-state.json`;
  const handoffPath = join(dir, mdName);
  const handoffRel = `handoffs/${mdName}`;
  atomicWrite(handoffPath, handoffMarkdown(loop, childRunId, reason));
  const compaction = wrap({
    producer: 'deep-loop', artifact_kind: 'compaction-state',
    schema: { name: 'compaction-state', version: '1.0' }, run_id: childRunId, parent_run_id: runId,
    git: loop.project ? { head: loop.project.head, branch: loop.project.branch, dirty: loop.project.dirty } : {},
    provenance: { source_artifacts: [handoffRel], tool_versions: {} },
    payload: { goal: loop.goal, routing: loop.routing, recipe: loop.recipe, current_episode: loop.current_episode, active_workstreams: loop.active_workstreams, reason },
    now: new Date(now).toISOString(),
  });
  atomicWrite(join(dir, csName), JSON.stringify(compaction, null, 2));
  const cmds = buildLaunchCommand({ root, parentRunId: runId, childRunId, handoffRel, headless });
  atomicWrite(join(termDir, 'launch-command.txt'),
    [`# interactive`, cmds.interactive, ``, `# headless`, cmds.headless, ``, `# macOS`, cmds.macos, ``, `# windows`, cmds.windows, ``, `# tmux`, cmds.tmux, ``].join('\n'));

  appendAnchored(root, runId, { type: 'handoff-emitted', data: { child_run_id: childRunId, reason, key: res.key } }, (l) => {
    // 멱등 push (Codex r3 🔴1): 같은 childRunId 가 이미 있으면 재push 금지 → 동시 emit 도 child 1개.
    if (!l.session_chain.sessions.some(s => s.run_id === childRunId)) {
      l.session_chain.sessions.push({ run_id: childRunId, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null,
        handoff_rel: handoffRel, handoff_path: handoffPath, handoff_md: mdName, handoff_cs: csName });
    }
    const cur = l.session_chain.sessions.find(s => s.run_id === runId);
    if (cur) cur.superseded_by = childRunId;
  });
  advanceHandoffPhase(root, runId, { key: res.key, toPhase: 'emitted', now });
  // handoffRel 반환 → respawn 이 동일 경로로 launch 명령을 빌드 (Codex r1 🔴3)
  return { ok: true, reason: 'emitted', handoffPath, childRunId, key: res.key, csName, mdName, handoffRel };
}
```

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/handoff.test.mjs` → PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/handoff.mjs tests/handoff.test.mjs
git commit -m "feat(orch): handoff — idempotent emit (md + compaction-state M3 + launch-command + session chain + releasing)"
```

---

### Task 8: `respawn.mjs` — 게이트 순서 + spawn(주입) + 실패모드 A/B

**Files:**
- Create: `scripts/lib/respawn.mjs`
- Test: `tests/respawn.test.mjs`

**Interfaces:**
- Consumes: `budget.checkBudget/reconcileBudget`, `breaker.checkBreaker`, `lease.advanceHandoffPhase/releaseLease/rollbackHandoff/acquireLease`, `state.readState/writeState/withLock`, `integrity.appendAnchored`.
- Produces:
  - `respawnGate(loop, {now?}): {ok, blocked_by, reason}` — 순수. 순서: `budget.checkBudget` → `breaker` → `sessions.length < max_sessions` → `wallclock < max_wallclock_sec` → `auto_handoff`. (spec §9)
  - `respawn(root, runId, {childRunId, key, headless=false, now?, spawnFn?}): {ok, outcome, reason, childRunId}` — `reconcileBudget`(탐지 시 throw). 게이트 차단 → **(A)** `status='paused'`, lease emitted 유지, `{ok:false, outcome:'gate-blocked'}`. 게이트 통과 → `spawnFn(cmd)` 호출. 실패 → **(B)** `sessions[child].outcome='failed_launch'` + `superseded_by` 해제 + `rollbackHandoff` → `{ok:false, outcome:'failed_launch'}`. 성공 → `advanceHandoffPhase('spawned')` + `releaseLease(parent)` → `{ok:true, outcome:'spawned'}`. **acting tier로 게이팅하지 않음.**

- [ ] **Step 1: Write the failing test**

`tests/respawn.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, writeState } from '../scripts/lib/state.mjs';
import { emitHandoff } from '../scripts/lib/handoff.mjs';
import { acquireLease, advanceHandoffPhase } from '../scripts/lib/lease.mjs';
import { respawn, respawnGate } from '../scripts/lib/respawn.mjs';

const NOW0 = new Date('2026-06-24T00:00:00Z');
const NOW1 = Date.parse('2026-06-24T01:00:00Z');

// 자기완결 seed: run 생성 후 mutate(loop)로 필요한 필드만 조정하고 writeState.
function seed(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: NOW0 });
  if (mutate) { const { data } = readState(root, runId); mutate(data); writeState(root, runId, data); }
  return { root, runId };
}

test('respawnGate: total sessions may reach max_sessions but not exceed (off-by-one, Codex r3 🟡6)', () => {
  // 경계: sessions.length == max_sessions (pending child 가 max 번째) → 허용
  const ok = seed((d) => { d.autonomy.max_sessions = 2; d.session_chain.sessions = [{ run_id: 'a' }, { run_id: 'b' }]; });
  assert.equal(respawnGate(readState(ok.root, ok.runId).data, { now: NOW1 }).blocked_by.includes('max_sessions'), false);
  // 초과: sessions.length > max_sessions → 차단
  const over = seed((d) => { d.autonomy.max_sessions = 1; d.session_chain.sessions = [{ run_id: 'a' }, { run_id: 'b' }]; });
  const r = respawnGate(readState(over.root, over.runId).data, { now: NOW1 });
  assert.equal(r.ok, false);
  assert.ok(r.blocked_by.includes('max_sessions'));
});

test('respawn gate-blocked (budget) → paused, no spawn, lease stays emitted (mode A)', () => {
  // Codex r1 🟡7: budget.spent 를 변조하면 respawn 의 reconcileBudget 가 BUDGET_TAMPERED 로 throw.
  // 대신 total=0 으로 만들어 stored/log 불일치 없이 hard-stop(spent 0 >= 0) 을 유발한다.
  const { root, runId } = seed((d) => { d.budget.total = 0; });
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1 });
  let called = false;
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => { called = true; return { ok: true }; } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'gate-blocked');
  assert.equal(called, false);
  const after = readState(root, runId).data;
  assert.equal(after.status, 'paused');
  assert.equal(after.session_chain.lease.handoff_phase, 'emitted');
});

test('respawn launch failure → failed_launch outcome + lease rollback (mode B)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1 });
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn: () => { throw new Error('launch boom'); } });
  assert.equal(r.ok, false);
  assert.equal(r.outcome, 'failed_launch');
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.state, 'active');
  assert.equal(after.session_chain.lease.handoff_phase, 'idle');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === h.childRunId).outcome, 'failed_launch');
  assert.equal(after.session_chain.sessions.find(s => s.run_id === runId).superseded_by, null);
});

test('respawn success → spawned, lease released, child can acquire (generation+1); retry is idempotent', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1 });
  const cmds = [];
  const spawnFn = (cmd) => { cmds.push(cmd); return { ok: true }; };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(r.outcome, 'spawned');
  assert.equal(cmds.length, 1);
  assert.match(cmds[0], new RegExp(`\\.deep-loop/runs/${runId}/`));  // 부모 경로 참조 (🔴3)
  const after = readState(root, runId).data;
  assert.equal(after.session_chain.lease.handoff_phase, 'spawned');
  assert.equal(after.session_chain.lease.state, 'released');
  // Codex r1 🔴2: 같은 respawn 재시도는 already-spawned no-op (이중 spawn 금지)
  const retry = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
  assert.equal(retry.outcome, 'already-spawned');
  assert.equal(cmds.length, 1);
  const a = acquireLease(root, runId, { owner: h.childRunId, expectGeneration: 1, now: NOW1 });
  assert.equal(a.ok, true);
  assert.equal(a.generation, 2);
});

// Codex r2 🔴3: 외부 spawn 전 원자적 클레임이 동시 호출의 이중 spawn 을 막는지.
// spawnFn 안에서 같은 respawn 을 재진입(=동시 호출 시뮬레이션): 첫 호출이 이미 spawned 로 클레임했으므로 둘째는 spawn 안 함.
test('respawn claims atomically before external spawn → concurrent re-entry does not double-spawn', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1 });
  let spawns = 0; let reentered = null;
  const spawnFn = (cmd) => {
    spawns++;
    if (spawns === 1) reentered = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
    return { ok: true };
  };
  const r = respawn(root, runId, { childRunId: h.childRunId, key: h.key, handoffRel: h.handoffRel, now: NOW1, spawnFn });
  assert.equal(r.ok, true);
  assert.equal(spawns, 1);                       // 재진입 호출은 외부 spawn 을 추가 실행하지 않음
  assert.equal(reentered.outcome, 'already-spawned');
});

// Codex r3 🔴2: claim(spawned) 후 release 전 크래시는 **영구 stranded 가 아니다** — releasing+expired 로 successor 인수 복구.
test('crash after spawned-claim recovers via stale-TTL acquire (not permanently stranded)', () => {
  const { root, runId } = seed();
  const h = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1 });   // expires_at = NOW1 + 900s
  advanceHandoffPhase(root, runId, { key: h.key, toPhase: 'spawned', now: NOW1 });   // claim 만(=respawn 이 release 전 크래시)
  const st = readState(root, runId).data.session_chain.lease;
  assert.equal(st.handoff_phase, 'spawned');
  assert.equal(st.state, 'releasing');
  // TTL 경과 전: 인수 불가
  assert.equal(acquireLease(root, runId, { owner: 'RESUME', expectGeneration: 1, now: NOW1 + 1000 }).ok, false);
  // TTL(900s) 경과 후: releasing+expired → 인수 복구
  const a = acquireLease(root, runId, { owner: 'RESUME', expectGeneration: 1, now: NOW1 + 901 * 1000 });
  assert.equal(a.ok, true);
  assert.equal(a.generation, 2);
});

// Codex r1 🟡8: 동시 다발 실패 시 게이트 순서(budget→breaker→max_sessions→wallclock) 보고가 일관적인지.
test('respawnGate reports documented order; wallclock not mislabeled as budget', () => {
  const { root, runId } = seed((d) => {
    d.autonomy.max_sessions = 1; d.session_chain.sessions = [{ run_id: 'a' }, { run_id: 'b' }];
    d.budget.max_wallclock_sec = 1;            // created_at(NOW0) 기준 NOW1 은 1h 경과 → wallclock 초과
  });
  const r = respawnGate(readState(root, runId).data, { now: NOW1 });
  assert.equal(r.ok, false);
  assert.ok(r.blocked_by.includes('max_sessions'));
  assert.ok(r.blocked_by.includes('wallclock'));
  assert.equal(r.blocked_by.includes('budget'), false);  // wallclock 이 budget 으로 오분류되지 않음
});

// respawn race (§14 test 12): Continue↔PreCompact 동시 트리거 → 멱등키로 emit 1회
test('double emit + single respawn (race): only one child chain, no double spawn', () => {
  const { root, runId } = seed();
  const a = emitHandoff(root, runId, { trigger: 'milestone', now: NOW1 });
  const b = emitHandoff(root, runId, { trigger: 'precompact', now: NOW1 });   // no-op
  assert.equal(a.ok, true); assert.equal(b.ok, false);
  let spawns = 0;
  const r1 = respawn(root, runId, { childRunId: a.childRunId, key: a.key, handoffRel: a.handoffRel, now: NOW1, spawnFn: () => { spawns++; return { ok: true }; } });
  assert.equal(r1.ok, true);
  assert.equal(spawns, 1);
  const children = readState(root, runId).data.session_chain.sessions.filter(s => s.run_id !== runId);
  assert.equal(children.length, 1);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/respawn.test.mjs` → FAIL

- [ ] **Step 3: Write `scripts/lib/respawn.mjs`**

```javascript
import { readState, writeState, withLock } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { checkBudget, reconcileBudget } from './budget.mjs';
import { checkBreaker } from './breaker.mjs';
import { advanceHandoffPhase, releaseLease, rollbackHandoff } from './lease.mjs';
import { buildLaunchCommand } from './handoff.mjs';

// 게이트 순서: budget → breaker → max_sessions → wallclock → auto_handoff (spec §9). 순수.
export function respawnGate(loop, { now = Date.now() } = {}) {
  const blocked_by = [];
  // Codex r1 🟡8: checkBudget 은 created_at 기반 wallclock 도 검사하므로, sessionStart=now 로 그 내부 검사를
  // 무력화(wall=0)하고 wallclock 은 아래 문서화된 순서(max_sessions 다음)에서 명시 검사 → 순서/라벨 일관.
  const b = checkBudget(loop, { now, sessionStart: now });
  if (!b.ok) blocked_by.push('budget');
  if (checkBreaker(loop).tripped) blocked_by.push('breaker');
  // Codex r3 🟡6: emitHandoff 가 child 세션을 미리 append 하므로 pending child 가 이미 카운트됨 → `>`(>= 아님)로 비교해
  // 총 세션이 max_sessions 까지는 허용하되 초과는 금지 (off-by-one 방지).
  if ((loop.session_chain?.sessions?.length || 0) > (loop.autonomy?.max_sessions ?? 8)) blocked_by.push('max_sessions');
  const start = loop.created_at ? Date.parse(loop.created_at) : now;
  if (loop.budget?.max_wallclock_sec && (now - start) / 1000 >= loop.budget.max_wallclock_sec) blocked_by.push('wallclock');
  if (!loop.autonomy?.auto_handoff) blocked_by.push('auto_handoff');
  return { ok: blocked_by.length === 0, blocked_by, reason: blocked_by.join(',') || 'ok' };
}

function defaultSpawn(cmd) {
  // 실제 spawn은 Plan 3/드라이버 경로에서 child_process로 구현. 단위 테스트는 spawnFn 주입.
  throw new Error('SPAWN_NOT_WIRED: provide spawnFn (interactive=manual launch, headless=Plan3 driver)');
}

export function respawn(root, runId, { childRunId, key, handoffRel = '', headless = false, now = Date.now(), spawnFn = defaultSpawn }) {
  reconcileBudget(root, runId);                       // 무결성 fail-stop (탐지 시 throw)
  const { data: loop } = readState(root, runId);
  const lease = loop.session_chain.lease;
  const generation = lease.generation;
  // 멱등/펜싱 사전조건 (Codex r1 🔴2): 잘못된 owner/key 거부, 이미 spawned 면 재spawn 금지(이중 spawn 차단).
  if (lease.owner_run_id !== runId) return { ok: false, outcome: 'fenced', reason: 'owner-mismatch', childRunId };
  if (lease.handoff_idempotency_key !== key) return { ok: false, outcome: 'key-mismatch', reason: 'key-mismatch', childRunId };
  if (lease.handoff_phase === 'spawned') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
  if (lease.handoff_phase !== 'emitted' || lease.state !== 'releasing') {
    return { ok: false, outcome: 'not-emitted', reason: `phase=${lease.handoff_phase} state=${lease.state}`, childRunId };
  }
  const gate = respawnGate(loop, { now });
  if (!gate.ok) {
    // 실패모드 (A): spawn 시도 안 함 → handoff(emitted) 유지 + paused, 사람 수동 resume.
    withLock(root, runId, () => { const { data } = readState(root, runId); data.status = 'paused'; writeState(root, runId, data); });
    return { ok: false, outcome: 'gate-blocked', reason: gate.reason, childRunId };
  }
  // Codex r2 🔴3: 외부 spawn **이전에** emitted→spawned 를 원자적(withLock CAS)으로 클레임.
  // 동시 호출 둘이 emitted/releasing 을 읽어도 advanceHandoffPhase 가 직렬화되어 1명만 'advanced',
  // 나머지는 'idempotent-noop' → spawn 안 함 (이중 외부 spawn 차단).
  const claim = advanceHandoffPhase(root, runId, { key, toPhase: 'spawned', now });
  if (!claim.ok) return { ok: false, outcome: 'phase-error', reason: claim.reason, childRunId };
  if (claim.reason === 'idempotent-noop') return { ok: true, outcome: 'already-spawned', reason: 'idempotent', childRunId };
  const cmds = buildLaunchCommand({ root, parentRunId: runId, childRunId, handoffRel, headless });
  const cmd = headless ? cmds.headless : cmds.interactive;
  try {
    const res = spawnFn(cmd);
    if (res && res.ok === false) throw new Error(res.reason || 'spawn-returned-false');
  } catch (e) {
    // 실패모드 (B): spawned→active/idle 롤백 + chain 정정 (인수한 적 없는 세션을 기술하지 않게 superseded_by 해제)
    appendAnchored(root, runId, { type: 'respawn-failed', data: { child_run_id: childRunId, error: String(e.message || e) } }, (l) => {
      const child = l.session_chain.sessions.find(s => s.run_id === childRunId);
      if (child) child.outcome = 'failed_launch';
      const parent = l.session_chain.sessions.find(s => s.superseded_by === childRunId);
      if (parent) parent.superseded_by = null;
    });
    rollbackHandoff(root, runId, { owner: runId, generation });
    return { ok: false, outcome: 'failed_launch', reason: String(e.message || e), childRunId };
  }
  // spawn 성공 → 부모 lease release(자식이 acquire 가능). 전이 반환값 검증(silent 실패 금지).
  appendAnchored(root, runId, { type: 'respawn-spawned', data: { child_run_id: childRunId, headless } });
  const rel = releaseLease(root, runId, { owner: runId, generation });
  if (!rel.ok) return { ok: false, outcome: 'release-error', reason: rel.reason, childRunId };
  return { ok: true, outcome: 'spawned', reason: 'spawned', childRunId };
}
```

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/respawn.test.mjs` → PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/respawn.mjs tests/respawn.test.mjs
git commit -m "feat(orch): respawn — gate ordering, injectable spawn, mode A gate-blocked / mode B launch-fail rollback, race-safe"
```

---

### Task 9: CLI 연결 — 오케스트레이션 subcommand + lease 펜싱 가드 + 전체 그린

**Files:**
- Modify: `scripts/deep-loop.mjs` (디스패처에 subcommand 추가 + 공통 헬퍼)
- Test: `tests/orch-cli.test.mjs`

**Interfaces:**
- Consumes: 모든 Task 1–8 모듈 + Plan 1 모듈.
- Produces (CLI 계약, spec §4):
  - 공통 플래그: `--project-root <p>`(기본 cwd), `--run-id <id>`(기본 `.deep-loop/current`), 변경 명령은 `--owner <run_id> --generation <n>`.
  - `lease acquire|release|check --owner --generation [--expect-generation]`
  - `next-action [--json]` — `nextAction` 결과 출력(dispatch 안 함)
  - `episode new --plugin --role --kind --point [--workstream]` / `episode record --id --status [--artifacts <json>] [--proof <json>]`
  - `workstream new --title --branch --worktree [--depends-on <json>]` / `workstream set --id --status` / `workstream terminal --id --status --proof <json>` (커널 파생 터미널)
  - `review dispatch --point --workstream` / `review record --episode --workstream --point --verdict [--source]` (verdict→checker 터미널 파생)
  - `handoff emit [--reason] [--trigger] [--headless]`
  - `respawn [--child <id>] [--key <k>] [--headless]` — **테스트/수동에서는 spawn 미실행**(spawnFn 미주입 시 SPAWN_NOT_WIRED). CLI는 `--dry-run`으로 게이트만 평가.
  - `tick --mode discover|triage|advance|full` — `next-action` 반환(스스로 판단 안 함, §1.1).
  - 변경 명령은 `requireLease`로 펜싱 — 불일치 시 종료코드 3 + `LEASE_FENCED`.

- [ ] **Step 1: Write the failing test**

`tests/orch-cli.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState } from '../scripts/lib/state.mjs';

const CLI = join(process.cwd(), 'scripts', 'deep-loop.mjs');
function run(root, args) {
  return execFileSync('node', [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
}
function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: 'g', now: new Date('2026-06-24T00:00:00Z') });
  return { root, runId };
}

test('next-action prints descriptor JSON', () => {
  const { root } = seed();
  const out = JSON.parse(run(root, ['next-action', '--json']));
  assert.ok(out.action && out.gate);
  assert.equal(out.action.type, 'discover');
});

test('workstream new + set via CLI with lease', () => {
  const { root, runId } = seed();
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'Auth', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'in_progress');
});

test('mutating command with wrong generation is fenced (exit 3)', () => {
  const { root, runId } = seed();
  let code = 0;
  try { run(root, ['workstream', 'new', '--title', 'X', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation', '9']); }
  catch (e) { code = e.status; }
  assert.equal(code, 3);
});

test('episode new creates request + episode via CLI', () => {
  const { root, runId } = seed();
  const ep = JSON.parse(run(root, ['episode', 'new', '--plugin', 'deep-work', '--role', 'maker', '--kind', 'impl', '--point', 'implementation', '--owner', runId, '--generation', '1']));
  assert.match(ep.id, /^001-deep-work$/);
  assert.equal(readState(root, runId).data.episodes.length, 1);
});

// Codex r1 🔴6: proof-파생 터미널/리뷰 결과가 CLI 경계로 도달 가능해야 (Execution 은 CLI 로만 상태 변경).
test('workstream terminal + review record reach kernel via CLI', () => {
  const { root, runId } = seed();
  const ws = JSON.parse(run(root, ['workstream', 'new', '--title', 'A', '--branch', 'b', '--worktree', 'w', '--owner', runId, '--generation', '1']));
  run(root, ['workstream', 'set', '--id', ws.id, '--status', 'in_progress', '--owner', runId, '--generation', '1']);
  run(root, ['workstream', 'terminal', '--id', ws.id, '--status', 'ready', '--proof', '{"review_approved":true}', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.workstreams[0].status, 'ready');
  const disp = JSON.parse(run(root, ['review', 'dispatch', '--point', 'plan', '--workstream', ws.id, '--owner', runId, '--generation', '1']));
  run(root, ['review', 'record', '--episode', disp.checkerEpisodeId, '--workstream', ws.id, '--point', 'plan', '--verdict', 'APPROVE', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.episodes.find(e => e.id === disp.checkerEpisodeId).status, 'approved');
});

test('handoff emit via CLI sets releasing', () => {
  const { root, runId } = seed();
  run(root, ['handoff', 'emit', '--reason', 'milestone', '--trigger', 'milestone', '--owner', runId, '--generation', '1']);
  assert.equal(readState(root, runId).data.session_chain.lease.state, 'releasing');
});

test('full suite still green count grows (smoke: validate ok)', () => {
  const { root } = seed();
  const out = run(root, ['validate']);
  assert.match(out, /ok/);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/orch-cli.test.mjs` → FAIL

- [ ] **Step 3: 디스패처 확장** — `scripts/deep-loop.mjs`에 import + 헬퍼 + handlers 추가

기존 import 블록 아래에 추가:
```javascript
import { writeState } from './lib/state.mjs';
import { leaseCheck, acquireLease, releaseLease } from './lib/lease.mjs';
import { newWorkstream, setWorkstreamStatus, recordWorkstreamTerminal } from './lib/workspace.mjs';
import { newEpisode, recordEpisode } from './lib/episode.mjs';
import { dispatchReview, recordReviewOutcome } from './lib/review.mjs';
import { nextAction } from './lib/next-action.mjs';
import { emitHandoff } from './lib/handoff.mjs';
import { respawn, respawnGate } from './lib/respawn.mjs';

function rootOf(f) { return f['project-root'] || process.cwd(); }
function runIdOf(root, f) {
  if (f['run-id']) return f['run-id'];
  const p = join(root, '.deep-loop', 'current');
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}
// 변경 명령 펜싱 (spec §9.1) — owner/generation 불일치 시 LEASE_FENCED.
function requireLease(root, runId, f, intent = 'business') {
  const { data } = readState(root, runId);
  const r = leaseCheck(data, { owner: f.owner, generation: Number(f.generation), intent });
  if (!r.ok) { error(`LEASE_FENCED: ${r.reason}`); process.exit(3); }
  return data;
}
```

handlers에 추가(객체 리터럴 끝에):
```javascript
  'next-action': async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json(nextAction(data)); return 0; },
  tick: async (a) => { const f = parseFlags(a); const root = rootOf(f); const { data } = readState(root, runIdOf(root, f)); json({ mode: f.mode || 'advance', ...nextAction(data) }); return 0; },
  lease: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    if (verb === 'check') { const { data } = readState(root, runId); json(leaseCheck(data, { owner: f.owner, generation: Number(f.generation) })); return 0; }
    if (verb === 'acquire') { json(acquireLease(root, runId, { owner: f.owner, expectGeneration: Number(f['expect-generation'] ?? f.generation) })); return 0; }
    if (verb === 'release') { json(releaseLease(root, runId, { owner: f.owner, generation: Number(f.generation) })); return 0; }
    error(`unknown lease verb: ${verb}`); return 2;
  },
  workstream: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    if (verb === 'new') { const r = newWorkstream(root, runId, { title: f.title, branch: f.branch, worktree: f.worktree, dependsOn: f['depends-on'] ? JSON.parse(f['depends-on']) : [] }); json(r); return 0; }
    if (verb === 'set') { setWorkstreamStatus(root, runId, f.id, f.status); json({ ok: true }); return 0; }
    // 터미널(ready/merged/abandoned)은 proof 필수 — 커널 파생 (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'terminal') { recordWorkstreamTerminal(root, runId, f.id, { status: f.status, proof: f.proof ? JSON.parse(f.proof) : {} }); json({ ok: true }); return 0; }
    error(`unknown workstream verb: ${verb}`); return 2;
  },
  episode: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    if (verb === 'new') { const r = newEpisode(root, runId, { plugin: f.plugin, role: f.role, kind: f.kind, point: f.point, workstream: f.workstream, expectedArtifacts: f.artifacts ? JSON.parse(f.artifacts) : [] }); json({ id: r.id, request_path: r.requestPath }); return 0; }
    if (verb === 'record') { recordEpisode(root, runId, f.id, { status: f.status, artifacts: f.artifacts ? JSON.parse(f.artifacts) : [], proof: f.proof ? JSON.parse(f.proof) : {} }); json({ ok: true }); return 0; }
    error(`unknown episode verb: ${verb}`); return 2;
  },
  review: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f);
    if (verb === 'dispatch') { json(dispatchReview(root, runId, { point: f.point, workstreamId: f.workstream, detected: detectPlugins(root) })); return 0; }
    // verdict 기록 → checker 터미널 파생 + breaker/comprehension/review_points (Codex r1 🔴6: CLI 경계로 노출)
    if (verb === 'record') { json(recordReviewOutcome(root, runId, { episodeId: f.episode, workstreamId: f.workstream, point: f.point, verdict: f.verdict, source: f.source || 'deep-review-approve' })); return 0; }
    error(`unknown review verb: ${verb}`); return 2;
  },
  handoff: async (a) => {
    const [verb, ...rest] = a; const f = parseFlags(rest); const root = rootOf(f); const runId = runIdOf(root, f);
    requireLease(root, runId, f, 'lease');
    if (verb === 'emit') { json(emitHandoff(root, runId, { reason: f.reason, trigger: f.trigger || f.reason || 'milestone', headless: !!f.headless })); return 0; }
    error(`unknown handoff verb: ${verb}`); return 2;
  },
  respawn: async (a) => {
    const f = parseFlags(a); const root = rootOf(f); const runId = runIdOf(root, f);
    const { data } = readState(root, runId);
    if (f['dry-run']) { json(respawnGate(data)); return 0; }
    // CLI는 spawnFn 미주입 → 실제 spawn은 드라이버(Plan 3). 게이트/디스크립터만.
    json({ note: 'respawn requires a driver-provided spawnFn; CLI exposes gate via --dry-run', gate: respawnGate(data) }); return 0;
  },
```
(`init-run`/`detect-plugins`/`recipe-match`도 `--project-root` 지원하도록 `process.cwd()` → `rootOf(parseFlags(a))`로 정정. `requireLease`의 `--generation`은 숫자 변환.)

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/orch-cli.test.mjs` → PASS (7 tests)

- [ ] **Step 5: 전체 테스트 + preflight**

Run: `npm test` → 기존 62 + 신규(lease 8 + workspace 6 + episode 4 + review 5 + adapters 6 + next-action 11 + handoff 6 + respawn 8 + orch-cli 7 = 61) = **123 tests green**
Run: `npm run preflight` → PASS

- [ ] **Step 6: Commit**

```bash
git add scripts/deep-loop.mjs tests/orch-cli.test.mjs
git commit -m "feat(orch): CLI — lease/next-action/episode/workstream/review/handoff/respawn/tick subcommands + lease fencing"
```

---

## Self-Review (Plan 2)

**Spec coverage (Plan 2 범위):**
- §9.1 lease/fencing/멱등 단계기계 → Task 1 (`lease.mjs`: CAS, generation, reserve/advance/rollback, carve-out). ✅
- §8 multi-workstream + §8.1 fan-in → Task 2 (`workspace.mjs`: lifecycle, max_parallel, terminal-from-proof, inherit/fail-safe, integrationOrder). ✅
- §4·§5 episode scaffold/record + 터미널 proof 파생 → Task 3 (`episode.mjs`). ✅
- §7 리뷰 전략 dispatch/verdict/outcome → Task 4 (`review.mjs`). ✅
- §6 4-verb 어댑터 + protocols → Task 5 (`adapters.mjs` + `protocols/*.json`, descriptor-returning, identity guard, tier guard). ✅
- §1.1·§4 next-action 디스크립터(dispatch 안 함) → Task 6 (`next-action.mjs`). ✅
- §9 handoff emit(md+compaction-state M3+launch-command+session_chain) → Task 7 (`handoff.mjs`). ✅
- §9·§9.1 respawn 게이트 순서 + 실패모드 A/B + race → Task 8 (`respawn.mjs`). ✅
- §4 CLI 계약(lease/next-action/handoff/respawn/tick/episode/workstream/review) + 펜싱 → Task 9. ✅
- §14 테스트 매핑: test 7(workstream 인수/고아 0/fail-safe)=Task2, test 12(respawn race)=Task8, test 14(lease CAS/generation/releasing 거부)=Task1+leaseCheck. ✅

**범위 밖(Plan 3):** Execution plane 스킬 10개, `deep-loop-workflow` references, recipes/automation 템플릿, PreCompact hook 실배선(`precompact-handoff.mjs`가 `handoff emit`+`respawn`을 호출하는 셸/노드 글루), README/CHANGELOG, marketplace 등록, headless 실제 `child_process` spawnFn 구현.

**Placeholder scan:** 모든 코드 스텝에 완전한 구현 포함. `respawn` `defaultSpawn`은 의도적으로 `SPAWN_NOT_WIRED` throw(실제 spawn은 드라이버 주입 — Plan 3) — placeholder가 아니라 명시적 경계. Task 8 Step 4 NOTE는 테스트의 미사용 `seed(over)`/레거시 `require` 정리를 지시(단언은 고정).

**Type consistency:**
- lease: `leaseCheck(loop,{owner,generation,intent})→{ok,reason}`, `acquireLease(root,runId,{owner,expectGeneration,now})→{ok,generation,reason}`, `reserveHandoff(...)→{ok,reserved,key,reason}`, `advanceHandoffPhase(...,{key,toPhase})→{ok,reason}`, `rollbackHandoff(...,{owner,generation})→{ok,reason}` — Task 7·8에서 동일 시그니처 소비. ✅
- handoff: `emitHandoff(...)→{ok,reason,handoffPath,childRunId,key,csName,mdName,handoffRel}`, `buildLaunchCommand({root,parentRunId,childRunId,handoffRel,headless})→{interactive,headless,macos,windows,tmux}` — Task 8 respawn이 `childRunId`·`key`·`handoffRel` 소비(부모 경로 launch 명령). ✅
- workspace: `newWorkstream(...)→{id}`, `setWorkstreamStatus`, `recordWorkstreamTerminal({status,proof})`, `inheritWorkstreams→{inherited,missing}`, `integrationOrder(loop)→{order,cycle}`. Task 4 review가 `newWorkstream` 사용. ✅
- episode: `newEpisode(...)→{id,requestPath}`, `recordEpisode(...,{status,artifacts,proof})`. Task 4 review가 `newEpisode` 소비. ✅
- adapters: `resolveAdapter(name)→{dispatch,awaitResult,checker,readArtifacts}`, `guardTierProtocol(tier,protocol,verb)→{ok,reason}`. ✅
- next-action: `nextAction(loop,{now})→{gate,action,next_command}`. Task 9 CLI가 소비. ✅

**불변식 준수 점검(§7 handoff 불변식):**
- `withLock` 비재진입: 모든 모듈은 lock 안에서 또 lock을 잡지 않음 — review.mjs는 `recordReviewVerdict`/`recordReviewed`/자체 `withLock`을 **순차**로(중첩 ❌). respawn은 `appendAnchored`→`advanceHandoffPhase`→`releaseLease`를 **순차**로. ✅
- 이벤트는 `appendAnchored` 단일 경로(workstream/episode/handoff/respawn 모두). 순수 lease 전이는 이벤트 없이 loop.json(해시 앵커)에만 기록. ✅
- 터미널 상태는 proof 파생(episode done=artifacts 존재, approved/rejected=verdict; workstream terminal=proof 필수). ✅
- respawn은 acting tier로 게이팅하지 않음(`respawnGate`에 tier 없음). 외부 행동 실행 0(proposal-only). ✅
- project root 밖 쓰기 0(handoff/episode 산출은 전부 `runDir` 하위). ✅

---

## Codex 2-way 리뷰 반영 로그

**라운드 1 (REQUEST_CHANGES, 6 critical + 2 should-fix) — 전부 수정:**
- 🔴1 (Task 7): `emitHandoff` 가 같은-트리거 재진입(`reserved:false`)에서 새 child/파일을 만들던 이중 emit → `superseded_by` 확인 후 멱등 반환(crash-resume fall-through 포함). 테스트 추가.
- 🔴2 (Task 8): `respawn` 이 phase/key 검증 없이 spawn → 사전조건 가드(owner/key/phase=emitted/state=releasing) + `spawned` 면 멱등 no-op + 전이 반환값 검증. 멱등 재시도 테스트 추가.
- 🔴3 (Task 7·8): `buildLaunchCommand` 가 `childRunId` 경로를 가리켜 자식이 없는 파일을 읽음 → `parentRunId` 사용 + `emitHandoff` 가 `handoffRel` 반환 + `respawn` 이 이를 전달. 경로 단언 테스트 추가.
- 🔴4 (Task 1): `advanceHandoffPhase('emitted')` 가 `expires_at` 미설정 → 부모 크래시 시 데드락 → emitted 진입에서 `expires_at = now + stale_ttl` 설정. stale 인수 테스트 추가.
- 🔴5 (Task 4·6): `recordReviewOutcome` 가 checker 터미널/ fix flow 미구동 → verdict proof 에서 checker 터미널 파생(accepted concern 포함) + `nextAction` 이 checker pending/rejected/approved 명시 처리. 테스트 추가.
- 🔴6 (Task 9): proof-파생 터미널/리뷰 결과가 CLI 미노출 → `workstream terminal`·`review record` 명령 추가(leased). 테스트 추가.
- 🟡7 (Task 8): mode-A 테스트가 `budget.spent` 변조로 `reconcileBudget` throw → `budget.total=0` 으로 무결성 유지하며 hard-stop 유발.
- 🟡8 (Task 8): wallclock 이 `checkBudget` 내부에서 게이트 순서보다 먼저 평가 → `respawnGate` 가 `sessionStart:now` 로 내부 검사 무력화 + 문서 순서대로 명시 검사. 순서 테스트 추가.

**라운드 2 (REQUEST_CHANGES, 7 critical + 2 should-fix) — 전부 수정** (라운드 1 fix 7·8 은 correct 확인됨):
- 🔴1 (Task 7): same-trigger 멱등 반환이 respawn 메타데이터 손실 + phase 가 reserved 에 멈춘 크래시 미복구 → 전체 메타데이터(handoffRel 등)를 child 세션에 영속 + 재진입 시 reserved→emitted 마무리.
- 🔴2 (Task 1): active 소유자가 stale TTL(15분) 후 자기 write 에서 fence 되는 데드락 → `leaseCheck` 에서 expiry 분기 제거(generation 이 stale parent 펜싱), active=`expires_at:null`(무기한), TTL 은 releasing 크래시 인수에만. `acquireLease` takeover = released 또는 releasing+expired(active 절대 탈취 ❌).
- 🔴3 (Task 8): respawn 이 phase 검증 후 비원자적으로 spawn → 동시 호출 이중 spawn → 외부 spawn **이전에** emitted→spawned CAS 클레임(`idempotent-noop` 이면 spawn 안 함). 재진입 동시성 테스트 추가.
- 🔴4 (Task 4·6): comprehension-debt 가 fix flow 보다 먼저 발화 → fix 도달 불가 → debt 는 `discover`(새 fan-out)만 차단, 현재 episode 진행/fix/리뷰/finish 는 허용. dispatchReview→RC→nextAction=fix_episode 종단 테스트 추가.
- 🔴5 (Task 2·9): workstream 터미널이 임의 status+빈 proof 로 설정 가능 → proof **내용**을 터미널별 검증(ready=review/approved, merged=merge_commit+human_approved[사람승인], abandoned=reason). 검증은 appendAnchored 이전.
- 🔴6 (Task 4·9): invalid verdict 가 검증 전 breaker 변조 → `recordReviewOutcome` 가 최상단에서 verdict allowlist 검증 후 진행.
- 🔴7 (Task 6): nextAction 이 in_progress/blocked 에서 finish/재dispatch 오작동 → in_progress→`await_result`, blocked→`await_human`, checker in_progress 재dispatch ❌, finish 는 active_workstreams 0 + 모든 episode 양성 터미널일 때만(`finishOrAdvance`).
- 🟡8 (Task 7): Interfaces/Self-Review 의 buildLaunchCommand/emitHandoff 시그니처를 실제(parentRunId/handoffRel/csName/mdName)와 일치.
- 🟡9 (Task 2): integrationOrder 가 미지 의존을 silent drop → `missing[]` 반환 + order 비움(needs-human).

**라운드 3 (REQUEST_CHANGES, 5 critical + 1 should-fix) — 수정 완료** (lease takeover 모델은 correct 확인됨):
- 🔴1 (Task 1·7): same-trigger 동시/재진입 emit 이 중복 child 생성 → `reserveHandoff` 가 childRunId 를 예약 시점에 영속, emitHandoff 가 그 id 재사용 + 멱등 session push.
- 🔴2 (Task 8): claim(spawned) 후 release 전 크래시 우려 → **영구 stranded 아님**을 증거로 입증(releasing+expires_at 유지 → stale-TTL `acquireLease` 로 복구). 복구 테스트 추가.
- 🔴3 (Task 6): debt 게이트가 새 maker fan-out 을 여전히 허용 → debt 시 fan-out maker(kind≠fix) 도 `await_human`, fix/checker/await 는 허용.
- 🔴4 (Task 6): `finishOrAdvance` 가 리뷰 안 된 done maker 로 finish 가능 → 미리뷰 done maker 면 `dispatch_checker`(리뷰 게이트). finish 는 모든 done maker 리뷰 통과 + active_ws 0 일 때만.
- 🔴5 (Task 3·4): invalid episodeId 가 appendAnchored mutate throw 로 event_log_head 앵커 stale → `recordEpisode`/`recordReviewOutcome` 가 appendAnchored 이전에 존재/입력 prevalidate.
- 🟡6 (Task 8): `respawnGate` max_sessions off-by-one(pending child 선카운트) → `>=`→`>`. 경계 테스트 추가.

신규 테스트 총계: 60 (라운드 3 전 58 → 60). `npm test` = 기존 62 + 60 = **122 green** 목표.

**라운드 4 (CONCERN, critical 0 — 1 should-fix + 1 info) — 수정 완료** (Codex 가 라운드 3 critical 수정 전부 complete 확인):
- 🟡1 (Task 5): `adapters.readArtifacts` 가 superpowers 의 markdown 산출물을 JSON.parse 시도 → 항상 drop → `producer:null` 이면 원문을 `{kind:'raw',content}` receipt 로 반환. 테스트 추가.
- ℹ️2 (Task 4): `parseVerdict` 키워드 fallback 이 부정문("do not APPROVE")을 APPROVE 로 오분류 → 부정 표현 가드 추가. 부정 테스트 추가.

신규 테스트 총계: 61 (라운드 4 전 60 → 61). `npm test` = 기존 62 + 61 = **123 green** 목표.

**라운드 5 (CONCERN, critical 0 — 1 should-fix) — 수정 완료:**
- 🟡1 (Task 4): review.test 가 Task 6 의 `next-action.mjs` 를 import → 순서대로 구현 시 Task 4 Step 4 가 통과 불가(모듈 미존재). RC→fix_episode 종단 테스트를 Task 6 next-action.test 로 이동(이 시점에 review.mjs·next-action.mjs 둘 다 존재). Task 4 는 review-owned 동작만 테스트.

테스트 재배치(총계 불변 61). `npm test` = **123 green** 목표.

---

## 다음 단계

Plan 2 실행·검증(Codex-only 2-way 리뷰 루프 수렴) 후, Plan 3(Execution plane 스킬 10개 + `deep-loop-workflow` references + PreCompact hook 실배선 + recipes/automation + 패키징 + marketplace 등록)을 동일 형식으로 작성한다. 본 plan은 `defaultSpawn`을 명시적 미배선 경계로 남겨 Plan 3의 headless 드라이버가 `spawnFn`을 주입하도록 한다.
