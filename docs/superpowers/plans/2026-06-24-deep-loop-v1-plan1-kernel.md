# deep-loop v1 — Plan 1: Kernel 기반 + 상태 + 안전 게이트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** deep-loop의 결정론적 Control-plane 커널 하부(상태 영속·무결성·예산·breaker·이해부채·plugin 감지·recipe 매칭)를 TDD로 구축한다.

**Architecture:** 2-plane 중 Control plane만. 모든 모듈은 순수 Node `.mjs`(ESM), 부수효과는 atomic temp+rename 파일쓰기로 한정, 단위 테스트 가능. Execution plane(스킬)·오케스트레이션(lease/handoff/respawn)은 Plan 2·3에서.

**Tech Stack:** Node >= 20, `type: module`, `node:test` + `node:assert/strict`, 의존성 0 (YAML/AJV 등 외부 패키지 금지 — 스키마 검증은 자체 구현).

## Global Constraints

- Node >= 20, `package.json` `"type": "module"`. (spec §2)
- 외부 의존성 추가 금지. durable state는 JSON. 스키마 검증은 자체 구현(AJV 불가). (spec §2)
- 모든 deep-loop 산출물(loop.json 제외 receipt/handoff/compaction-state)은 M3 envelope: `{schema_version:"1.0", envelope:{producer:"deep-loop", artifact_kind, schema:{name,version}, run_id(ULID), parent_run_id, generated_at(RFC3339Z), git:{head,branch,dirty}, provenance:{source_artifacts[],tool_versions}}, payload}`. (spec §4)
- 파일 쓰기는 atomic temp+rename. ULID 정규식 `^[0-9A-HJKMNP-TV-Z]{26}$`. (spec §1 brief)
- `state patch`는 **필드 화이트리스트**만 허용. 터미널 상태·`budget.spent`·`review.*`·`autonomy.tier 상향`·`circuit_breaker.tripped=false`·`session_chain.*`는 스킬 변경 불가(커널 파생). (spec §4)
- 무결성은 *예방이 아니라 탐지+fail-stop*, 협조적-fallible 에이전트 전제. (spec §1.2)
- 시간은 `new Date().toISOString()` 사용. 테스트는 주입 가능한 `now()`로 결정론 유지.
- project root 밖 쓰기 금지. 상태 루트 = `<project-root>/.deep-loop/`. (spec §15)
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: 스캐폴딩 + `validate` 그린 패스

**Files:**
- Create: `package.json`
- Create: `.claude-plugin/plugin.json`
- Create: `.codex-plugin/plugin.json`
- Create: `schemas/loop-run.schema.json` (최소 스텁)
- Create: `scripts/deep-loop.mjs` (디스패처 스텁)
- Create: `scripts/lib/log.mjs`
- Test: `tests/scaffold.test.mjs`

**Interfaces:**
- Produces: `scripts/deep-loop.mjs`가 CLI 진입점. `node scripts/deep-loop.mjs validate` 종료코드 0. `log.mjs` exports `{ info, warn, error, json }`.

- [ ] **Step 1: package.json 작성**

```json
{
  "name": "deep-loop",
  "version": "0.1.0",
  "type": "module",
  "description": "Loop Engineering control plane over the deep-suite",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test tests/*.test.mjs",
    "validate": "node scripts/deep-loop.mjs validate",
    "preflight": "npm run validate && npm test"
  }
}
```

- [ ] **Step 2: plugin manifests 작성**

`.claude-plugin/plugin.json`:
```json
{
  "name": "deep-loop",
  "version": "0.1.0",
  "description": "Loop Engineering control plane: cross-plugin orchestration, durable loop state, autonomous session handoff",
  "author": { "name": "Sungmin Cho" },
  "repository": { "type": "git", "url": "https://github.com/Sungmin-Cho/claude-deep-loop.git" },
  "license": "MIT",
  "category": "Productivity",
  "keywords": ["loop-engineering","orchestration","durable-state","handoff","deep-suite"]
}
```

`.codex-plugin/plugin.json`:
```json
{
  "name": "deep-loop",
  "version": "0.1.0",
  "description": "Loop Engineering control plane over the deep-suite",
  "repository": { "type": "git", "url": "https://github.com/Sungmin-Cho/claude-deep-loop.git" },
  "license": "MIT",
  "keywords": ["loop-engineering","orchestration","durable-state","handoff"],
  "skills": "./skills/",
  "interface": {
    "displayName": "Deep Loop",
    "shortDescription": "Loop Engineering control plane over the deep-suite",
    "longDescription": "Discovers work, routes to sibling deep-* plugins as maker/checker episodes, keeps durable loop state, and hands off to fresh sessions autonomously.",
    "developerName": "Sungmin Cho",
    "category": "Coding",
    "capabilities": ["Interactive","Read","Write"],
    "defaultPrompt": ["$deep-loop:deep-loop \"<goal>\""]
  }
}
```

- [ ] **Step 3: minimal schema stub + log.mjs**

`schemas/loop-run.schema.json`:
```json
{ "$schema": "deep-loop/v0.2.0", "type": "object", "required": ["schema_version","run_id","goal","status"], "properties": {} }
```

`scripts/lib/log.mjs`:
```javascript
const COLORS = { info: '', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
let useColor = !process.env.NO_COLOR;
export function setColor(on) { useColor = on; }
function emit(level, msg) {
  const c = useColor ? COLORS[level] : '';
  const r = useColor ? COLORS.reset : '';
  process.stderr.write(`${c}[deep-loop:${level}]${r} ${msg}\n`);
}
export const info = (m) => emit('info', m);
export const warn = (m) => emit('warn', m);
export const error = (m) => emit('error', m);
export const json = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
```

- [ ] **Step 4: deep-loop.mjs 디스패처 스텁**

`scripts/deep-loop.mjs`:
```javascript
#!/usr/bin/env node
import { error } from './lib/log.mjs';

const [, , sub, ...rest] = process.argv;

const handlers = {
  validate: async () => { process.stdout.write('ok\n'); return 0; },
};

const fn = handlers[sub];
if (!fn) { error(`unknown subcommand: ${sub ?? '<none>'}`); process.exit(2); }
process.exit(await fn(rest));
```

- [ ] **Step 5: Write the failing test**

`tests/scaffold.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('validate exits 0', () => {
  const out = execFileSync('node', ['scripts/deep-loop.mjs', 'validate'], { encoding: 'utf8' });
  assert.match(out, /ok/);
});

test('package.json is module type with node>=20', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.match(pkg.engines.node, />=20/);
});
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS (2 tests)

- [ ] **Step 7: Commit**

```bash
git add package.json .claude-plugin .codex-plugin schemas scripts tests
git commit -m "feat(kernel): scaffold deep-loop plugin + validate command"
```

---

### Task 2: `envelope.mjs` — ULID, atomic write, M3 envelope, content hash

**Files:**
- Create: `scripts/lib/envelope.mjs`
- Test: `tests/envelope.test.mjs`

**Interfaces:**
- Produces:
  - `ulid(now=Date.now(), rnd=Math.random): string` — 26-char Crockford base32 ULID.
  - `atomicWrite(path: string, contents: string): void` — temp+rename.
  - `wrap({producer, artifact_kind, schema, run_id, parent_run_id, git, provenance, payload, now}): object` — M3 envelope.
  - `unwrap(obj, {producer, artifact_kind}): object|null` — identity guard; null + no throw on mismatch.
  - `contentHash(str: string): string` — sha256 hex (node:crypto).

- [ ] **Step 1: Write the failing test**

`tests/envelope.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid, wrap, unwrap, contentHash, atomicWrite } from '../scripts/lib/envelope.mjs';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('ulid is 26-char Crockford base32', () => {
  const id = ulid(1700000000000, 0.5);
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('ulid is monotonic-ish by time prefix', () => {
  const a = ulid(1000, 0.1), b = ulid(2000, 0.1);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
});

test('wrap produces M3 envelope, unwrap guards identity', () => {
  const env = wrap({ producer: 'deep-loop', artifact_kind: 'handoff',
    schema: { name: 'handoff', version: '1.0' }, run_id: ulid(1, 0.1),
    parent_run_id: null, git: { head: 'abc', branch: 'main', dirty: false },
    provenance: { source_artifacts: [], tool_versions: {} }, payload: { a: 1 }, now: '2026-01-01T00:00:00Z' });
  assert.equal(env.schema_version, '1.0');
  assert.equal(env.envelope.producer, 'deep-loop');
  assert.deepEqual(unwrap(env, { producer: 'deep-loop', artifact_kind: 'handoff' }).payload, { a: 1 });
  assert.equal(unwrap(env, { producer: 'deep-work', artifact_kind: 'handoff' }), null); // guard
});

test('atomicWrite then read roundtrips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const p = join(dir, 'x.json');
  atomicWrite(p, '{"k":1}');
  assert.equal(readFileSync(p, 'utf8'), '{"k":1}');
});

test('contentHash is stable sha256 hex', () => {
  assert.equal(contentHash('abc'), contentHash('abc'));
  assert.match(contentHash('abc'), /^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/envelope.test.mjs`
Expected: FAIL ("Cannot find module envelope.mjs")

- [ ] **Step 3: Write `scripts/lib/envelope.mjs`**

```javascript
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford

export function ulid(now = Date.now(), rnd = Math.random) {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) { ts = B32[t % 32] + ts; t = Math.floor(t / 32); }
  let rand = '';
  for (let i = 0; i < 16; i++) {
    const r = typeof rnd === 'function' ? rnd() : rnd;
    rand += B32[Math.floor(r * 32) % 32];
  }
  return ts + rand;
}

export function atomicWrite(path, contents) {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`);
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function contentHash(str) {
  return createHash('sha256').update(str).digest('hex');
}

export function wrap({ producer, artifact_kind, schema, run_id, parent_run_id = null, git = {}, provenance = { source_artifacts: [], tool_versions: {} }, payload, now }) {
  return {
    schema_version: '1.0',
    envelope: { producer, artifact_kind, schema, run_id, parent_run_id,
      generated_at: now ?? new Date().toISOString(), git, provenance },
    payload,
  };
}

export function unwrap(obj, { producer, artifact_kind }) {
  const e = obj?.envelope;
  if (!e || e.producer !== producer || e.artifact_kind !== artifact_kind || e.schema?.name !== artifact_kind) return null;
  return obj;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/envelope.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/envelope.mjs tests/envelope.test.mjs
git commit -m "feat(kernel): envelope — ulid, atomic write, M3 wrap/unwrap, content hash"
```

---

### Task 3: `slug.mjs` — run-id slug 생성

**Files:**
- Create: `scripts/lib/slug.mjs`
- Test: `tests/slug.test.mjs`

**Interfaces:**
- Produces: `slugify(text: string, maxWords=6): string` — kebab-case, ascii, 영숫자/하이픈만. `runIdSlug(goal, now): string` — `<YYYYMMDD-HHMMSS>-<slug>`.

- [ ] **Step 1: Write the failing test**

`tests/slug.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, runIdSlug } from '../scripts/lib/slug.mjs';

test('slugify kebab-cases and strips non-alnum', () => {
  assert.equal(slugify('Add Auth Flow!! 인증'), 'add-auth-flow');
  assert.equal(slugify('  Many   spaces  '), 'many-spaces');
});

test('slugify limits words', () => {
  assert.equal(slugify('one two three four five six seven', 3), 'one-two-three');
});

test('runIdSlug combines timestamp + slug', () => {
  const id = runIdSlug('Add auth', new Date('2026-06-24T15:42:00Z'));
  assert.match(id, /^20260624-154200-add-auth$/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/slug.test.mjs`
Expected: FAIL

- [ ] **Step 3: Write `scripts/lib/slug.mjs`**

```javascript
export function slugify(text, maxWords = 6) {
  const words = String(text)
    .normalize('NFKD').replace(/[^\x00-\x7F]/g, '')   // drop non-ascii
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.slice(0, maxWords).join('-');
}

function pad(n) { return String(n).padStart(2, '0'); }

export function runIdSlug(goal, now = new Date()) {
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${d}-${t}-${slugify(goal) || 'run'}`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/slug.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/slug.mjs tests/slug.test.mjs
git commit -m "feat(kernel): slug — run-id slug generation"
```

---

### Task 4: `schema.mjs` + 완성된 `loop-run.schema.json` — 자체 검증기

**Files:**
- Modify: `schemas/loop-run.schema.json` (전체 스키마)
- Create: `scripts/lib/schema.mjs`
- Test: `tests/schema.test.mjs`

**Interfaces:**
- Produces: `validate(loopJson): {ok: boolean, errors: string[]}` — 자체 구현 검증기(required 필드, enum, 타입). `loadSchema(): object`.
- Consumes: `schemas/loop-run.schema.json`.

- [ ] **Step 1: 전체 스키마 작성** `schemas/loop-run.schema.json` (spec §5 반영, 자체 검증기가 읽는 간소 형식)

```json
{
  "$schema": "deep-loop/v0.2.0",
  "required": ["schema_version","run_id","goal","status","project","routing","review","autonomy","budget","comprehension","circuit_breaker","session_chain","workstreams","active_workstreams","triage","episodes","termination"],
  "enums": {
    "status": ["running","paused","completed","stopped"],
    "routing.protocol": ["deep-work","superpowers","standalone"],
    "autonomy.tier": ["read-only","recommend","act-reversible","act-gated"],
    "autonomy.spawn_style": ["interactive","headless"],
    "budget.unit": ["turns","tokens"],
    "session_chain.lease.state": ["active","releasing","released"],
    "session_chain.lease.handoff_phase": ["idle","reserved","emitted","spawned","acquired"]
  },
  "episode_status": { "skill": ["pending","in_progress","blocked"], "kernel": ["done","approved","rejected"] },
  "workstream_status": { "skill": ["planned","in_progress","in_review","parked"], "kernel": ["ready","merged","abandoned"] }
}
```

- [ ] **Step 2: Write the failing test**

`tests/schema.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../scripts/lib/schema.mjs';

function minimalValid() {
  return {
    schema_version: '0.2.0', run_id: 'R', goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'deep-work' }, review: {}, autonomy: { tier: 'recommend', spawn_style: 'interactive' },
    budget: { unit: 'turns' }, comprehension: {}, circuit_breaker: {},
    session_chain: { lease: { state: 'active', handoff_phase: 'idle' }, sessions: [] },
    workstreams: [], active_workstreams: [], triage: {}, episodes: [], termination: {},
  };
}

test('valid loop.json passes', () => {
  assert.equal(validate(minimalValid()).ok, true);
});

test('missing required field fails', () => {
  const o = minimalValid(); delete o.goal;
  const r = validate(o);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('goal')));
});

test('bad enum fails', () => {
  const o = minimalValid(); o.status = 'bogus';
  const r = validate(o);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('status')));
});
```

- [ ] **Step 3: Run to verify fail**

Run: `node --test tests/schema.test.mjs`
Expected: FAIL

- [ ] **Step 4: Write `scripts/lib/schema.mjs`**

```javascript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export function loadSchema() {
  return JSON.parse(readFileSync(join(here, '../../schemas/loop-run.schema.json'), 'utf8'));
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function validate(loopJson, schema = loadSchema()) {
  const errors = [];
  for (const f of schema.required) {
    if (get(loopJson, f) === undefined) errors.push(`missing required field: ${f}`);
  }
  for (const [path, allowed] of Object.entries(schema.enums)) {
    const v = get(loopJson, path);
    if (v !== undefined && !allowed.includes(v)) errors.push(`invalid enum at ${path}: ${v}`);
  }
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/schema.test.mjs`
Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

```bash
git add schemas/loop-run.schema.json scripts/lib/schema.mjs tests/schema.test.mjs
git commit -m "feat(kernel): schema — self-contained loop.json validator"
```

---

### Task 5: `state.mjs` — lock-safe read/patch + 필드 화이트리스트 + content-hash

**Files:**
- Create: `scripts/lib/state.mjs`
- Test: `tests/state.test.mjs`

**Interfaces:**
- Consumes: `envelope.contentHash`, `envelope.atomicWrite`, `schema.validate`.
- Produces:
  - `runDir(root, runId): string` = `<root>/.deep-loop/runs/<runId>`.
  - `readState(root, runId): {data, hash}` — loop.json + 저장 content-hash 검증(불일치 시 throw `STATE_TAMPERED`).
  - `writeState(root, runId, data): void` — schema 검증 후 atomic write + `.hash` 동기 기록.
  - `patch(root, runId, field, value): void` — **화이트리스트** 검증 후 writeState. 금지 필드는 throw `FIELD_FORBIDDEN`.
  - `WHITELIST: Set<string>` (정확히 spec §4).
  - `withLock(root, runId, fn): T` — mkdir 기반 락.

- [ ] **Step 1: Write the failing test**

`tests/state.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, writeState, patch, runDir } from '../scripts/lib/state.mjs';

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const runId = 'R1';
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
  const data = {
    schema_version: '0.2.0', run_id: runId, goal: 'g', status: 'running',
    project: {}, routing: { protocol: 'deep-work' }, review: { points: ['design'] },
    autonomy: { tier: 'recommend', spawn_style: 'interactive' }, budget: { unit: 'turns', spent: 5 },
    comprehension: {}, circuit_breaker: { tripped: false }, session_chain: { lease: { state: 'active', handoff_phase: 'idle' }, sessions: [] },
    workstreams: [{ id: 'ws-1', status: 'in_progress', depends_on: [] }], active_workstreams: ['ws-1'],
    triage: { actionable: [] }, episodes: [{ id: 'e1', status: 'pending' }], termination: {},
  };
  writeState(root, runId, data);
  return { root, runId };
}

test('read after write roundtrips', () => {
  const { root, runId } = seed();
  assert.equal(readState(root, runId).data.goal, 'g');
});

test('patch allowed field succeeds', () => {
  const { root, runId } = seed();
  patch(root, runId, 'triage.actionable', [{ id: 'x' }]);
  assert.equal(readState(root, runId).data.triage.actionable.length, 1);
});

test('patch forbidden field (budget.spent) throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'budget.spent', 0), /FIELD_FORBIDDEN/);
});

test('patch forbidden review.* throws', () => {
  const { root, runId } = seed();
  assert.throws(() => patch(root, runId, 'review.points', []), /FIELD_FORBIDDEN/);
});

test('tampered hash detected on read', () => {
  const { root, runId } = seed();
  writeFileSync(join(runDir(root, runId), 'loop.json'), '{"goal":"hacked"}'); // direct write, hash unchanged
  assert.throws(() => readState(root, runId), /STATE_TAMPERED/);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test tests/state.test.mjs`
Expected: FAIL

- [ ] **Step 3: Write `scripts/lib/state.mjs`**

```javascript
import { readFileSync, writeFileSync, mkdirSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash, atomicWrite } from './envelope.mjs';
import { validate } from './schema.mjs';

export function runDir(root, runId) { return join(root, '.deep-loop', 'runs', runId); }
const loopPath = (root, runId) => join(runDir(root, runId), 'loop.json');
const hashPath = (root, runId) => join(runDir(root, runId), '.loop.hash');

// 스킬이 patch 가능한 필드 prefix (spec §4). 와일드카드 = startsWith.
const ALLOWED_PREFIXES = [
  'discovered_items', 'triage.', 'decisions',
  'active_workstreams', 'workstreams.', 'episodes.',
];
// 명시 금지 (ALLOWED 안에 들어가도 우선 차단)
const FORBIDDEN_PREFIXES = [
  'budget.spent', 'budget.tokens_spent', 'review.', 'schema_version',
  'session_chain', 'termination.proofs', 'circuit_breaker.tripped',
  'workstreams.*.worktree', 'workstreams.*.branch', 'workstreams.*.base_commit',
];
const FORBIDDEN_VALUES = {
  // 터미널 상태는 patch로 설정 불가
  'episodes.status': ['done', 'approved', 'rejected'],
  'workstreams.status': ['ready', 'merged', 'abandoned'],
};

function fieldForbidden(field, value) {
  for (const f of FORBIDDEN_PREFIXES) {
    const re = new RegExp('^' + f.replace(/\./g, '\\.').replace(/\*/g, '[^.]+'));
    if (re.test(field)) return true;
  }
  for (const [suffix, bad] of Object.entries(FORBIDDEN_VALUES)) {
    const key = suffix.split('.').pop();
    if (field.endsWith('.' + key) || field === suffix) {
      if (bad.includes(value)) return true;
    }
  }
  return false;
}
function fieldAllowed(field) {
  return ALLOWED_PREFIXES.some(p => p.endsWith('.') ? field.startsWith(p) : field === p || field.startsWith(p + '.'));
}

export function readState(root, runId) {
  const raw = readFileSync(loopPath(root, runId), 'utf8');
  const stored = existsSync(hashPath(root, runId)) ? readFileSync(hashPath(root, runId), 'utf8').trim() : null;
  if (stored !== null && contentHash(raw) !== stored) {
    throw new Error(`STATE_TAMPERED: ${runId} loop.json content-hash mismatch`);
  }
  return { data: JSON.parse(raw), hash: stored };
}

export function writeState(root, runId, data) {
  const v = validate(data);
  if (!v.ok) throw new Error(`SCHEMA_INVALID: ${v.errors.join('; ')}`);
  data.updated_at = new Date().toISOString();
  const raw = JSON.stringify(data, null, 2);
  atomicWrite(loopPath(root, runId), raw);
  atomicWrite(hashPath(root, runId), contentHash(raw));
}

function setPath(obj, path, value) {
  const keys = path.split('.'); const last = keys.pop();
  const t = keys.reduce((o, k) => (o[k] ??= {}), obj);
  t[last] = value;
}

export function patch(root, runId, field, value) {
  if (fieldForbidden(field, value)) throw new Error(`FIELD_FORBIDDEN: ${field}`);
  if (!fieldAllowed(field)) throw new Error(`FIELD_FORBIDDEN: ${field} (not in whitelist)`);
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    setPath(data, field, value);
    writeState(root, runId, data);
  });
}

export function withLock(root, runId, fn) {
  const lock = join(runDir(root, runId), '.lock');
  let acquired = false;
  for (let i = 0; i < 50 && !acquired; i++) {
    try { mkdirSync(lock); acquired = true; } catch { /* spin */ }
  }
  if (!acquired) throw new Error(`LOCK_BUSY: ${runId}`);
  try { return fn(); } finally { try { rmdirSync(lock); } catch {} }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/state.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/state.mjs tests/state.test.mjs
git commit -m "feat(kernel): state — lock-safe read/patch, field whitelist, content-hash tamper detection"
```

---

### Task 6: `integrity.mjs` — event-log append + 시퀀스/체크섬 + budget 재계산

**Files:**
- Create: `scripts/lib/integrity.mjs`
- Test: `tests/integrity.test.mjs`

**Interfaces:**
- Consumes: `envelope.contentHash`, `state.runDir`.
- Produces:
  - `appendEvent(root, runId, {type, data}): void` — `event-log.jsonl`에 `{seq, ts, type, data, checksum}` append (checksum = hash(seq+ts+type+JSON(data)+prevChecksum)).
  - `verifyLog(root, runId): {ok, errors}` — 시퀀스 단조 + 체인 체크섬 검증.
  - `recomputeSpent(root, runId): {turns, tokens}` — type='cost' 이벤트 합산.

- [ ] **Step 1: Write the failing test**

`tests/integrity.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, verifyLog, recomputeSpent } from '../scripts/lib/integrity.mjs';
import { runDir } from '../scripts/lib/state.mjs';

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(runDir(root, 'R'), { recursive: true });
  return root;
}

test('append + verify chain ok', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.equal(verifyLog(root, 'R').ok, true);
});

test('recomputeSpent sums cost events', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendEvent(root, 'R', { type: 'decision', data: {} });
  appendEvent(root, 'R', { type: 'cost', data: { turns: 3, tokens: 50 } });
  assert.deepEqual(recomputeSpent(root, 'R'), { turns: 5, tokens: 150 });
});

test('tampered event breaks chain', () => {
  const root = fresh();
  appendEvent(root, 'R', { type: 'cost', data: { turns: 2, tokens: 100 } });
  appendFileSync(join(runDir(root, 'R'), 'event-log.jsonl'),
    JSON.stringify({ seq: 2, ts: 'x', type: 'cost', data: { turns: 999 }, checksum: 'forged' }) + '\n');
  assert.equal(verifyLog(root, 'R').ok, false);
});
```

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/integrity.test.mjs` → FAIL

- [ ] **Step 3: Write `scripts/lib/integrity.mjs`**

```javascript
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { contentHash } from './envelope.mjs';
import { runDir } from './state.mjs';

const logPath = (root, runId) => join(runDir(root, runId), 'event-log.jsonl');

function readLines(root, runId) {
  const p = logPath(root, runId);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function checksumFor(seq, ts, type, data, prev) {
  return contentHash(`${seq}|${ts}|${type}|${JSON.stringify(data)}|${prev}`);
}

export function appendEvent(root, runId, { type, data }) {
  const lines = readLines(root, runId);
  const prev = lines.length ? lines[lines.length - 1].checksum : 'GENESIS';
  const seq = lines.length + 1;
  const ts = new Date().toISOString();
  const checksum = checksumFor(seq, ts, type, data, prev);
  appendFileSync(logPath(root, runId), JSON.stringify({ seq, ts, type, data, checksum }) + '\n');
}

export function verifyLog(root, runId) {
  const lines = readLines(root, runId);
  const errors = [];
  let prev = 'GENESIS';
  lines.forEach((e, i) => {
    if (e.seq !== i + 1) errors.push(`seq gap at ${i + 1}`);
    if (e.checksum !== checksumFor(e.seq, e.ts, e.type, e.data, prev)) errors.push(`checksum break at seq ${e.seq}`);
    prev = e.checksum;
  });
  return { ok: errors.length === 0, errors };
}

export function recomputeSpent(root, runId) {
  return readLines(root, runId).filter(e => e.type === 'cost')
    .reduce((acc, e) => ({ turns: acc.turns + (e.data.turns || 0), tokens: acc.tokens + (e.data.tokens || 0) }), { turns: 0, tokens: 0 });
}
```

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/integrity.test.mjs` → PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/integrity.mjs tests/integrity.test.mjs
git commit -m "feat(kernel): integrity — chained event-log, verify, spent recompute"
```

---

### Task 7: `detect.mjs` — sibling/superpowers/codex 설치 감지

**Files:**
- Create: `scripts/lib/detect.mjs`
- Test: `tests/detect.test.mjs`

**Interfaces:**
- Produces: `detectPlugins(root, home=os.homedir()): {[name]: boolean}` — 키: `deep-work, deep-review, deep-docs, deep-evolve, deep-dashboard, deep-memory, deep-wiki, codex`. 각 값은 spec §11의 config/artifact 존재로 판정.

- [ ] **Step 1: Write the failing test**

`tests/detect.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPlugins } from '../scripts/lib/detect.mjs';

test('detects deep-review by .deep-review/config.yaml', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  mkdirSync(join(root, '.deep-review'), { recursive: true });
  require('node:fs').writeFileSync(join(root, '.deep-review', 'config.yaml'), 'x');
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  assert.equal(detectPlugins(root, home)['deep-review'], true);
  assert.equal(detectPlugins(root, home)['deep-wiki'], false);
});

test('missing siblings report false, never throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const home = mkdtempSync(join(tmpdir(), 'home-'));
  const d = detectPlugins(root, home);
  assert.equal(Object.values(d).every(v => v === false), true);
});
```
(註: ESM에서 `require` 대신 `import { writeFileSync }`를 파일 상단에 추가.)

- [ ] **Step 2: Run to verify fail** — FAIL

- [ ] **Step 3: Write `scripts/lib/detect.mjs`**

```javascript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function detectPlugins(root, home = homedir()) {
  const has = (p) => { try { return existsSync(p); } catch { return false; } };
  return {
    'deep-work': has(join(root, '.claude', 'deep-work-profile.yaml')) || has(join(root, '.deep-work')),
    'deep-review': has(join(root, '.deep-review', 'config.yaml')) || has(join(root, '.deep-review')),
    'deep-docs': has(join(root, '.deep-docs')),
    'deep-evolve': has(join(root, '.deep-evolve', 'session.yaml')) || has(join(root, '.deep-evolve')),
    'deep-dashboard': has(join(root, '.deep-dashboard')),
    'deep-memory': has(join(root, '.deep-memory', 'project-profile.json')) || has(join(home, '.deep-memory')),
    'deep-wiki': has(join(home, '.claude', 'deep-wiki-config.yaml')),
    'codex': has(join(home, '.codex')),
  };
}
```

- [ ] **Step 4: Run to verify pass** — PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/detect.mjs tests/detect.test.mjs
git commit -m "feat(kernel): detect — sibling/codex install detection (graceful)"
```

---

### Task 8: `recipes.mjs` + `recipes/*.json` — recipe+protocol 매칭

**Files:**
- Create: `recipes/robust-implementation.json`, `recipes/autonomous-evolution.json`, `recipes/ship-and-document.json`, `recipes/review-fix-loop.json`, `recipes/context-handoff-only.json`, `recipes/triage-and-discovery.json`
- Create: `scripts/lib/recipes.mjs`
- Test: `tests/recipes.test.mjs`

**Interfaces:**
- Produces: `matchRecipe(goal, detected): {recipe, protocol, reason}` — 키워드 결정론 매칭. protocol = superpowers 키워드 시 superpowers, deep-work 감지 시 deep-work, 아니면 standalone. `loadRecipes(): object[]`.

- [ ] **Step 1: recipe JSON 6개 작성** (각 `{id, name, triggers:[...], flow:[...], protocol_hint, expected_artifacts:[...]}`; trigger 키워드는 spec §9의 한/영 키워드). 예 `recipes/robust-implementation.json`:

```json
{
  "id": "robust-implementation",
  "name": "Robust Implementation",
  "triggers": ["feature","implement","bug","refactor","fix","build","구현","수정","리팩터링","버그"],
  "protocol_hint": "deep-work",
  "flow": ["discover","deep-work:maker","deep-review:checker","deep-docs:scan","archive"],
  "expected_artifacts": [".deep-work/<session>/session-receipt.json",".deep-review/reports/*.md",".deep-docs/last-scan.json"]
}
```
(나머지 5개: autonomous-evolution[optimize/improve/coverage/performance/성능/최적화/커버리지→deep-work], ship-and-document[docs/README/문서→deep-work], review-fix-loop[review/리뷰 대응→deep-work], context-handoff-only[handoff/이어서/인수인계→standalone], triage-and-discovery[triage/discover/점검/정리→standalone]. 각 파일을 위 형식으로 작성.)

- [ ] **Step 2: Write the failing test** `tests/recipes.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRecipe } from '../scripts/lib/recipes.mjs';

const allInstalled = { 'deep-work': true };
test('implementation goal → robust-implementation + deep-work', () => {
  const r = matchRecipe('인증 기능 구현', allInstalled);
  assert.equal(r.recipe, 'robust-implementation');
  assert.equal(r.protocol, 'deep-work');
});
test('handoff goal → context-handoff-only + standalone when no deep-work', () => {
  const r = matchRecipe('세션 이어서 진행', {});
  assert.equal(r.recipe, 'context-handoff-only');
  assert.equal(r.protocol, 'standalone');
});
test('superpowers keyword forces superpowers protocol', () => {
  const r = matchRecipe('구현 using superpowers protocol', { 'deep-work': true });
  assert.equal(r.protocol, 'superpowers');
});
test('no match → triage-and-discovery fallback', () => {
  const r = matchRecipe('알 수 없는 목표 xyzzy', {});
  assert.equal(r.recipe, 'triage-and-discovery');
});
```

- [ ] **Step 3: Run to verify fail** — FAIL

- [ ] **Step 4: Write `scripts/lib/recipes.mjs`**

```javascript
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const recipesDir = join(here, '../../recipes');

export function loadRecipes() {
  return readdirSync(recipesDir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(recipesDir, f), 'utf8')));
}

export function matchRecipe(goal, detected = {}, recipes = loadRecipes()) {
  const g = String(goal).toLowerCase();
  let chosen = recipes.find(r => r.triggers.some(t => g.includes(t.toLowerCase())));
  if (!chosen) chosen = recipes.find(r => r.id === 'triage-and-discovery');
  let protocol;
  if (g.includes('superpowers')) protocol = 'superpowers';
  else if (chosen.protocol_hint === 'deep-work' && detected['deep-work']) protocol = 'deep-work';
  else protocol = 'standalone';
  return { recipe: chosen.id, protocol, reason: `matched ${chosen.id}; protocol=${protocol}` };
}
```

- [ ] **Step 5: Run to verify pass** — PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add recipes scripts/lib/recipes.mjs tests/recipes.test.mjs
git commit -m "feat(kernel): recipes — 6 recipes + keyword recipe/protocol matching"
```

---

### Task 9: `budget.mjs` — 예산 게이트 (turns/tokens/wallclock, soft/hard, fail-closed)

**Files:**
- Create: `scripts/lib/budget.mjs`
- Test: `tests/budget.test.mjs`

**Interfaces:**
- Consumes: `integrity.recomputeSpent`.
- Produces:
  - `checkBudget(loop, {now, sessionStart, measurable=true}): {ok, reason, tier_after}` — hard_stop(spent≥total*hard or tokens≥tokens_total or wallclock≥max_wallclock_sec) → ok:false; soft_stop → tier 강등 recommend; measurable=false + enforcement!='best-effort-interactive' → fail-closed(ok:false).
  - `recordCost(root, runId, {turns, tokens}): void` — `integrity.appendEvent({type:'cost'})`.

- [ ] **Step 1: Write the failing test** `tests/budget.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBudget } from '../scripts/lib/budget.mjs';

const base = () => ({
  budget: { unit: 'turns', total: 100, spent: 0, tokens_total: 1000, tokens_spent: 0,
    max_wallclock_sec: 3600, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0,
    enforcement: 'best-effort-interactive', on_unmeasurable_usage: 'fail-closed' },
  autonomy: { tier: 'act-gated' },
});

test('under budget → ok', () => {
  const l = base(); l.budget.spent = 10;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).ok, true);
});
test('hard stop on turns → not ok', () => {
  const l = base(); l.budget.spent = 100;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).ok, false);
});
test('hard stop on wallclock → not ok', () => {
  const l = base(); l.budget.spent = 1;
  assert.equal(checkBudget(l, { now: 3601_000, sessionStart: 0 }).ok, false);
});
test('soft stop demotes tier', () => {
  const l = base(); l.budget.spent = 85;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0 }).tier_after, 'recommend');
});
test('headless unmeasurable → fail-closed', () => {
  const l = base(); l.budget.enforcement = 'hard'; l.budget.spent = 1;
  assert.equal(checkBudget(l, { now: 0, sessionStart: 0, measurable: false }).ok, false);
});
```

- [ ] **Step 2: Run to verify fail** — FAIL

- [ ] **Step 3: Write `scripts/lib/budget.mjs`**

```javascript
import { appendEvent } from './integrity.mjs';

export function checkBudget(loop, { now = Date.now(), sessionStart = now, measurable = true } = {}) {
  const b = loop.budget;
  if (!measurable && b.enforcement !== 'best-effort-interactive' && b.on_unmeasurable_usage === 'fail-closed') {
    return { ok: false, reason: 'unmeasurable-usage-fail-closed', tier_after: loop.autonomy.tier };
  }
  const wall = (now - sessionStart) / 1000;
  if (b.spent >= b.total * b.hard_stop_ratio) return { ok: false, reason: 'turns-hard-stop', tier_after: loop.autonomy.tier };
  if (b.tokens_total && b.tokens_spent >= b.tokens_total) return { ok: false, reason: 'tokens-hard-stop', tier_after: loop.autonomy.tier };
  if (b.max_wallclock_sec && wall >= b.max_wallclock_sec) return { ok: false, reason: 'wallclock-hard-stop', tier_after: loop.autonomy.tier };
  if (b.spent >= b.total * b.soft_stop_ratio) {
    const demoted = ['act-gated', 'act-reversible'].includes(loop.autonomy.tier) ? 'recommend' : loop.autonomy.tier;
    return { ok: true, reason: 'soft-stop-demote', tier_after: demoted };
  }
  return { ok: true, reason: 'ok', tier_after: loop.autonomy.tier };
}

export function recordCost(root, runId, { turns = 0, tokens = 0 }) {
  appendEvent(root, runId, { type: 'cost', data: { turns, tokens } });
}
```

- [ ] **Step 4: Run to verify pass** — PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/budget.mjs tests/budget.test.mjs
git commit -m "feat(kernel): budget — turns/tokens/wallclock gates, soft demote, fail-closed"
```

---

### Task 10: `breaker.mjs` — circuit breaker

**Files:**
- Create: `scripts/lib/breaker.mjs`
- Test: `tests/breaker.test.mjs`

**Interfaces:**
- Produces:
  - `checkBreaker(loop): {tripped, reason}` — `circuit_breaker.tripped` 또는 `consecutive_request_changes >= 3`이면 tripped.
  - `tripBreaker(root, runId, reason): void` — state writeState로 `circuit_breaker.tripped=true, trip_reason` (커널 전용 경로이므로 writeState 직접 사용).
  - `recordReviewVerdict(root, runId, verdict): void` — REQUEST_CHANGES면 카운터++, 그 외 0 리셋.

- [ ] **Step 1: Write the failing test** `tests/breaker.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkBreaker } from '../scripts/lib/breaker.mjs';

test('not tripped under threshold', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 2 } }).tripped, false);
});
test('tripped at 3 consecutive REQUEST_CHANGES', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: false, consecutive_request_changes: 3 } }).tripped, true);
});
test('explicit tripped flag honored', () => {
  assert.equal(checkBreaker({ circuit_breaker: { tripped: true, consecutive_request_changes: 0 } }).tripped, true);
});
```

- [ ] **Step 2: Run to verify fail** — FAIL

- [ ] **Step 3: Write `scripts/lib/breaker.mjs`**

```javascript
import { readState, writeState, withLock } from './state.mjs';

const THRESHOLD = 3;

export function checkBreaker(loop) {
  const cb = loop.circuit_breaker || {};
  if (cb.tripped) return { tripped: true, reason: cb.trip_reason || 'tripped' };
  if ((cb.consecutive_request_changes || 0) >= THRESHOLD) return { tripped: true, reason: 'consecutive-request-changes' };
  return { tripped: false, reason: null };
}

export function tripBreaker(root, runId, reason) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    data.circuit_breaker = { ...data.circuit_breaker, tripped: true, trip_reason: reason };
    data.status = 'paused';
    writeState(root, runId, data);
  });
}

export function recordReviewVerdict(root, runId, verdict) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const cb = data.circuit_breaker || { consecutive_request_changes: 0 };
    cb.consecutive_request_changes = verdict === 'REQUEST_CHANGES' ? (cb.consecutive_request_changes || 0) + 1 : 0;
    data.circuit_breaker = cb;
    writeState(root, runId, data);
  });
}
```

- [ ] **Step 4: Run to verify pass** — PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/breaker.mjs tests/breaker.test.mjs
git commit -m "feat(kernel): breaker — circuit breaker on consecutive REQUEST_CHANGES"
```

---

### Task 11: `comprehension.mjs` — 이해 부채 원장

**Files:**
- Create: `scripts/lib/comprehension.mjs`
- Test: `tests/comprehension.test.mjs`

**Interfaces:**
- Produces:
  - `computeDebt(loop): {debt_ratio, blocked}` — `1 - episodes_human_reviewed/episodes_total`; `>= debt_threshold`면 blocked(새 maker fan-out 중단).
  - `ack(root, runId, episodeId, {requireHumanAck}): void` — `episodes_human_reviewed++`, episode를 reviewed 마킹.
  - `recordReviewed(root, runId, episodeId, source): void` — source='deep-review-approve'는 `require_human_ack=false`일 때만 카운트.

- [ ] **Step 1: Write the failing test** `tests/comprehension.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDebt } from '../scripts/lib/comprehension.mjs';

test('debt ratio computed; blocked when over threshold', () => {
  const r = computeDebt({ comprehension: { episodes_total: 10, episodes_human_reviewed: 4, debt_threshold: 0.5 } });
  assert.equal(r.debt_ratio, 0.6);
  assert.equal(r.blocked, true);
});
test('under threshold not blocked', () => {
  const r = computeDebt({ comprehension: { episodes_total: 10, episodes_human_reviewed: 6, debt_threshold: 0.5 } });
  assert.equal(r.blocked, false);
});
test('zero episodes → debt 0, not blocked', () => {
  const r = computeDebt({ comprehension: { episodes_total: 0, episodes_human_reviewed: 0, debt_threshold: 0.5 } });
  assert.equal(r.debt_ratio, 0);
  assert.equal(r.blocked, false);
});
```

- [ ] **Step 2: Run to verify fail** — FAIL

- [ ] **Step 3: Write `scripts/lib/comprehension.mjs`**

```javascript
import { readState, writeState, withLock } from './state.mjs';

export function computeDebt(loop) {
  const c = loop.comprehension || {};
  const total = c.episodes_total || 0;
  const reviewed = c.episodes_human_reviewed || 0;
  const debt_ratio = total === 0 ? 0 : 1 - reviewed / total;
  return { debt_ratio, blocked: total > 0 && debt_ratio >= (c.debt_threshold ?? 0.5) };
}

export function ack(root, runId, episodeId) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    const ep = data.episodes.find(e => e.id === episodeId);
    if (ep) ep.human_reviewed = true;
    writeState(root, runId, data);
  });
}

export function recordReviewed(root, runId, episodeId, source) {
  return withLock(root, runId, () => {
    const { data } = readState(root, runId);
    const requireHumanAck = data.review?.require_human_ack === true;
    if (source === 'deep-review-approve' && requireHumanAck) return; // ack 필요, 카운트 안 함
    const ep = data.episodes.find(e => e.id === episodeId);
    if (ep && !ep.human_reviewed) {
      ep.human_reviewed = true;
      data.comprehension.episodes_human_reviewed = (data.comprehension.episodes_human_reviewed || 0) + 1;
    }
    writeState(root, runId, data);
  });
}
```

- [ ] **Step 4: Run to verify pass** — PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/comprehension.mjs tests/comprehension.test.mjs
git commit -m "feat(kernel): comprehension — debt ledger, ack, review-approve counting"
```

---

### Task 12: `init-run` 통합 — CLI `init-run` + state 초기화 빌더

**Files:**
- Create: `scripts/lib/initrun.mjs`
- Modify: `scripts/deep-loop.mjs` (디스패처에 `init-run`, `detect-plugins`, `recipe-match`, `validate` 연결)
- Test: `tests/initrun.test.mjs`

**Interfaces:**
- Consumes: `slug.runIdSlug`, `recipes.matchRecipe`, `detect.detectPlugins`, `state.writeState`, `envelope.ulid`.
- Produces:
  - `buildInitialLoop({goal, protocol, recipe, detected, review, now, runId, root, git}): object` — spec §5 전체 구조의 기본값 채운 loop.json.
  - `initRun(root, {goal, protocol, recipe, review, now}): {runId, loop}` — runDir 생성, loop.json/`.deep-loop/current` 기록.
  - CLI: `node scripts/deep-loop.mjs init-run --goal "<g>" [--protocol p --recipe r --review <json>] [--json]`.

- [ ] **Step 1: Write the failing test** `tests/initrun.test.mjs`

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initRun } from '../scripts/lib/initrun.mjs';
import { readState, runDir } from '../scripts/lib/state.mjs';

test('initRun creates state, current pointer, valid schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  const { runId } = initRun(root, { goal: '인증 기능 구현', detected: { 'deep-work': true }, now: new Date('2026-06-24T15:42:00Z') });
  assert.ok(existsSync(join(runDir(root, runId), 'loop.json')));
  assert.equal(readFileSync(join(root, '.deep-loop', 'current'), 'utf8').trim(), runId);
  const { data } = readState(root, runId);
  assert.equal(data.status, 'running');
  assert.equal(data.routing.protocol, 'deep-work');
  assert.equal(data.recipe.id, 'robust-implementation');
  assert.deepEqual(data.review.points, ['design', 'plan', 'implementation']);
  assert.equal(data.autonomy.tier, 'recommend'); // 기본
  assert.equal(data.session_chain.lease.owner_run_id, runId);
});
```

- [ ] **Step 2: Run to verify fail** — FAIL

- [ ] **Step 3: Write `scripts/lib/initrun.mjs`**

```javascript
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runIdSlug } from './slug.mjs';
import { matchRecipe } from './recipes.mjs';
import { writeState, runDir } from './state.mjs';
import { ulid } from './envelope.mjs';

export function buildInitialLoop({ goal, protocol, recipe, detected = {}, review, now = new Date(), runId, git = {} }) {
  const iso = now.toISOString();
  return {
    schema_version: '0.2.0', run_id: runId, goal, status: 'running',
    created_at: iso, updated_at: iso,
    project: { root: '', git: !!git.head, branch: git.branch || null, head: git.head || null, dirty: !!git.dirty },
    routing: { protocol, selected_by: 'auto' },
    recipe,
    plugins_detected: detected,
    loop_principles: { heartbeat: 'manual-v1', state_is_source_of_truth: true, maker_checker_split: true, human_review_required: true, worktree_isolation_policy: 'recommend' },
    review: review || { points: ['design', 'plan', 'implementation'], reviewer: detected['deep-review'] ? 'deep-review-loop' : 'subagent-checker', mode: 'cross-model', flags: ['--contract', '--codex'], converge: true, max_review_rounds: 5, require_human_ack: false },
    autonomy: { driver: 'continue', tier: 'recommend', auto_handoff: true, spawn_style: 'interactive', max_unreviewed_episodes: 3, max_parallel: 2, max_sessions: 8, milestone_predicate: ['workstream_status_change', 'review_point_passed', 'per_session_turn_cap_reached'], recipe_override_auth: 'user-only', unattended_detect: ['non-tty', 'driver:cron|loop', '--unattended'] },
    budget: { unit: 'turns', total: 200, spent: 0, tokens_total: 4000000, tokens_spent: 0, per_session_turn_cap: 40, max_wallclock_sec: 86400, soft_stop_ratio: 0.8, hard_stop_ratio: 1.0, enforcement: 'best-effort-interactive', unattended_requires_headless: true, on_unmeasurable_usage: 'fail-closed', on_exhaust: 'pause-and-handoff' },
    comprehension: { episodes_total: 0, episodes_human_reviewed: 0, unreviewed_diff_lines: 0, debt_ratio: 0, debt_threshold: 0.5 },
    circuit_breaker: { consecutive_request_changes: 0, tripped: false, trip_reason: null },
    session_chain: { parent_run_id: null, lease: { owner_run_id: runId, generation: 1, acquired_at: iso, expires_at: null, state: 'active', handoff_idempotency_key: null, handoff_phase: 'idle' }, stale_lease_ttl_sec: 900, sessions: [{ run_id: runId, started_at: iso, ended_at: null, turns: 0, outcome: null, superseded_by: null }] },
    workspace_policy: 'recommend',
    workstreams: [], active_workstreams: [],
    discovered_items: [], triage: { actionable: [], needs_human: [], blocked: [], archived: [] },
    episodes: [], current_episode: null,
    connectors: { enabled: [], pre_authorized: [] },
    termination: { max_episodes_policy: 'derived', max_episodes: 24, proofs: ['implementation artifacts exist', 'independent review verdict approve or accepted concern', 'final report exists', 'human verification checklist written'] },
  };
}

export function initRun(root, { goal, protocol, recipe, review, detected = {}, now = new Date(), git = {} }) {
  const runId = ulid(now.getTime());
  const m = matchRecipe(goal, detected);
  const proto = protocol || m.protocol;
  const rec = recipe ? { id: recipe, name: recipe, reason: 'user' } : { id: m.recipe, name: m.recipe, reason: m.reason };
  const loop = buildInitialLoop({ goal, protocol: proto, recipe: rec, detected, review, now, runId, git });
  loop.project.root = root;
  mkdirSync(runDir(root, runId), { recursive: true });
  writeState(root, runId, loop);
  mkdirSync(join(root, '.deep-loop'), { recursive: true });
  writeFileSync(join(root, '.deep-loop', 'current'), runId + '\n');
  return { runId, loop };
}
```

- [ ] **Step 4: 디스패처 연결** — `scripts/deep-loop.mjs`의 `handlers`에 추가:

```javascript
import { initRun } from './lib/initrun.mjs';
import { detectPlugins } from './lib/detect.mjs';
import { matchRecipe } from './lib/recipes.mjs';
import { json } from './lib/log.mjs';

function parseFlags(argv) {
  const f = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]; f[k] = v; } } return f;
}
// handlers 확장:
handlers['detect-plugins'] = async () => { json(detectPlugins(process.cwd())); return 0; };
handlers['recipe-match'] = async (a) => { const f = parseFlags(a); json(matchRecipe(f.goal || '', detectPlugins(process.cwd()))); return 0; };
handlers['init-run'] = async (a) => {
  const f = parseFlags(a);
  const { runId } = initRun(process.cwd(), { goal: f.goal, protocol: f.protocol, recipe: f.recipe, detected: detectPlugins(process.cwd()), review: f.review ? JSON.parse(f.review) : undefined });
  json({ run_id: runId }); return 0;
};
```
(validate는 loop.json이 있으면 schema.validate를 돌리도록 확장하되, 인자 없으면 'ok' 유지.)

- [ ] **Step 5: Run to verify pass** — Run: `node --test tests/initrun.test.mjs` → PASS

- [ ] **Step 6: 전체 테스트 + 커밋**

```bash
npm test
git add scripts/lib/initrun.mjs scripts/deep-loop.mjs tests/initrun.test.mjs
git commit -m "feat(kernel): init-run — build initial loop.json + CLI init-run/detect-plugins/recipe-match"
```

---

## Self-Review (Plan 1)

**Spec coverage (Plan 1 범위):** 스캐폴딩(§2)·envelope/M3(§4)·slug·schema(§5)·state 화이트리스트+content-hash(§4·§1.2)·integrity 체인(§1.2)·detect(§11)·recipes(§9)·budget 게이트(§5·§9)·breaker(§3.2)·comprehension(§3.1)·init-run(§3·§5) — 모두 태스크 존재. lease/handoff/respawn/workspace/episode/review/adapters/next-action/스킬/패키징 = **Plan 2·3**(의도된 범위 밖).

**Placeholder scan:** Task 8 recipe 5개는 형식을 보이고 키워드를 명시했으므로 placeholder 아님(작성자가 동일 형식으로 채움). 그 외 모든 코드 스텝은 완전한 코드 포함.

**Type consistency:** `runDir(root, runId)`·`readState→{data,hash}`·`writeState(root,runId,data)`·`checkBudget(loop,opts)→{ok,reason,tier_after}`·`checkBreaker(loop)→{tripped,reason}`·`computeDebt(loop)→{debt_ratio,blocked}`·`matchRecipe(goal,detected)→{recipe,protocol,reason}` — 태스크 간 시그니처 일관. integrity는 `runDir`를 state에서 import(순환 없음: state는 integrity를 import 안 함).

**알려진 후속(Plan 2에서 소비할 인터페이스):** `readState/writeState/withLock`(state), `appendEvent/recomputeSpent`(integrity), `checkBudget`(budget), `checkBreaker/recordReviewVerdict`(breaker), `computeDebt`(comprehension), `buildInitialLoop`(initrun).

---

## 다음 단계

Plan 2(오케스트레이션: lease·workspace·episode·review·handoff·respawn·next-action·adapters)와 Plan 3(Execution plane 스킬 + 패키징 + 등록)은 Plan 1 실행·검증 후 동일 형식으로 작성한다.
