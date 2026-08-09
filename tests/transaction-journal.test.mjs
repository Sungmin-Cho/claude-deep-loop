import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as journal from '../scripts/lib/transaction-journal.mjs';
import { flushDirectory, renameAtomicWithRetry } from '../scripts/lib/atomic-write.mjs';
import { contentHash, unwrap } from '../scripts/lib/envelope.mjs';
import { captureStableFileIdentity, matchingStableFileIdentity } from '../scripts/lib/fs-safe.mjs';
import { runDir, withLock } from '../scripts/lib/state.mjs';
import * as stateApi from '../scripts/lib/state.mjs';
import { appendAnchored } from '../scripts/lib/integrity.mjs';
import * as integrityApi from '../scripts/lib/integrity.mjs';
import { initRun } from '../scripts/lib/initrun.mjs';
import { createDirectoryJunction, createFileSymlink, createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

test('transaction journal exports the locked preparation surface', () => {
  assert.equal(typeof journal.preparePublicationStagesLocked, 'function');
  assert.equal(typeof journal.findPreparedPublicationLocked, 'function');
  assert.equal(typeof journal.publishArtifactTargetsLocked, 'function');
});

test('journal guard is bound to one exact run for prepare, find, and publish', () => {
  for (const helper of ['prepare', 'find', 'publish']) {
    const root = mkdtempSync(join(tmpdir(), 'dl-tx-cross-run-'));
    const runA = 'RUN-A';
    const runB = 'RUN-B';
    const dirA = runDir(root, runA);
    const dirB = runDir(root, runB);
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const { manifest, stages } = fixture(`cross-${helper}`);
    withLock(root, runA, guardA => {
      withLock(root, runB, guardB => {
        if (helper !== 'prepare') {
          journal.preparePublicationStagesLocked(dirB, guardB, manifest, stages);
        }
        const ownerAPath = join(dirA, '.lock', 'owner.json');
        const ownerBPath = join(dirB, '.lock', 'owner.json');
        const ownerABefore = readFileSync(ownerAPath);
        const ownerBBefore = readFileSync(ownerBPath);
        assert.throws(() => {
          if (helper === 'prepare') journal.preparePublicationStagesLocked(dirB, guardA, manifest, stages);
          else if (helper === 'find') journal.findPreparedPublicationLocked(dirB, guardA);
          else journal.publishArtifactTargetsLocked(dirB, guardA, manifest);
        }, /LOCK_RUN_MISMATCH/, helper);
        assert.deepEqual(readFileSync(ownerAPath), ownerABefore, `${helper}: guard A write`);
        assert.deepEqual(readFileSync(ownerBPath), ownerBBefore, `${helper}: guard B write`);
        if (helper === 'prepare') assert.equal(existsSync(join(dirB, 'transactions')), false);
        if (helper === 'publish') assert.equal(existsSync(join(dirB, 'artifacts', 'a.txt')), false);
      });
    });
  }
});

test('journal rejects a symlink or junction alias even when it resolves to the guarded run', () => {
  const { root, runId, dir } = seed();
  const alias = join(root, 'run-alias');
  createDirectoryJunction(dir, alias);
  withLock(root, runId, guard => {
    const ownerPath = join(dir, '.lock', 'owner.json');
    const before = readFileSync(ownerPath);
    assert.throws(() => journal.findPreparedPublicationLocked(alias, guard), /TRANSACTION_INVALID|LOCK_RUN_MISMATCH/);
    assert.deepEqual(readFileSync(ownerPath), before);
  });
});

function seed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-tx-'));
  const runId = 'R1';
  const dir = runDir(root, runId);
  mkdirSync(dir, { recursive: true });
  return { root, runId, dir };
}

function fixture(operationId = 'op-1') {
  const candidateLoop = Buffer.from('{"candidate":true}');
  const candidateLoopHash = contentHash(candidateLoop);
  const raw = [
    Buffer.from('artifact-a'),
    Buffer.from('artifact-b'),
    Buffer.from('{"seq":1}\n'),
    candidateLoop,
    Buffer.from(candidateLoopHash),
  ];
  const stages = [
    { role: 'artifact', target_rel: 'artifacts/a.txt', bytes: raw[0] },
    { role: 'artifact', target_rel: 'artifacts/b.txt', bytes: raw[1] },
    { role: 'event-line', target_rel: null, bytes: raw[2] },
    { role: 'candidate-loop', target_rel: null, bytes: raw[3] },
    { role: 'candidate-loop-hash', target_rel: null, bytes: raw[4] },
  ];
  const targets = stages.slice(0, 2).map((stage, stage_index) => ({
    role: 'artifact',
    rel: stage.target_rel,
    stage_index,
    candidate_sha256: contentHash(stage.bytes),
    candidate_size: String(stage.bytes.length),
    predecessor: { kind: 'absent' },
  }));
  const manifest = {
    kind: 'workstream-boundary',
    operationId,
    expect: { owner: 'R1', generation: 1 },
    runtime: 'claude',
    projectRoot: '/project/root',
    preLoopHash: 'a'.repeat(64),
    preEventHead: { seq: 0, checksum: 'GENESIS' },
    eventLines: [{
      stage_index: 2,
      seq: 1,
      checksum: 'b'.repeat(64),
      sha256: contentHash(raw[2]),
      size: String(raw[2].length),
    }],
    candidateLoopHash,
    topology: { child_run_id: 'child-1', phase: 'prepared', timestamp: '2026-07-23T00:00:00.000Z' },
    targets,
  };
  return { manifest, stages };
}

function retargetFirstArtifact(manifest, stages, rel) {
  stages[0].target_rel = rel;
  manifest.targets[0].rel = rel;
}

test('locked prepare publishes immutable stages before an exact M3 prepared manifest', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture();
  const labels = [];
  let prepared;
  withLock(root, runId, guard => {
    prepared = journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      nowFn: () => Date.parse('2026-07-23T00:00:00.000Z'),
      faultAt(label) { labels.push(label); },
    });
    const found = journal.findPreparedPublicationLocked(dir, guard);
    assert.deepEqual(found.manifest, manifest);
    assert.equal(Object.isFrozen(found.manifest), true);
    assert.equal(Object.isFrozen(found.stages), true);
    assert.equal(Object.isFrozen(found.stages[0]), true);
    assert.throws(() => found.readStage('0'), /TRANSACTION_RECONCILIATION_REQUIRED/);
    assert.notStrictEqual(found.readStage(0), found.readStage(0));
    assert.equal(found.readStage(0).toString(), 'artifact-a');
  }, { tokenFactory: () => '55555555-5555-4555-8555-555555555555' });

  assert.deepEqual(prepared, { ok: true, operationId: 'op-1' });
  const operation = join(dir, 'transactions', 'op-1');
  const env = JSON.parse(readFileSync(join(operation, 'prepared.json'), 'utf8'));
  assert.ok(unwrap(env, { producer: 'deep-loop', artifact_kind: 'anchored-publication' }));
  assert.equal(env.envelope.schema.version, '1.0');
  assert.equal(env.envelope.run_id, 'R1');
  assert.deepEqual(env.payload.manifest, manifest);
  assert.deepEqual(env.payload.stages, stages.map((stage, index) => ({
    index,
    role: stage.role,
    target_rel: stage.target_rel,
    sha256: contentHash(stage.bytes),
    size: String(stage.bytes.length),
  })));
  assert.deepEqual(readdirSync(join(operation, 'stages')).sort(), [
    '000000.bin', '000001.bin', '000002.bin', '000003.bin', '000004.bin',
  ]);
  const preparedIndex = labels.indexOf('prepared:rename');
  assert.ok(preparedIndex > labels.indexOf('stage:4:verified'));
  assert.equal(existsSync(join(dir, 'artifacts', 'a.txt')), false);
});

test('pre-prepare failure returns a stable result and never publishes a target', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture();
  let stale;
  withLock(root, runId, guard => {
    stale = guard;
    const result = journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      faultAt(label) { if (label === 'prepared:before-write') throw new Error('FAULT'); },
    });
    assert.deepEqual(result, { ok: false, reason: 'TRANSACTION_NOT_PREPARED' });
    assert.equal(journal.findPreparedPublicationLocked(dir, guard), null);
    assert.equal(existsSync(join(dir, 'artifacts', 'a.txt')), false);
  }, { tokenFactory: () => '66666666-6666-4666-8666-666666666666' });
  withLock(root, runId, guard => {
    assert.throws(() => journal.findPreparedPublicationLocked(dir, stale), /LOCK_OWNERSHIP_LOST/);
    assert.equal(journal.findPreparedPublicationLocked(dir, guard), null);
  });
});

test('prepare snapshots caller Buffers before any staging checkpoint', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture();
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      faultAt(label) {
        if (label === 'bootstrap:owner-durable') stages[0].bytes.fill(0x78);
      },
    });
    assert.equal(journal.findPreparedPublicationLocked(dir, guard).readStage(0).toString(), 'artifact-a');
  });
});

test('prepare snapshots caller metadata before any staging checkpoint', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture();
  const expected = structuredClone(manifest);
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      faultAt(label) {
        if (label === 'bootstrap:owner-durable') {
          manifest.kind = 'mutated';
          manifest.topology.phase = 'mutated';
        }
      },
    });
    assert.deepEqual(journal.findPreparedPublicationLocked(dir, guard).manifest, expected);
  });
});

test('artifact publication accepts only candidate bytes and leaves integrity-owned stages private', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture();
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    const result = journal.publishArtifactTargetsLocked(dir, guard, manifest);
    assert.deepEqual(result, { ok: true, published: 2 });
  });
  assert.equal(readFileSync(join(dir, 'artifacts', 'a.txt'), 'utf8'), 'artifact-a');
  assert.equal(readFileSync(join(dir, 'artifacts', 'b.txt'), 'utf8'), 'artifact-b');
  assert.equal(existsSync(join(dir, 'event-log.jsonl')), false);
  assert.equal(existsSync(join(dir, 'loop.json')), false);
  assert.equal(existsSync(join(dir, '.loop.hash')), false);
});

test('artifact replacement independently binds predecessor identity, size, and SHA', () => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'));
  const target = join(dir, 'artifacts', 'a.txt');
  writeFileSync(target, 'old');
  const { manifest, stages } = fixture();
  manifest.targets[0].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('old')),
    identity: captureStableFileIdentity(target),
    size: '3',
  };
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    assert.deepEqual(journal.publishArtifactTargetsLocked(dir, guard, manifest), { ok: true, published: 2 });
  });
  assert.equal(readFileSync(target, 'utf8'), 'artifact-a');
});

// 내용 무변경 재발행(no-op republication) — candidate 바이트가 기록된 predecessor 바이트와 동일한
// target 이다. 그런 target 의 "디스크 내용 == candidate" 는 발행 전에도 후에도 참이므로 순서 정보를
// 담지 않는다. 이것을 발행 완료로 오독하면 앞선 미발행 target 뒤에 놓였을 때 contiguous-prefix 규칙이
// 헛발화한다(Windows T6: emit-invariant 한 terminal/launch-command.txt).
test('an unchanged republication is order-neutral, not an out-of-order publication', () => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const unchanged = join(dir, 'artifacts', 'b.txt');
  writeFileSync(unchanged, 'artifact-b');
  const { manifest, stages } = fixture();
  // target 0 은 신규(predecessor absent → 미발행), target 1 은 predecessor == candidate.
  manifest.targets[1].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('artifact-b')),
    identity: captureStableFileIdentity(unchanged),
    size: String(Buffer.byteLength('artifact-b')),
  };
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    assert.deepEqual(journal.publishArtifactTargetsLocked(dir, guard, manifest), { ok: true, published: 2 });
  });
  assert.equal(readFileSync(join(dir, 'artifacts', 'a.txt'), 'utf8'), 'artifact-a');
  assert.equal(readFileSync(unchanged, 'utf8'), 'artifact-b');
});

// 위 완화가 규칙을 없애지 않았음을 고정한다. 완화 술어는 네 조건의 **논리곱**이므로 각 조건을 독립적으로
// 무너뜨리는 케이스를 따로 둔다 — 하나만 빼먹은 술어(예: size 만 비교, sha 만 비교, marker 무시,
// identity 무시)는 아래 중 정확히 하나에서 깨진다.
const ORDER_ERROR = /TRANSACTION_RECONCILIATION_REQUIRED: artifact publication order/;

// prepared operation 디렉터리는 `transactions/<operationId>` 다(transaction-journal.mjs:787). 여기서는
// 어차피 한 번에 하나만 prepared 일 수 있으므로(:1023) 유일한 항목을 찾아 id 를 되풀이하지 않는다.
function preparedOperationDir(dir) {
  const transactions = join(dir, 'transactions');
  const entries = readdirSync(transactions);
  assert.equal(entries.length, 1, `expected one prepared operation, saw ${entries.join(',')}`);
  return join(transactions, entries[0]);
}

// publisher 가 쓰는 것과 **바이트 동일한** marker 를 심는다. 내용이 다르면 `${kind} marker mismatch`
// 라는 다른 오류가 나므로, 이 테스트가 순서 판정을 태우는지 확인하려면 정확해야 한다.
function plantMarker(dir, target, kind) {
  const markers = join(preparedOperationDir(dir), 'markers');
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, `${kind}-${String(target.stage_index).padStart(6, '0')}.json`), JSON.stringify({
    kind,
    stage_index: target.stage_index,
    rel: target.rel,
    candidate_sha256: target.candidate_sha256,
    predecessor_sha256: target.predecessor.kind === 'present' ? target.predecessor.sha256 : null,
  }));
}

// 원본이 살아 있는 동안 만든 파일을 rename 으로 덮는다 — 새 파일은 이미 다른 inode 를 갖고 있으므로 어느
// 파일시스템에서도 재사용이 불가능하다. 지우고 다시 쓰면 ext4 가 같은 inode 를 재할당한다(ubuntu CI 실측).
function substituteFile(path, bytes) {
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, bytes);
  renameSync(replacement, path);
}

// target 0 = 신규(미발행), target 1 = 디스크에 이미 candidate 바이트가 있는 후행 target.
// predecessor 를 candidate 와 다른 바이트로 덮어쓰는 케이스는 `substitute: true` 로 정체성까지 바꿔야
// **publisher 가 실제로 만들 수 있는** 상태가 된다 — publisher 는 temp+rename 으로만 발행하므로 교체된
// 파일은 항상 새 파일이다. 정체성을 그대로 두면 in-place 변조 상태가 되어 다른 가드에 먼저 걸린다.
function successorFixture(operationId, { predecessorBytes = 'artifact-b', substitute = false } = {}) {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const successor = join(dir, 'artifacts', 'b.txt');
  writeFileSync(successor, 'artifact-b');
  const identity = captureStableFileIdentity(successor);
  if (substitute) substituteFile(successor, 'artifact-b');
  const { manifest, stages } = fixture(operationId);
  manifest.targets[1].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from(predecessorBytes)),
    identity,
    size: String(Buffer.byteLength(predecessorBytes)),
  };
  return { root, runId, dir, successor, manifest, stages };
}

function assertOrderRejected({ root, runId, dir, manifest, stages }) {
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    assert.throws(() => journal.publishArtifactTargetsLocked(dir, guard, manifest), ORDER_ERROR);
  });
  assert.equal(existsSync(join(dir, 'artifacts', 'a.txt')), false);
}

// predecessor 바이트가 candidate 와 다르면 그 후행 target 은 **실제로 발행된** 것이므로 진짜 순서 위반이다.
// 길이는 같고 내용만 다른 케이스를 포함해, size 비교만 남긴 술어를 잡는다.
for (const [label, predecessorBytes] of [
  ['different length', 'older-b'],
  ['same length, different bytes', 'artifact-B'],
]) {
  test(`a genuinely published successor (${label}) still fails the contiguous prefix`, () => {
    assertOrderRejected(successorFixture(`order-${label.replace(/[^a-z]+/gi, '-')}`, {
      predecessorBytes, substitute: true,
    }));
  });
}

// 기록된 predecessor 의 sha 와 size 가 서로 모순인 manifest — sha 비교만 남긴 술어를 잡는다.
test('a predecessor whose recorded size contradicts its hash fails the contiguous prefix', () => {
  const f = successorFixture('order-size-contradiction', { substitute: true });
  f.manifest.targets[1].predecessor = { ...f.manifest.targets[1].predecessor, size: '9' };
  assertOrderRejected(f);
});

// durable marker 는 "발행이 이 target 을 지나갔다"는 별개 증거다. 앞 target 이 미발행인데 뒤에 marker 가
// 있는 vector 는 순차 publisher 가 만들 수 없으므로 모순이며, 무변경 재발행이라도 fail-stop 해야 한다.
// `target-done` 은 순서 판정에서 중립을 깨는 증거이고, `replace-intent` 는 무변경 target 에 대해 그보다
// 앞선 전용 가드에 걸린다 — 위치(첫 target / 후행 target)와 무관하게 같은 오류여야 한다.
for (const [kind, expected] of [
  ['target-done', ORDER_ERROR],
  ['replace-intent', /TRANSACTION_RECONCILIATION_REQUIRED: replace-intent for unchanged target/],
]) {
  test(`a ${kind} marker on an unchanged successor is contradictory evidence, not neutrality`, () => {
    const f = successorFixture(`order-marker-${kind}`);
    withLock(f.root, f.runId, guard => {
      journal.preparePublicationStagesLocked(f.dir, guard, f.manifest, f.stages);
      plantMarker(f.dir, f.manifest.targets[1], kind);
      assert.throws(() => journal.publishArtifactTargetsLocked(f.dir, guard, f.manifest), expected);
    });
    assert.equal(existsSync(join(f.dir, 'artifacts', 'a.txt')), false);
  });
}

// 순차 publisher 는 앞 target 의 target-done 을 쓰기 전에 뒤 target 을 건드리지 않는다. 따라서 "앞 target
// 은 완료 증명이 없는데 뒤 target 에 진행 증거가 있다" 는 vector 는 publisher 가 만들 수 없다 — rollback
// 이나 marker 유실의 흔적이므로 fail-stop 해야 한다. 아래 두 vector 는 내용 기반 판정만으로는 보이지
// 않는다(둘 다 뒤 target 의 진행 증거가 candidate 상태 하나로 환원되지 않기 때문이다).
test('a published successor behind an unproven unchanged target fails the contiguous prefix', () => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const unchanged = join(dir, 'artifacts', 'a.txt');
  const successor = join(dir, 'artifacts', 'b.txt');
  writeFileSync(unchanged, 'artifact-a');
  writeFileSync(successor, 'artifact-b');
  const { manifest, stages } = fixture('order-frontier-unchanged-first');
  // target 0: 무변경 재발행이며 marker 가 없다 → 완료 증명 없음.
  manifest.targets[0].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('artifact-a')),
    identity: captureStableFileIdentity(unchanged),
    size: String(Buffer.byteLength('artifact-a')),
  };
  // target 1: predecessor 와 다른 candidate 바이트가 자리에 있다 → 실제로 발행된 흔적.
  // 발행은 temp+rename 이므로 정체성도 함께 달라져야 실제로 도달 가능한 상태가 된다.
  const successorIdentity = captureStableFileIdentity(successor);
  substituteFile(successor, 'artifact-b');
  manifest.targets[1].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('older-b')),
    identity: successorIdentity,
    size: String(Buffer.byteLength('older-b')),
  };
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    assert.throws(() => journal.publishArtifactTargetsLocked(dir, guard, manifest), ORDER_ERROR);
  });
});

test('a replace-intent marker behind an unpublished target fails the contiguous prefix', () => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const successor = join(dir, 'artifacts', 'b.txt');
  writeFileSync(successor, 'older-b');
  const { manifest, stages } = fixture('order-frontier-replace-intent');
  // target 0 은 디스크에 없고 predecessor 도 absent → 미발행.
  // target 1 은 아직 predecessor 상태인데 replace-intent 가 있다 → publisher 가 여기까지 왔다는 증거.
  manifest.targets[1].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('older-b')),
    identity: captureStableFileIdentity(successor),
    size: String(Buffer.byteLength('older-b')),
  };
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    plantMarker(dir, manifest.targets[1], 'replace-intent');
    assert.throws(() => journal.publishArtifactTargetsLocked(dir, guard, manifest), ORDER_ERROR);
  });
  assert.equal(existsSync(join(dir, 'artifacts', 'a.txt')), false);
});

// publisher 는 temp+rename 으로만 발행하므로 "내용 무변경" 과 "같은 파일" 은 반드시 함께 참이거나 함께
// 거짓이다. 어긋나는 두 방향은 각각 동일-바이트 바꿔치기와 in-place 변조이고, 둘 다 publisher 가 만들 수
// 없다 — 순서 판정에 앞서 그 자리에서 fail-stop 해야 하며, **첫 target** 이어도 마찬가지다.
const DISAGREEMENT = /TRANSACTION_RECONCILIATION_REQUIRED: artifact identity disagreement/;

test('an identical-byte substitution of an unchanged target fails even as the first target', () => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const unchanged = join(dir, 'artifacts', 'a.txt');
  writeFileSync(unchanged, 'artifact-a');
  const { manifest, stages } = fixture('disagreement-substituted-identity');
  manifest.targets[0].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('artifact-a')),
    identity: captureStableFileIdentity(unchanged),
    size: String(Buffer.byteLength('artifact-a')),
  };
  substituteFile(unchanged, 'artifact-a');
  assert.equal(
    matchingStableFileIdentity(captureStableFileIdentity(unchanged), manifest.targets[0].predecessor.identity),
    false,
    'the substituted file must present a different stable identity for this test to cover anything',
  );
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    assert.throws(() => journal.publishArtifactTargetsLocked(dir, guard, manifest), DISAGREEMENT);
  });
});

test('an in-place mutation of a replaced target fails even as the first target', () => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const mutated = join(dir, 'artifacts', 'a.txt');
  writeFileSync(mutated, 'older-a');
  const identity = captureStableFileIdentity(mutated);
  // 같은 파일을 그대로 두고 내용만 candidate 로 바꾼다 — rename 이 아니므로 정체성이 유지된다.
  writeFileSync(mutated, 'artifact-a');
  assert.equal(
    matchingStableFileIdentity(captureStableFileIdentity(mutated), identity), true,
    'an in-place write must keep the stable identity for this test to cover anything',
  );
  const { manifest, stages } = fixture('disagreement-in-place-mutation');
  manifest.targets[0].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('older-a')),
    identity,
    size: String(Buffer.byteLength('older-a')),
  };
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    assert.throws(() => journal.publishArtifactTargetsLocked(dir, guard, manifest), DISAGREEMENT);
  });
});

// 무변경 재발행 target 에는 replace-intent 가 있을 수 없다 — publisher 는 그런 target 을 candidate fast
// path 로 지나가고, 거기서 쓰는 marker 는 target-done 뿐이며 unlink 는 하지 않는다. 앞 target 의 frontier
// 없이 **단독으로** 걸러야 한다.
test('a replace-intent marker on an unchanged target fails even as the first target', () => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const unchanged = join(dir, 'artifacts', 'a.txt');
  writeFileSync(unchanged, 'artifact-a');
  const { manifest, stages } = fixture('unchanged-replace-intent-first');
  manifest.targets[0].predecessor = {
    kind: 'present',
    sha256: contentHash(Buffer.from('artifact-a')),
    identity: captureStableFileIdentity(unchanged),
    size: String(Buffer.byteLength('artifact-a')),
  };
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    plantMarker(dir, manifest.targets[0], 'replace-intent');
    assert.throws(
      () => journal.publishArtifactTargetsLocked(dir, guard, manifest),
      /TRANSACTION_RECONCILIATION_REQUIRED: replace-intent for unchanged target/,
    );
  });
});

test('artifact publication rejects even an internal target symlink', (t) => {
  const { root, runId, dir } = seed();
  mkdirSync(join(dir, 'artifacts'));
  const real = join(dir, 'artifacts', 'real.txt');
  writeFileSync(real, 'old');
  if (!createFileSymlinkOrSkip(t, real, join(dir, 'artifacts', 'a.txt'))) return;
  const { manifest, stages } = fixture();
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    assert.throws(() => journal.publishArtifactTargetsLocked(dir, guard, manifest), /TRANSACTION_RECONCILIATION_REQUIRED/);
  });
  assert.equal(readFileSync(real, 'utf8'), 'old');
});

test('journal rejects unsafe operation and target paths before writing outside the run', () => {
  for (const operationId of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'C:\\escape', '\\server\\share', 'nul\0x']) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(operationId);
    withLock(root, runId, guard => {
      assert.throws(() => journal.preparePublicationStagesLocked(dir, guard, manifest, stages), /TRANSACTION_INVALID/);
    });
  }
});

test('verified find fails closed on missing stage and multiple prepared operations', () => {
  const { root, runId, dir } = seed();
  const first = fixture('op-1');
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, first.manifest, first.stages);
    const stage = join(dir, 'transactions', 'op-1', 'stages', '000001.bin');
    // Directory replacement proves a non-file/missing stage cannot be accepted.
    const saved = `${stage}.saved`;
    renameSync(stage, saved);
    assert.throws(() => journal.findPreparedPublicationLocked(dir, guard), /TRANSACTION_RECONCILIATION_REQUIRED/);
    renameSync(saved, stage);

    const preparedPath = join(dir, 'transactions', 'op-1', 'prepared.json');
    const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
    prepared.payload.stages[0].size = Number(prepared.payload.stages[0].size);
    writeFileSync(preparedPath, JSON.stringify(prepared));
    assert.throws(() => journal.findPreparedPublicationLocked(dir, guard), /stage record 0/);
    prepared.payload.stages[0].size = String(prepared.payload.stages[0].size);
    writeFileSync(preparedPath, JSON.stringify(prepared));

    const second = fixture('op-2');
    assert.throws(
      () => journal.preparePublicationStagesLocked(dir, guard, second.manifest, second.stages),
      /TRANSACTION_RECONCILIATION_REQUIRED/,
    );
    cpSync(join(dir, 'transactions', 'op-1'), join(dir, 'transactions', 'op-2'), { recursive: true });
    assert.throws(() => journal.findPreparedPublicationLocked(dir, guard), /multiple prepared operations/);
  });
});

test('prepared authorization binds transaction owner run and generated timestamp exactly', () => {
  const mutations = [
    ['run-id', env => { env.envelope.run_id = 'OTHER-RUN'; }],
    ['generated-at-canonical', env => { env.envelope.generated_at = 'not-an-iso-timestamp'; }],
    ['generated-at-equality', env => { env.envelope.generated_at = '2026-07-23T00:00:00.001Z'; }],
  ];
  for (const [label, mutate] of mutations) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`owner-${label}`);
    withLock(root, runId, guard => {
      journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
        nowFn: () => Date.parse('2026-07-23T00:00:00.000Z'),
      });
      const ownerPath = join(dir, 'transactions', `owner-${label}`, 'owner.json');
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      mutate(owner);
      writeFileSync(ownerPath, JSON.stringify(owner));
      assert.throws(
        () => journal.findPreparedPublicationLocked(dir, guard),
        /TRANSACTION_RECONCILIATION_REQUIRED/,
        label,
      );
    });
  }
});

test('prepared reopen validates the complete M3 timestamp and standard identity fields', () => {
  const mutations = [
    ['schema-version', env => { env.schema_version = '2.0'; }],
    ['producer', env => { env.envelope.producer = 'foreign'; }],
    ['artifact-kind', env => { env.envelope.artifact_kind = 'foreign'; }],
    ['run-id', env => { env.envelope.run_id = 'OTHER-RUN'; }],
    ['generated-at-canonical', env => { env.envelope.generated_at = '2026-07-23T00:00:00Z'; }],
    ['generated-at-owner-equality', env => { env.envelope.generated_at = '2026-07-23T00:00:00.001Z'; }],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`prepared-m3-${index}`);
    withLock(root, runId, guard => {
      journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
        nowFn: () => Date.parse('2026-07-23T00:00:00.000Z'),
      });
      const preparedPath = join(dir, 'transactions', `prepared-m3-${index}`, 'prepared.json');
      const prepared = JSON.parse(readFileSync(preparedPath, 'utf8'));
      mutate(prepared);
      writeFileSync(preparedPath, JSON.stringify(prepared));
      assert.throws(
        () => journal.findPreparedPublicationLocked(dir, guard),
        /TRANSACTION_RECONCILIATION_REQUIRED/,
        label,
      );
    });
  }
});

test('dead-orphan cleanup preserves owner envelopes with invalid run or timestamp bindings', () => {
  const mutations = [
    ['run-id', env => { env.envelope.run_id = 'OTHER-RUN'; }],
    ['generated-at-canonical', env => { env.envelope.generated_at = 'not-an-iso-timestamp'; }],
    ['generated-at-equality', env => { env.envelope.generated_at = '2026-07-23T00:00:00.001Z'; }],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    const { root, runId, dir } = seed();
    let now = 1_000;
    const first = fixture(`orphan-owner-${label}`);
    withLock(root, runId, guard => {
      assert.deepEqual(journal.preparePublicationStagesLocked(dir, guard, first.manifest, first.stages, {
        nowFn: () => now,
        faultAt(observed) {
          if (observed === 'prepared:before-write' || observed === 'orphan:delete') {
            throw new Error(`KILL:${observed}`);
          }
        },
      }), { ok: false, reason: 'TRANSACTION_NOT_PREPARED' });
    }, {
      nowFn: () => now,
      pid: 61_000 + index,
      tokenFactory: () => `77777777-7777-4777-8777-77777777777${index}`,
    });
    const transactions = join(dir, 'transactions');
    const orphanName = readdirSync(transactions).find(name => name.startsWith('.orphan-'));
    const orphan = join(transactions, orphanName);
    const ownerPath = join(orphan, 'owner.json');
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    mutate(owner);
    writeFileSync(ownerPath, JSON.stringify(owner));
    now += 31_000;
    const second = fixture(`orphan-successor-${label}`);
    assert.throws(() => withLock(root, runId, guard => {
      journal.preparePublicationStagesLocked(dir, guard, second.manifest, second.stages, {
        nowFn: () => now,
        probePid: () => 'dead',
      });
    }, {
      nowFn: () => now,
      pid: 62_000 + index,
      tokenFactory: () => `88888888-8888-4888-8888-88888888888${index}`,
    }), /TRANSACTION_RECONCILIATION_REQUIRED/, label);
    assert.equal(existsSync(orphan), true, label);
  }
});

test('artifact helpers reject state, event, lock, and transaction namespace targets without byte changes', () => {
  for (const [index, rel] of [
    'loop.json',
    '.loop.hash',
    'event-log.jsonl',
    '.lock/protected.bin',
    'transactions/protected.bin',
    'LOOP.JSON',
    '.LOCK/protected.bin',
    'TRANSACTIONS/protected.bin',
  ].entries()) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`reserved-${index}`);
    retargetFirstArtifact(manifest, stages, rel);
    withLock(root, runId, guard => {
      const target = join(dir, ...rel.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'protected-byte');
      let observed;
      try {
        journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
        journal.publishArtifactTargetsLocked(dir, guard, manifest);
      } catch (error) {
        observed = error;
      }
      assert.equal(readFileSync(target, 'utf8'), 'protected-byte', rel);
      assert.match(String(observed?.message || observed), /TRANSACTION_INVALID/, rel);
    });
  }
});

test('terminal, recovery, and checkpoint artifact namespaces remain valid', () => {
  for (const [index, rel] of [
    'final-report.md',
    'recoveries/child-affinity-recovery.json',
    'checkpoints/compact-owner-1.json',
  ].entries()) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`allowed-${index}`);
    retargetFirstArtifact(manifest, stages, rel);
    withLock(root, runId, guard => {
      assert.deepEqual(
        journal.preparePublicationStagesLocked(dir, guard, manifest, stages),
        { ok: true, operationId: `allowed-${index}` },
      );
      assert.deepEqual(journal.publishArtifactTargetsLocked(dir, guard, manifest), { ok: true, published: 2 });
    });
    assert.equal(readFileSync(join(dir, ...rel.split('/')), 'utf8'), 'artifact-a', rel);
  }
});

test('manifest accepts only the fixed target/event wire and canonical decimal sizes', () => {
  const invalidMutations = [
    manifest => {
      const target = manifest.targets[0];
      delete target.role;
      delete target.candidate_sha256;
      delete target.candidate_size;
      target.candidate = { sha256: 'c'.repeat(64), size: 10 };
    },
    manifest => { manifest.targets[0].candidate_size = 10; },
    manifest => { manifest.targets[0].candidate_size = '010'; },
    manifest => { manifest.eventLines[0].size = 10; },
    manifest => { manifest.eventLines[0].size = '010'; },
    manifest => { manifest.eventLines[0].sha256 = 'c'.repeat(64); },
    manifest => { delete manifest.eventLines[0].checksum; },
    manifest => {
      manifest.targets[0].predecessor = {
        kind: 'present',
        sha256: 'c'.repeat(64),
        identity: { dev: '1', ino: '2', birthtime_ns: '0' },
        size: 3,
      };
    },
  ];
  for (const [index, mutate] of invalidMutations.entries()) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`invalid-${index}`);
    mutate(manifest);
    withLock(root, runId, guard => {
      assert.throws(
        () => journal.preparePublicationStagesLocked(dir, guard, manifest, stages),
        /TRANSACTION_INVALID/,
      );
    });
  }
});

test('verified readStage rejects same-byte inode replacement and file symlinks', (t) => {
  for (const mode of ['replacement', 'symlink']) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`identity-${mode}`);
    withLock(root, runId, guard => {
      journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
      const found = journal.findPreparedPublicationLocked(dir, guard);
      const stage = join(dir, 'transactions', `identity-${mode}`, 'stages', '000000.bin');
      const displaced = `${stage}.displaced`;
      renameSync(stage, displaced);
      if (mode === 'replacement') writeFileSync(stage, readFileSync(displaced));
      else if (!createFileSymlinkOrSkip(t, displaced, stage)) return;
      assert.throws(() => found.readStage(0), /TRANSACTION_RECONCILIATION_REQUIRED/, mode);
    });
  }
});

test('verified readStage rejects an intermediate stages-directory substitution', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture('identity-directory');
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    const found = journal.findPreparedPublicationLocked(dir, guard);
    const stagesDir = join(dir, 'transactions', 'identity-directory', 'stages');
    const displaced = `${stagesDir}.displaced`;
    renameSync(stagesDir, displaced);
    createDirectoryJunction(displaced, stagesDir);
    assert.throws(() => found.readStage(0), /TRANSACTION_RECONCILIATION_REQUIRED/);
  });
});

test('bootstrap transfer flushes source and destination parents in exact order', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture('parent-flush-order');
  const trace = [];
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      renameOperationFn(src, dst) {
        trace.push(['rename', src, dst]);
        renameAtomicWithRetry(src, dst);
      },
      flushDirectoryFn(path) {
        trace.push(['flush', path]);
        flushDirectory(path);
      },
      faultAt(label) { trace.push(['barrier', label]); },
    });
  });
  const renameIndex = trace.findIndex(([kind, , dst]) => kind === 'rename'
    && basename(dst) === 'parent-flush-order');
  assert.ok(renameIndex >= 0);
  const [, source, destination] = trace[renameIndex];
  const sourceFlush = trace.findIndex(([kind, path], index) => index > renameIndex
    && kind === 'flush' && path === dirname(source));
  const destinationFlush = trace.findIndex(([kind, path], index) => index > sourceFlush
    && kind === 'flush' && path === dirname(destination));
  assert.ok(sourceFlush > renameIndex);
  assert.ok(destinationFlush > sourceFlush);
  assert.ok(trace.some(entry => entry[0] === 'barrier' && entry[1] === 'bootstrap:source-parent-flushed'));
  assert.ok(trace.some(entry => entry[0] === 'barrier' && entry[1] === 'bootstrap:destination-parent-flushed'));
});

test('journal exposes exact atomic and digest crash barriers for every stage and prepared marker', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture('barrier-contract');
  const labels = [];
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      faultAt(label) { labels.push(label); },
    });
  });
  for (const phase of ['write', 'file-flush', 'rename', 'parent-flush', 'digest-verified']) {
    assert.ok(labels.includes(`stage:0:${phase}`), phase);
  }
  for (const phase of ['write', 'file-flush', 'rename', 'parent-flush', 'digest-verified']) {
    assert.ok(labels.includes(`prepared:${phase}`), phase);
  }
});

test('stage and prepared crash barriers preserve the pre/post-prepare recovery boundary', () => {
  for (const label of [
    'stage:0:write',
    'stage:0:file-flush',
    'stage:0:rename',
    'stage:0:parent-flush',
    'stage:0:digest-verified',
    'prepared:write',
    'prepared:file-flush',
  ]) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`fault-${label.replaceAll(':', '-')}`);
    withLock(root, runId, guard => {
      const result = journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
        faultAt(observed) { if (observed === label) throw new Error(`KILL:${label}`); },
      });
      assert.deepEqual(result, { ok: false, reason: 'TRANSACTION_NOT_PREPARED' }, label);
      assert.equal(journal.findPreparedPublicationLocked(dir, guard), null, label);
    });
  }
  for (const label of ['prepared:rename', 'prepared:parent-flush', 'prepared:digest-verified']) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`pending-${label.replaceAll(':', '-')}`);
    withLock(root, runId, guard => {
      assert.throws(
        () => journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
          faultAt(observed) { if (observed === label) throw new Error(`KILL:${label}`); },
        }),
        /TRANSACTION_PENDING/,
        label,
      );
      assert.ok(journal.findPreparedPublicationLocked(dir, guard), label);
    });
  }
});

test('artifact publication exposes injectable durable phases and converges after each crash boundary', () => {
  const phases = ['write', 'file-flush', 'rename', 'parent-flush'];
  for (const phase of phases) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture(`artifact-fault-${phase}`);
    withLock(root, runId, guard => {
      journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
      assert.throws(() => journal.publishArtifactTargetsLocked(dir, guard, manifest, {
        faultAt(label) {
          if (label === `artifact:0:${phase}`) throw new Error(`KILL:${label}`);
        },
      }), new RegExp(`KILL:artifact:0:${phase}`));
      const firstTarget = join(dir, 'artifacts', 'a.txt');
      assert.equal(existsSync(firstTarget), ['rename', 'parent-flush'].includes(phase), phase);
      assert.deepEqual(
        journal.publishArtifactTargetsLocked(dir, guard, manifest),
        { ok: true, published: 2 },
        phase,
      );
      assert.equal(readFileSync(firstTarget, 'utf8'), 'artifact-a');
    });
  }
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture('artifact-phase-trace');
  const labels = [];
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, manifest, stages);
    journal.publishArtifactTargetsLocked(dir, guard, manifest, {
      faultAt(label) { labels.push(label); },
    });
  });
  assert.deepEqual(labels.filter(label => label.startsWith('artifact:0:')), [
    'artifact:0:write',
    'artifact:0:file-flush',
    'artifact:0:rename',
    'artifact:0:parent-flush',
    'artifact:0:digest-verified',
    'artifact:0:target-done',
  ]);
});

test('orphan quarantine and deletion flush their parent with explicit crash barriers', () => {
  const { root, runId, dir } = seed();
  let now = 1_000;
  const first = fixture('orphan-durability');
  const labels = [];
  const flushes = [];
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, first.manifest, first.stages, {
      nowFn: () => now,
      flushDirectoryFn(path) { flushes.push(path); flushDirectory(path); },
      faultAt(label) {
        labels.push(label);
        if (label === 'prepared:before-write' || label === 'orphan:delete') throw new Error(`KILL:${label}`);
      },
    });
  }, {
    nowFn: () => now,
    pid: 63_001,
    tokenFactory: () => '91919191-9191-4191-8191-919191919191',
  });
  const transactions = join(dir, 'transactions');
  assert.ok(labels.includes('orphan:quarantine-parent-flushed'));
  const isTransactionsParent = path => basename(path) === 'transactions'
    && basename(dirname(path)) === runId;
  assert.ok(flushes.some(isTransactionsParent));
  now += 31_000;
  const second = fixture('orphan-durability-successor');
  withLock(root, runId, guard => {
    assert.deepEqual(journal.preparePublicationStagesLocked(dir, guard, second.manifest, second.stages, {
      nowFn: () => now,
      probePid: () => 'dead',
      flushDirectoryFn(path) { flushes.push(path); flushDirectory(path); },
      faultAt(label) { labels.push(label); },
    }), { ok: true, operationId: 'orphan-durability-successor' });
  }, {
    nowFn: () => now,
    pid: 63_002,
    tokenFactory: () => '92929292-9292-4292-8292-929292929292',
  });
  assert.ok(labels.includes('orphan:deleted'));
  assert.ok(labels.includes('orphan:delete-parent-flushed'));
  assert.ok(flushes.filter(isTransactionsParent).length >= 2);
});

test('orphan deletion revalidates identity after the final pre-delete fault seam', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture('orphan-final-race');
  const transactions = join(dir, 'transactions');
  let successor;
  withLock(root, runId, guard => {
    assert.deepEqual(journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      faultAt(label) {
        if (label === 'prepared:before-write') throw new Error('KILL:prepared');
        if (label === 'orphan:delete') {
          const name = readdirSync(transactions).find(entry => entry.startsWith('.orphan-'));
          successor = join(transactions, name);
          renameSync(successor, `${successor}.displaced`);
          mkdirSync(successor);
          writeFileSync(join(successor, 'successor-byte'), 'keep');
        }
      },
    }), { ok: false, reason: 'TRANSACTION_NOT_PREPARED' });
  });
  assert.equal(readFileSync(join(successor, 'successor-byte'), 'utf8'), 'keep');
});

test('bootstrap and pre-prepare crash points never expose a final target', () => {
  for (const stop of [
    'bootstrap:created',
    'bootstrap:identity',
    'bootstrap:owner-durable',
    'bootstrap:rename',
    'stage:0:verified',
    'prepared:before-write',
  ]) {
    const { root, runId, dir } = seed();
    const { manifest, stages } = fixture();
    withLock(root, runId, guard => {
      const result = journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
        faultAt(label) { if (label === stop) throw new Error(`KILL:${stop}`); },
      });
      assert.deepEqual(result, { ok: false, reason: 'TRANSACTION_NOT_PREPARED' }, stop);
      assert.equal(existsSync(join(dir, 'artifacts', 'a.txt')), false, stop);
      assert.equal(journal.findPreparedPublicationLocked(dir, guard), null, stop);
    });
  }
});

test('pre-transfer bootstrap residue stays protected by the dead-owner lock and is reclaimed with it', () => {
  const { root, runId, dir } = seed();
  const { manifest, stages } = fixture();
  let now = 1_000;
  withLock(root, runId, guard => {
    assert.deepEqual(journal.preparePublicationStagesLocked(dir, guard, manifest, stages, {
      nowFn: () => now,
      faultAt(label) { if (label === 'bootstrap:owner-durable') throw new Error('KILL'); },
    }), { ok: false, reason: 'TRANSACTION_NOT_PREPARED' });
  }, {
    nowFn: () => now,
    pid: 50_001,
    tokenFactory: () => '01010101-0101-4101-8101-010101010101',
    faultAt(label) { if (label === 'release:validated') throw new Error('KILL'); },
  });
  const lock = join(dir, '.lock');
  assert.equal(readdirSync(join(lock, 'operation-bootstrap')).length, 1);
  now += 31_000;
  assert.throws(() => withLock(root, runId, () => {}, {
    nowFn: () => now, probePid: () => 'unknown', retries: 1, backoffMs: 0,
  }), /LOCK_BUSY/);
  withLock(root, runId, () => {}, {
    nowFn: () => now,
    pid: 50_002,
    tokenFactory: () => '02020202-0202-4202-8202-020202020202',
    probePid: () => 'dead', retries: 2, backoffMs: 0,
  });
  assert.equal(existsSync(lock), false);
});

test('a dead-owner orphan cleaner resumes exact quarantine and permits one successor operation', () => {
  const { root, runId, dir } = seed();
  let now = 1_000;
  const first = fixture('op-1');
  withLock(root, runId, guard => {
    const result = journal.preparePublicationStagesLocked(dir, guard, first.manifest, first.stages, {
      nowFn: () => now,
      faultAt(label) {
        if (label === 'prepared:before-write' || label === 'orphan:delete') throw new Error(`KILL:${label}`);
      },
    });
    assert.deepEqual(result, { ok: false, reason: 'TRANSACTION_NOT_PREPARED' });
  }, {
    nowFn: () => now,
    pid: 51_001,
    tokenFactory: () => '11111111-2222-4333-8444-555555555555',
  });
  const transactions = join(dir, 'transactions');
  assert.deepEqual(readdirSync(transactions).filter(name => name.startsWith('.orphan-')).length, 1);

  now += 31_000;
  const second = fixture('op-2');
  withLock(root, runId, guard => {
    assert.deepEqual(journal.preparePublicationStagesLocked(dir, guard, second.manifest, second.stages, {
      nowFn: () => now,
      probePid: () => 'dead',
    }), { ok: true, operationId: 'op-2' });
  }, {
    nowFn: () => now,
    pid: 51_002,
    tokenFactory: () => '22222222-3333-4444-8555-666666666666',
  });
  assert.equal(existsSync(join(transactions, 'op-1')), false);
  assert.equal(readdirSync(transactions).some(name => name.startsWith('.orphan-op-1-')), false);
  assert.equal(existsSync(join(transactions, 'op-2', 'prepared.json')), true);
});

test('orphan and successor collision is divergent evidence and deletes neither directory', () => {
  const { root, runId, dir } = seed();
  let now = 1_000;
  const first = fixture('op-1');
  withLock(root, runId, guard => {
    journal.preparePublicationStagesLocked(dir, guard, first.manifest, first.stages, {
      nowFn: () => now,
      faultAt(label) {
        if (label === 'prepared:before-write' || label === 'orphan:delete') throw new Error(`KILL:${label}`);
      },
    });
  }, {
    nowFn: () => now, pid: 53_001,
    tokenFactory: () => '66666666-7777-4888-8999-aaaaaaaaaaaa',
  });
  const transactions = join(dir, 'transactions');
  const orphanName = readdirSync(transactions).find(name => name.startsWith('.orphan-'));
  const orphan = join(transactions, orphanName);
  const successor = join(transactions, 'op-1');
  cpSync(orphan, successor, { recursive: true });
  writeFileSync(join(successor, 'successor-byte'), 'keep');
  now += 31_000;
  assert.throws(() => withLock(root, runId, guard => {
    const second = fixture('op-2');
    journal.preparePublicationStagesLocked(dir, guard, second.manifest, second.stages, {
      nowFn: () => now, probePid: () => 'dead',
    });
  }, {
    nowFn: () => now, pid: 53_002,
    tokenFactory: () => '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
  }), /divergent orphan collision/);
  assert.equal(existsSync(orphan), true);
  assert.equal(readFileSync(join(successor, 'successor-byte'), 'utf8'), 'keep');
});

test('live, unknown, foreign, or changed orphan ownership is preserved fail-closed', () => {
  for (const scenario of ['alive', 'unknown', 'foreign', 'changed-marker', 'changed-identity']) {
    const { root, runId, dir } = seed();
    let now = 1_000;
    const first = fixture('op-1');
    withLock(root, runId, guard => {
      journal.preparePublicationStagesLocked(dir, guard, first.manifest, first.stages, {
        nowFn: () => now,
        faultAt(label) {
          if (label === 'prepared:before-write' || label === 'orphan:delete') throw new Error(`KILL:${label}`);
        },
      });
    }, {
      nowFn: () => now,
      hostnameFn: () => scenario === 'foreign' ? 'foreign.example' : 'local.example',
      pid: 52_001,
      tokenFactory: () => '33333333-4444-4555-8666-777777777777',
    });
    const transactions = join(dir, 'transactions');
    const orphanName = readdirSync(transactions).find(name => name.startsWith('.orphan-'));
    const orphan = join(transactions, orphanName);
    if (scenario === 'changed-marker') {
      const ownerPath = join(orphan, 'owner.json');
      const env = JSON.parse(readFileSync(ownerPath, 'utf8'));
      env.payload.lock_owner.token = '44444444-5555-4666-8777-888888888888';
      writeFileSync(ownerPath, JSON.stringify(env));
    } else if (scenario === 'changed-identity') {
      const displaced = `${orphan}.displaced`;
      renameSync(orphan, displaced);
      cpSync(displaced, orphan, { recursive: true });
      rmSync(displaced, { recursive: true });
    }
    now += 31_000;
    const second = fixture('op-2');
    assert.throws(() => withLock(root, runId, guard => {
      journal.preparePublicationStagesLocked(dir, guard, second.manifest, second.stages, {
        nowFn: () => now,
        hostnameFn: () => 'local.example',
        probePid: () => scenario === 'unknown' ? 'unknown' : scenario === 'alive' ? 'alive' : 'dead',
      });
    }, {
      nowFn: () => now,
      hostnameFn: () => 'local.example',
      pid: 52_002,
      tokenFactory: () => '55555555-6666-4777-8888-999999999999',
    }), /TRANSACTION_RECONCILIATION_REQUIRED/, scenario);
    assert.equal(existsSync(orphan), true, scenario);
  }
});

test('transaction journal remains artifact-only and independent from state/integrity writers', () => {
  const source = readFileSync(fileURLToPath(new URL('../scripts/lib/transaction-journal.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]\.\/(?:state|integrity)\.mjs['"]/);
  assert.doesNotMatch(source, /\b(?:appendEvent|appendAnchored|writeState)\s*\(/);
  assert.doesNotMatch(source, /join\([^\n]*(?:loop\.json|\.loop\.hash)/);
});

function anchoredSeed() {
  const root = mkdtempSync(join(tmpdir(), 'dl-tx-anchored-'));
  const { runId } = initRun(root, {
    runtime: 'claude',
    goal: 'anchored',
    now: new Date('2026-07-23T00:00:00.000Z'),
  });
  return { root, runId, dir: runDir(root, runId) };
}

function publishOnce(root, runId, operationId, { faultAt = () => {} } = {}) {
  return appendAnchored(
    root,
    runId,
    { type: 'anchored-test', data: { operation_id: operationId }, now: '2026-07-23T00:01:00.000Z' },
    (loop, _spent, tx) => {
      assert.equal(Object.isFrozen(tx), true);
      assert.equal(Object.isFrozen(tx.event), true);
      assert.equal(Object.isFrozen(tx.event_identity), true);
      loop.discovered_items.push(operationId);
    },
    undefined,
    {
      publication: {
        kind: 'workstream-boundary',
        operationId,
        artifacts: [
          { rel: 'artifacts/boundary.txt', bytes: Buffer.from(`artifact:${operationId}`) },
          { rel: 'artifacts/boundary.meta', bytes: Buffer.from(`meta:${operationId}`) },
        ],
        topology: { operation_id: operationId, phase: 'prepared' },
        faultAt,
      },
      floor: 1,
    },
  );
}

test('publication-mode appendAnchored replays artifacts, exact events, candidate loop, hash, and commit in order', () => {
  assert.equal(typeof stateApi.captureReconciledRunSnapshot, 'function');
  const { root, runId, dir } = anchoredSeed();
  const seen = [];
  assert.throws(
    () => publishOnce(root, runId, 'gateway-replay', {
      faultAt(label) {
        seen.push(label);
        if (label === 'state:loop:rename') throw new Error('simulated crash');
      },
    }),
    /TRANSACTION_PENDING/,
  );

  assert.notEqual(contentHash(readFileSync(join(dir, 'loop.json'))), readFileSync(join(dir, '.loop.hash'), 'utf8').trim());
  const snapshot = stateApi.captureReconciledRunSnapshot(root, runId);
  assert.deepEqual(snapshot.data.discovered_items, ['gateway-replay']);
  assert.equal(readFileSync(join(dir, 'artifacts', 'boundary.txt'), 'utf8'), 'artifact:gateway-replay');
  assert.equal(snapshot.logLines.filter(event => event.type === 'anchored-test').length, 1);
  assert.equal(snapshot.data.event_log_head.checksum, snapshot.logLines.at(-1).checksum);
  assert.equal(contentHash(snapshot.loopBytes), snapshot.hash);
  assert.deepEqual(snapshot.logLines.map(event => event.type), ['anchored-test', 'cost']);
  assert.equal(snapshot.data.budget.spent, 1);
  const prepared = JSON.parse(readFileSync(join(dir, 'transactions', 'gateway-replay', 'prepared.json'), 'utf8'));
  assert.deepEqual(prepared.payload.stages.map(stage => stage.role), [
    'artifact', 'artifact', 'event-line', 'event-line', 'candidate-loop', 'candidate-loop-hash',
  ]);
  assert.deepEqual(prepared.payload.manifest.eventLines.map(line => line.stage_index), [2, 3]);
  assert.deepEqual(prepared.payload.manifest.targets.map(target => target.stage_index), [0, 1]);
  assert.ok(seen.indexOf('artifact:0:target-done') < seen.indexOf('event:0:append'));
  assert.ok(seen.indexOf('event:0:append') < seen.indexOf('state:loop:rename'));
  assert.equal(existsSync(join(dir, 'transactions', 'gateway-replay', 'committed.json')), true);
  const exactBytes = {
    loop: readFileSync(join(dir, 'loop.json')),
    hash: readFileSync(join(dir, '.loop.hash')),
    log: readFileSync(join(dir, 'event-log.jsonl')),
  };
  assert.deepEqual(publishOnce(root, runId, 'gateway-replay'), {
    ok: true,
    event_identity: {
      seq: snapshot.logLines[0].seq,
      checksum: snapshot.logLines[0].checksum,
    },
    operation_id: 'gateway-replay',
  });
  assert.deepEqual(readFileSync(join(dir, 'loop.json')), exactBytes.loop);
  assert.deepEqual(readFileSync(join(dir, '.loop.hash')), exactBytes.hash);
  assert.deepEqual(readFileSync(join(dir, 'event-log.jsonl')), exactBytes.log);
});

test('reconciliation fail-stops unreachable state/hash, divergent log, and artifact predecessor conflicts', () => {
  for (const conflict of ['candidate-hash-first', 'divergent-log', 'artifact-third-state']) {
    const { root, runId, dir } = anchoredSeed();
    assert.throws(
      () => publishOnce(root, runId, `conflict-${conflict}`, {
        faultAt(label) {
          if (label === 'prepared:digest-verified') throw new Error('stop after prepare');
        },
      }),
      /TRANSACTION_PENDING/,
    );
    const prepared = JSON.parse(readFileSync(join(dir, 'transactions', `conflict-${conflict}`, 'prepared.json'), 'utf8'));
    const stages = prepared.payload.stages;
    const stagePath = role => join(
      dir,
      'transactions',
      `conflict-${conflict}`,
      'stages',
      `${String(stages.find(stage => stage.role === role).index).padStart(6, '0')}.bin`,
    );
    if (conflict === 'candidate-hash-first') {
      writeFileSync(join(dir, '.loop.hash'), readFileSync(stagePath('candidate-loop-hash')));
    } else if (conflict === 'divergent-log') {
      writeFileSync(join(dir, 'event-log.jsonl'), '{"seq":1,"divergent":true}\n');
    } else {
      mkdirSync(join(dir, 'artifacts'), { recursive: true });
      writeFileSync(join(dir, 'artifacts', 'boundary.txt'), 'unrelated-writer');
    }
    assert.throws(
      () => stateApi.captureReconciledRunSnapshot(root, runId),
      /TRANSACTION_RECONCILIATION_REQUIRED/,
      conflict,
    );
  }
});

test('ordinary append reconciles a journal prepared immediately before its business lock', () => {
  const { root, runId } = anchoredSeed();
  assert.throws(
    () => publishOnce(root, runId, 'prepared-before-append', {
      faultAt(label) {
        if (label === 'prepared:digest-verified') throw new Error('barrier');
      },
    }),
    /TRANSACTION_PENDING/,
  );

  appendAnchored(root, runId, { type: 'second-event', data: {} }, loop => {
    assert.deepEqual(loop.discovered_items, ['prepared-before-append']);
    loop.discovered_items.push('second');
  });

  const snapshot = stateApi.captureReconciledRunSnapshot(root, runId);
  assert.deepEqual(snapshot.data.discovered_items, ['prepared-before-append', 'second']);
  assert.deepEqual(snapshot.logLines.map(event => event.type), ['anchored-test', 'cost', 'second-event']);
});

test('every reachable publication crash barrier reopens to one exact committed candidate', () => {
  const barriers = [
    'artifact:0:rename',
    'artifact:0:target-done',
    'artifact:1:rename',
    'artifact:1:target-done',
    'event:0:append',
    'event:1:append',
    'state:loop:rename',
    'state:hash:rename',
    'committed:rename',
  ];
  for (const barrier of barriers) {
    const { root, runId, dir } = anchoredSeed();
    assert.throws(() => publishOnce(root, runId, `fault-${barrier.replaceAll(':', '-')}`, {
      faultAt(label) { if (label === barrier) throw new Error(`fault:${barrier}`); },
    }), /TRANSACTION_PENDING/, barrier);
    const snapshot = stateApi.captureReconciledRunSnapshot(root, runId);
    assert.equal(snapshot.logLines.filter(event => event.type === 'anchored-test').length, 1, barrier);
    assert.equal(snapshot.logLines.filter(event => event.type === 'cost').length, 1, barrier);
    assert.equal(contentHash(snapshot.loopBytes), snapshot.hash, barrier);
    assert.equal(readFileSync(join(dir, 'artifacts', 'boundary.txt'), 'utf8'), `artifact:fault-${barrier.replaceAll(':', '-')}`, barrier);
    assert.equal(readFileSync(join(dir, 'artifacts', 'boundary.meta'), 'utf8'), `meta:fault-${barrier.replaceAll(':', '-')}`, barrier);
  }
});

test('forced unlink replacement persists intent and replays predecessor, absent, and target-done transitions', () => {
  for (const barrier of ['artifact:0:replace-intent', 'artifact:0:unlink', 'artifact:0:target-done']) {
    const { root, runId, dir } = anchoredSeed();
    mkdirSync(join(dir, 'artifacts'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'boundary.txt'), 'predecessor');
    assert.throws(() => appendAnchored(
      root,
      runId,
      { type: 'replace-test', data: {}, now: '2026-07-23T00:01:00.000Z' },
      loop => { loop.discovered_items.push(barrier); },
      undefined,
      {
        publication: {
          kind: 'replacement', operationId: `replace-${barrier.replaceAll(':', '-')}`,
          artifacts: [{ rel: 'artifacts/boundary.txt', bytes: Buffer.from('candidate') }],
          topology: { barrier }, forceUnlinkReplacement: true,
          faultAt(label) { if (label === barrier) throw new Error(`fault:${barrier}`); },
        },
      },
    ), /TRANSACTION_PENDING/, barrier);
    const snapshot = stateApi.captureReconciledRunSnapshot(root, runId);
    assert.deepEqual(snapshot.data.discovered_items, [barrier]);
    assert.equal(readFileSync(join(dir, 'artifacts', 'boundary.txt'), 'utf8'), 'candidate');
  }
});

test('full-vector classification rejects later-ahead artifacts, event-ahead artifacts, and early commit without repair', () => {
  for (const vector of ['later-artifact-ahead', 'event-ahead', 'committed-early']) {
    const { root, runId, dir } = anchoredSeed();
    const operationId = `vector-${vector}`;
    assert.throws(() => publishOnce(root, runId, operationId, {
      faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('prepared'); },
    }), /TRANSACTION_PENDING/);
    const operationDir = join(dir, 'transactions', operationId);
    const prepared = JSON.parse(readFileSync(join(operationDir, 'prepared.json'), 'utf8'));
    const stagePath = index => join(operationDir, 'stages', `${String(index).padStart(6, '0')}.bin`);

    if (vector === 'later-artifact-ahead') {
      mkdirSync(join(dir, 'artifacts'), { recursive: true });
      writeFileSync(join(dir, 'artifacts', 'boundary.meta'), readFileSync(stagePath(1)));
    } else if (vector === 'event-ahead') {
      writeFileSync(join(dir, 'event-log.jsonl'), readFileSync(stagePath(2)));
    } else {
      writeFileSync(join(operationDir, 'committed.json'), JSON.stringify({
        kind: 'committed',
        operation_id: operationId,
        candidate_loop_hash: prepared.payload.manifest.candidateLoopHash,
      }));
    }

    assert.throws(
      () => stateApi.captureReconciledRunSnapshot(root, runId),
      /TRANSACTION_RECONCILIATION_REQUIRED/,
      vector,
    );
    assert.equal(existsSync(join(dir, 'artifacts', 'boundary.txt')), false, `${vector}: no earlier artifact repair`);
    assert.equal(existsSync(join(operationDir, 'markers')), false, `${vector}: no marker repair`);
  }
});

function seedPreparedPublication({ barrier = 'prepared:digest-verified', operationId = 'verified-read' } = {}) {
  const { root, runId, dir } = anchoredSeed();
  assert.throws(
    () => publishOnce(root, runId, operationId, {
      faultAt(label) { if (label === barrier) throw new Error(`read-fixture:${barrier}`); },
    }),
    /TRANSACTION_PENDING/,
  );
  return { root, runId, dir, operationId };
}

function seedOrphanedPublication({ barrier, operationId } = {}) {
  const fixtureState = anchoredSeed();
  assert.throws(
    () => publishOnce(fixtureState.root, fixtureState.runId, operationId, {
      faultAt(label) {
        if (label === 'prepared:before-write' || label === barrier || label === 'orphan:delete') {
          throw new Error(`orphan-fixture:${barrier}`);
        }
      },
    }),
    /TRANSACTION_NOT_PREPARED/,
  );
  const transactions = join(fixtureState.dir, 'transactions');
  const orphanName = readdirSync(transactions).find(name => name.startsWith('.orphan-'));
  assert.match(orphanName, new RegExp(`^\\.orphan-${operationId}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
  return { ...fixtureState, orphanName };
}

function durableRunBytes(root, runId) {
  const base = runDir(root, runId);
  const entries = [];
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      if (name === '.lock') continue;
      const path = join(current, name);
      const stat = lstatSync(path);
      const rel = path.slice(base.length + 1);
      if (stat.isDirectory()) visit(path);
      else entries.push([rel, Buffer.from(readFileSync(path))]);
    }
  };
  visit(base);
  return entries;
}

function exactCommittedMarker(dir, operationId) {
  const prepared = JSON.parse(readFileSync(join(dir, 'transactions', operationId, 'prepared.json'), 'utf8'));
  return JSON.stringify({
    kind: 'committed',
    operation_id: operationId,
    candidate_loop_hash: prepared.payload.manifest.candidateLoopHash,
  });
}

function durableRunVector(root, runId, expectedAbsent = []) {
  const base = runDir(root, runId);
  const entries = [[runId, '', 'directory', { identity: captureStableFileIdentity(base) }]];
  const present = new Set(['']);
  const visit = current => {
    for (const name of readdirSync(current).sort()) {
      if (name === '.lock') continue;
      const path = join(current, name);
      const rel = path.slice(base.length + 1);
      const stat = lstatSync(path);
      present.add(rel);
      if (stat.isDirectory()) {
        entries.push([runId, rel, 'directory', { identity: captureStableFileIdentity(path) }]);
        visit(path);
      } else {
        const before = captureStableFileIdentity(path);
        const bytes = Buffer.from(readFileSync(path));
        const after = captureStableFileIdentity(path);
        entries.push([runId, rel, 'file', {
          base64: bytes.toString('base64'),
          sha256: contentHash(bytes),
          size: bytes.length,
          identity_before: before,
          identity_after: after,
        }]);
      }
    }
  };
  visit(base);
  for (const rel of expectedAbsent) {
    if (!present.has(rel)) entries.push([runId, rel, 'ABSENT']);
  }
  return entries.sort((left, right) => JSON.stringify(left.slice(0, 3)).localeCompare(JSON.stringify(right.slice(0, 3))));
}

function durableRunSetVector(root, runIds, expectedAbsentByRun = {}) {
  return runIds.flatMap(runId => durableRunVector(root, runId, expectedAbsentByRun[runId] || []));
}

test('verified capture rejects an unowned valid-name transaction sibling as integrity-invalid', () => {
  const fixtureState = anchoredSeed();
  const operationId = 'verified-tree-complete';
  const published = publishOnce(fixtureState.root, fixtureState.runId, operationId);
  assert.equal(published.ok, true);
  assert.equal(published.operation_id, operationId);
  const sibling = join(fixtureState.dir, 'transactions', 'ignored-sibling');
  mkdirSync(join(sibling, 'unprepared'), { recursive: true });
  writeFileSync(join(sibling, 'unprepared', 'note.txt'), 'ignored transaction entry');
  const before = durableRunVector(fixtureState.root, fixtureState.runId, [
    'episodes', 'checkpoints', 'transactions/absent-sibling',
  ]);

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);

  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'transaction-tree',
  });
  assert.deepEqual(durableRunVector(fixtureState.root, fixtureState.runId, [
    'episodes', 'checkpoints', 'transactions/absent-sibling',
  ]), before);
});

test('verified capture classifies only production-shaped orphan crash residue as bounded reconciliation-required', () => {
  for (const barrier of ['prepared:before-write', 'orphan:delete']) {
    const operationId = `verified-orphan-${barrier.replaceAll(':', '-')}`;
    const fixtureState = seedOrphanedPublication({ barrier, operationId });
    const before = durableRunBytes(fixtureState.root, fixtureState.runId);

    const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);

    assert.deepEqual(result, {
      ok: false,
      kind: 'reconciliation-required',
      operation_id: operationId,
      phase: 'transaction-tree',
    }, barrier);
    assert.deepEqual(durableRunBytes(fixtureState.root, fixtureState.runId), before, barrier);
  }
});

test('verified capture classifies production bootstrap, empty, and partial-stage residues as bounded reconciliation-required', () => {
  const barriers = ['bootstrap:renamed', 'stage:0:write', 'stage:1:write'];
  for (const barrier of barriers) {
    const operationId = `verified-production-${barrier.replaceAll(':', '-')}`;
    const fixtureState = anchoredSeed();
    assert.throws(
      () => publishOnce(fixtureState.root, fixtureState.runId, operationId, {
        faultAt(label) {
          if (label === barrier || label === 'orphan:delete') throw new Error(`production-residue:${barrier}`);
        },
      }),
      /TRANSACTION_NOT_PREPARED/,
      barrier,
    );
    const before = durableRunBytes(fixtureState.root, fixtureState.runId);
    const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
    assert.deepEqual(result, {
      ok: false,
      kind: 'reconciliation-required',
      operation_id: operationId,
      phase: 'transaction-tree',
    }, barrier);
    assert.deepEqual(durableRunBytes(fixtureState.root, fixtureState.runId), before, barrier);
  }
});

test('verified capture lets malformed prepared sibling dominate a valid production orphan', () => {
  const fixtureState = seedOrphanedPublication({
    barrier: 'prepared:before-write',
    operationId: 'verified-valid-orphan',
  });
  const malformedOperation = 'verified-malformed-prepared';
  const malformedDir = join(fixtureState.dir, 'transactions', malformedOperation);
  mkdirSync(malformedDir, { recursive: true });
  writeFileSync(join(malformedDir, 'prepared.json'), '{malformed');

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);

  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: malformedOperation,
    phase: 'transaction-tree',
  });
});

test('verified capture rejects a valid orphan name without its owner and staging structure', () => {
  const fixtureState = anchoredSeed();
  const transactions = join(fixtureState.dir, 'transactions');
  const operationId = 'unowned-orphan';
  const orphan = join(transactions, `.orphan-${operationId}-00000000-0000-4000-8000-000000000000`);
  mkdirSync(orphan, { recursive: true });

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);

  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'transaction-tree',
  });
});

test('verified capture reports malformed-only transaction entries with a bounded null operation diagnostic', () => {
  const fixtureState = anchoredSeed();
  const transactions = join(fixtureState.dir, 'transactions');
  mkdirSync(transactions, { recursive: true });
  mkdirSync(join(transactions, '-malformed-name'));
  mkdirSync(join(transactions, 'contains space'));
  mkdirSync(join(transactions, 'x'.repeat(129)));

  assert.doesNotThrow(() => integrityApi.captureVerifiedRunSnapshot(
    fixtureState.root,
    fixtureState.runId,
  ));
  assert.deepEqual(integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId), {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'transaction-tree',
  });
});

test('verified capture reports a regular transactions entry as structured integrity-invalid', () => {
  const fixtureState = anchoredSeed();
  writeFileSync(join(fixtureState.dir, 'transactions'), 'not a directory');

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);

  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'transaction-tree',
  });
});

test('verified read paths expose no local mutation call graph and preserve recursive A/B vectors', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-tx-verified-vector-'));
  const now = new Date('2026-07-23T00:00:00.000Z');
  const runA = initRun(root, { runtime: 'claude', goal: 'verified vector A', now }).runId;
  const runB = initRun(root, { runtime: 'claude', goal: 'verified vector B', now: new Date(now.getTime() + 1) }).runId;
  assert.equal(publishOnce(root, runA, 'verified-vector-clean').ok, true);
  const transactionsB = join(runDir(root, runB), 'transactions');
  mkdirSync(transactionsB, { recursive: true });
  mkdirSync(join(transactionsB, 'malformed only'));
  const runIds = [runA, runB];
  const expectedAbsentByRun = {
    [runA]: ['episodes', 'checkpoints', 'transactions/absent-entry'],
    [runB]: ['episodes', 'checkpoints', 'transactions/absent-entry', 'transactions/malformed only/prepared.json'],
  };
  const before = durableRunSetVector(root, runIds, expectedAbsentByRun);

  const source = readFileSync(fileURLToPath(new URL('../scripts/lib/integrity.mjs', import.meta.url)), 'utf8');
  const readPathStart = source.indexOf('// VERIFIED_READ_CLOSURE_START');
  const readPathEnd = source.indexOf('// VERIFIED_READ_CLOSURE_END', readPathStart);
  assert.ok(readPathStart >= 0 && readPathEnd > readPathStart);
  const readPathSource = source.slice(readPathStart, readPathEnd);
  for (const forbiddenCall of [
    'reconcileAnchoredPublicationLocked', 'publishArtifactTargetsLocked',
    'markPublicationCommittedLocked', 'retireCommittedPublicationLocked',
    'writeState', 'durableAtomicWrite', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync',
  ]) {
    assert.doesNotMatch(readPathSource, new RegExp(`\\b${forbiddenCall}\\s*\\(`), forbiddenCall);
  }
  for (const name of [
    'validTransactionOwner', 'captureArtifactLocked', 'captureArtifactsLocked',
    'classifyPreparedRun', 'captureVerifiedDurableVectorLocked',
  ]) assert.ok(integrityApi.VERIFIED_READ_CLOSURE_NAMES.includes(name), name);

  const result = integrityApi.captureVerifiedRunSet(root, {
    runIds,
  });

  assert.deepEqual(Object.keys(result.runs), []);
  assert.equal(result.errors[runB].kind, 'integrity-invalid');
  assert.equal(result.errors[runB].operation_id, null);
  assert.deepEqual(durableRunSetVector(root, runIds, expectedAbsentByRun), before);
});

test('verified clean snapshot binds the complete frozen portable durable vector', () => {
  const fixtureState = anchoredSeed();
  assert.equal(publishOnce(fixtureState.root, fixtureState.runId, 'verified-complete-vector').ok, true);
  mkdirSync(join(fixtureState.dir, 'episodes'), { recursive: true });
  writeFileSync(join(fixtureState.dir, 'episodes', 'episode.json'), '{"episode":true}');
  mkdirSync(join(fixtureState.dir, 'checkpoints'), { recursive: true });
  writeFileSync(join(fixtureState.dir, 'checkpoints', 'checkpoint.json'), '{"checkpoint":true}');
  writeFileSync(join(fixtureState.dir, 'artifacts', 'unrequested.bin'), Buffer.from([0, 1, 2, 255]));
  const expected = durableRunVector(fixtureState.root, fixtureState.runId);

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);

  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.snapshot.vector), true);
  assert.deepEqual(result.snapshot.vector, expected);
  assert.equal(result.snapshot.vector.some(entry => entry[2] === 'directory'), true);
  assert.equal(result.snapshot.vector.some(entry => entry[2] === 'file'), true);
  assert.equal(result.snapshot.vector.every(entry => !entry[1].startsWith('/')), true);

  const clean = anchoredSeed();
  const cleanResult = integrityApi.captureVerifiedRunSnapshot(clean.root, clean.runId);
  assert.equal(cleanResult.snapshot.vector.some(entry => entry[2] === 'ABSENT'), true);
});

test('verified exact capture classifies prepared publication without replay', () => {
  const fixtureState = seedPreparedPublication({ operationId: 'verified-prepared' });
  const before = durableRunBytes(fixtureState.root, fixtureState.runId);
  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  assert.deepEqual(result, {
    ok: false,
    kind: 'reconciliation-required',
    operation_id: fixtureState.operationId,
    phase: 'prepared',
  });
  assert.deepEqual(durableRunBytes(fixtureState.root, fixtureState.runId), before);
});

test('verified exact capture classifies partial publication without replay', () => {
  const fixtureState = seedPreparedPublication({
    barrier: 'artifact:0:target-done',
    operationId: 'verified-partial',
  });
  const before = durableRunBytes(fixtureState.root, fixtureState.runId);
  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  assert.deepEqual(result, {
    ok: false,
    kind: 'reconciliation-required',
    operation_id: fixtureState.operationId,
    phase: 'partial',
  });
  assert.deepEqual(durableRunBytes(fixtureState.root, fixtureState.runId), before);
});

test('verified exact capture classifies premature committed without snapshot', () => {
  const fixtureState = seedPreparedPublication({ operationId: 'verified-premature' });
  writeFileSync(
    join(fixtureState.dir, 'transactions', fixtureState.operationId, 'committed.json'),
    exactCommittedMarker(fixtureState.dir, fixtureState.operationId),
  );
  const before = durableRunBytes(fixtureState.root, fixtureState.runId);
  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  assert.deepEqual(result, {
    ok: false,
    kind: 'reconciliation-required',
    operation_id: fixtureState.operationId,
    phase: 'premature-committed',
  });
  assert.deepEqual(durableRunBytes(fixtureState.root, fixtureState.runId), before);
});

test('verified exact capture classifies inconsistent committed without snapshot', () => {
  const fixtureState = seedPreparedPublication({ operationId: 'verified-inconsistent' });
  writeFileSync(
    join(fixtureState.dir, 'transactions', fixtureState.operationId, 'committed.json'),
    JSON.stringify({ kind: 'committed', operation_id: fixtureState.operationId, candidate_loop_hash: '0'.repeat(64) }),
  );
  const before = durableRunBytes(fixtureState.root, fixtureState.runId);
  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: fixtureState.operationId,
    phase: 'committed',
  });
  assert.deepEqual(durableRunBytes(fixtureState.root, fixtureState.runId), before);
});

test('verified exact capture preserves valid committed publication byte identity', () => {
  const fixtureState = anchoredSeed();
  const published = publishOnce(fixtureState.root, fixtureState.runId, 'verified-clean');
  assert.equal(published.ok, true);
  assert.equal(published.operation_id, 'verified-clean');
  const before = durableRunBytes(fixtureState.root, fixtureState.runId);
  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'clean-committed');
  assert.equal(result.operation_id, 'verified-clean');
  assert.ok(result.snapshot);
  assert.deepEqual(durableRunBytes(fixtureState.root, fixtureState.runId), before);
});

test('verified run set discards earlier clean snapshot after later error', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-tx-verified-set-'));
  const now = new Date('2026-07-23T00:00:00.000Z');
  const runA = initRun(root, { runtime: 'claude', goal: 'verified A', now }).runId;
  const runB = initRun(root, { runtime: 'claude', goal: 'verified B', now: new Date(now.getTime() + 1) }).runId;
  assert.throws(
    () => publishOnce(root, runB, 'verified-later-error', {
      faultAt(label) { if (label === 'prepared:digest-verified') throw new Error('read-fixture:later'); },
    }),
    /TRANSACTION_PENDING/,
  );
  const result = integrityApi.captureVerifiedRunSet(root, { runIds: [runA, runB] });
  assert.deepEqual(Object.keys(result.runs), []);
  assert.equal(result.errors[runB].kind, 'reconciliation-required');
});

test('bounded run enumeration rejects the 65th historical directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'dl-tx-bounded-enum-'));
  const runs = join(root, '.deep-loop', 'runs');
  mkdirSync(runs, { recursive: true });
  for (let index = 0; index < 65; index++) {
    mkdirSync(join(runs, `01J000000000000000000000${String(index).padStart(2, '0')}`));
  }

  const result = integrityApi.captureVerifiedRunSet(root, {
    nowFn: () => 100,
    deadlineMs: 500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'run-set-bound-exceeded');
  assert.equal(result.reason, 'run-set-bound-exceeded');
  assert.equal(result.max_run_ids, 64);
  assert.equal(result.observed_count, 65);
  assert.equal(result.total_is_lower_bound, true);
  assert.deepEqual(result.runIds, []);
  assert.deepEqual(Object.keys(result.runs), []);
  assert.match(JSON.stringify(result), /run-set-bound-exceeded/);
});

test('bounded run enumeration rejects lock retry after the absolute deadline', () => {
  const fixtureState = anchoredSeed();
  let clock = 100;
  const sleeps = [];
  withLock(fixtureState.root, fixtureState.runId, () => {
    const result = integrityApi.captureVerifiedRunSet(fixtureState.root, {
      runIds: [fixtureState.runId],
      deadlineMs: 5,
      nowFn: () => clock,
      lockOptions: {
        retries: 10,
        backoffMs: 50,
        nowFn: () => clock,
        sleepFn(ms) { sleeps.push(ms); clock += ms; },
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'run-set-bound-exceeded');
    assert.equal(result.phase, 'lock-retry');
    assert.deepEqual(Object.keys(result.runs), []);
    assert.deepEqual(sleeps, [5]);
  });
});

test('verified capture gives valid orphan residue precedence over a valid committed sibling', () => {
  const fixtureState = anchoredSeed();
  assert.equal(publishOnce(fixtureState.root, fixtureState.runId, 'verified-committed-sibling').ok, true);
  assert.throws(
    () => publishOnce(fixtureState.root, fixtureState.runId, 'verified-orphan-sibling', {
      faultAt(label) {
        if (label === 'prepared:before-write' || label === 'orphan:delete') {
          throw new Error('orphan-fixture:valid-committed-mix');
        }
      },
    }),
    /TRANSACTION_NOT_PREPARED/,
  );

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);

  assert.deepEqual(result, {
    ok: false,
    kind: 'reconciliation-required',
    operation_id: 'verified-orphan-sibling',
    phase: 'transaction-tree',
  });
});

test('verified vector uses frozen portable file metadata with before/read/after identity binding', () => {
  const fixtureState = anchoredSeed();
  assert.equal(publishOnce(fixtureState.root, fixtureState.runId, 'verified-portable-vector').ok, true);
  const rel = 'artifacts/vector-bytes.bin';
  const bytes = Buffer.from([0, 1, 2, 255]);
  writeFileSync(join(fixtureState.dir, rel), bytes);

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  const entry = result.snapshot.vector.find(item => item[1] === rel);

  assert.equal(result.ok, true);
  assert.equal(entry[2], 'file');
  assert.deepEqual(entry[3], {
    base64: bytes.toString('base64'),
    sha256: contentHash(bytes),
    size: bytes.length,
    identity_before: entry[3].identity_before,
    identity_after: entry[3].identity_after,
  });
  assert.equal(matchingStableFileIdentity(entry[3].identity_before, entry[3].identity_after), true);
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.isFrozen(entry[3]), true);
  assert.equal(Object.isFrozen(entry[3].identity_before), true);
  assert.equal(Object.isFrozen(entry[3].identity_after), true);
  assert.throws(() => { entry[3].base64 = 'mutated'; }, TypeError);
});

test('verified vector rejects entry, byte, depth, and deadline limit violations before traversal work', () => {
  const fixtureState = anchoredSeed();
  assert.equal(publishOnce(fixtureState.root, fixtureState.runId, 'verified-vector-limits').ok, true);
  mkdirSync(join(fixtureState.dir, 'deep', 'one', 'two', 'three'), { recursive: true });
  writeFileSync(join(fixtureState.dir, 'deep', 'one', 'two', 'three', 'payload.bin'), 'payload');

  for (const vectorOptions of [
    { maxEntries: 1_000, maxDepth: 2 },
    { maxEntries: 1, maxDepth: 100 },
    { maxEntries: 1_000, maxBytes: 1 },
    { maxEntries: 1_000, maxDepth: 100, nowFn: () => 100, deadlineAtMs: 100 },
  ]) {
    const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
      vectorOptions,
    });
    assert.deepEqual(result, {
      ok: false,
      kind: 'integrity-invalid',
      operation_id: null,
      phase: 'verified-vector',
    }, JSON.stringify(vectorOptions));
  }
});

test('verified exact and run-set classify symlink residue as structured integrity-invalid', t => {
  const fixtureState = anchoredSeed();
  assert.equal(publishOnce(fixtureState.root, fixtureState.runId, 'verified-symlink').ok, true);
  const symlink = join(fixtureState.dir, 'artifacts', 'symlink-entry');
  if (!createFileSymlinkOrSkip(t, join(fixtureState.dir, 'loop.json'), symlink)) return;

  const exact = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  assert.deepEqual(exact, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'verified-vector',
  });
  assert.doesNotThrow(() => integrityApi.captureVerifiedRunSet(fixtureState.root, {
    runIds: [fixtureState.runId],
  }));
  const set = integrityApi.captureVerifiedRunSet(fixtureState.root, {
    runIds: [fixtureState.runId],
  });
  assert.deepEqual(Object.keys(set.runs), []);
  assert.equal(set.errors[fixtureState.runId].kind, 'integrity-invalid');
});

test('verified exact and run-set classify readdir, read, identity drift, and special entries structurally', () => {
  for (const failure of ['readdir', 'read', 'identity', 'special']) {
    const fixtureState = anchoredSeed();
    assert.equal(publishOnce(fixtureState.root, fixtureState.runId, `verified-${failure}`).ok, true);
    const rel = 'artifacts/drift-fixture.bin';
    const target = join(fixtureState.dir, rel);
    writeFileSync(target, 'drift');
    const identityCalls = new Map();
    const vectorOptions = {
      opendirFn(path, ...args) {
        if (failure === 'readdir' && path === fixtureState.dir) throw new Error('fixture readdir drift');
        return opendirSync(path, ...args);
      },
      readFileFn(path, ...args) {
        if (failure === 'read' && path === target) throw new Error('fixture read drift');
        return readFileSync(path, ...args);
      },
      identityFn(path) {
        const identity = captureStableFileIdentity(path);
        const calls = (identityCalls.get(path) || 0) + 1;
        identityCalls.set(path, calls);
        if (failure === 'identity' && path === target && calls === 2) {
          return { ...identity, ino: (BigInt(identity.ino) + 1n).toString() };
        }
        return identity;
      },
    };
    if (failure === 'special') {
      vectorOptions.lstatFn = (path, ...args) => {
        const actual = lstatSync(path, ...args);
        if (path !== target) return actual;
        const fake = Object.create(actual);
        fake.isFile = () => false;
        fake.isDirectory = () => false;
        fake.isSymbolicLink = () => false;
        fake.isSocket = () => true;
        return fake;
      };
      delete vectorOptions.identityFn;
    }

    const exact = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
      vectorOptions,
    });
    identityCalls.clear();
    const set = integrityApi.captureVerifiedRunSet(fixtureState.root, {
      runIds: [fixtureState.runId],
      vectorOptionsByRun: { [fixtureState.runId]: vectorOptions },
    });
    assert.deepEqual(exact, {
      ok: false,
      kind: 'integrity-invalid',
      operation_id: null,
      phase: 'verified-vector',
    }, failure);
    assert.deepEqual(Object.keys(set.runs), [], failure);
    assert.equal(set.errors[fixtureState.runId].kind, 'integrity-invalid', failure);
  }
});

test('verified exact and run-set propagate one absolute deadline through lock and vector capture', () => {
  const fixtureState = anchoredSeed();
  const nowFn = () => 100;
  const expected = {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'verified-vector',
  };

  assert.deepEqual(integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
    deadlineBudgetMs: 0,
    nowFn,
  }), expected);
  const set = integrityApi.captureVerifiedRunSet(fixtureState.root, {
    runIds: [fixtureState.runId],
    deadlineBudgetMs: 0,
    nowFn,
  });
  assert.deepEqual(Object.keys(set.runs), []);
  assert.equal(set.errors[fixtureState.runId].kind, 'integrity-invalid');
});

test('verified read lock clamps contention sleep to the shared deadline', () => {
  const fixtureState = anchoredSeed();
  let clock = 100;
  const sleeps = [];

  withLock(fixtureState.root, fixtureState.runId, () => {
    const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
      deadlineBudgetMs: 5,
      nowFn: () => clock,
      lockOptions: {
        retries: 10,
        backoffMs: 50,
        nowFn: () => clock,
        sleepFn(ms) {
          sleeps.push(ms);
          clock += ms;
        },
      },
    });
    assert.deepEqual(result, {
      ok: false,
      kind: 'integrity-invalid',
      operation_id: null,
      phase: 'verified-vector',
    });
  });

  assert.deepEqual(sleeps, [5]);

  let calls = 0;
  const finalAttemptSleeps = [];
  withLock(fixtureState.root, fixtureState.runId, () => {
    const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
      deadlineBudgetMs: 5,
      nowFn: () => (++calls >= 4 ? 105 : 100),
      lockOptions: {
        retries: 1,
        backoffMs: 50,
        nowFn: () => (++calls >= 4 ? 105 : 100),
        sleepFn(ms) { finalAttemptSleeps.push(ms); },
      },
    });
    assert.deepEqual(result, {
      ok: false,
      kind: 'integrity-invalid',
      operation_id: null,
      phase: 'verified-vector',
    });
  });
  assert.deepEqual(finalAttemptSleeps, []);
});

test('verified vector bounds directory iteration before materializing an oversized directory', () => {
  const fixtureState = anchoredSeed();
  for (let index = 0; index < 32; index++) {
    writeFileSync(join(fixtureState.dir, `bounded-${String(index).padStart(2, '0')}`), 'x');
  }
  let rootReads = 0;
  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
    vectorOptions: {
      maxEntries: 1,
      opendirFn(path, ...args) {
        const directory = opendirSync(path, ...args);
        if (path !== fixtureState.dir) return directory;
        return {
          readSync() {
            rootReads += 1;
            return directory.readSync();
          },
          closeSync() { return directory.closeSync(); },
        };
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'verified-vector',
  });
  assert.ok(rootReads <= 2, `rootReads=${rootReads}`);
});

test('verified exact and run-set reject non-portable backslash path collisions', () => {
  if (process.platform === 'win32') return;
  const fixtureState = anchoredSeed();
  mkdirSync(join(fixtureState.dir, 'artifacts'), { recursive: true });
  writeFileSync(join(fixtureState.dir, 'artifacts', 'a\\b'), 'backslash');
  mkdirSync(join(fixtureState.dir, 'artifacts', 'a'), { recursive: true });
  writeFileSync(join(fixtureState.dir, 'artifacts', 'a', 'b'), 'slash');

  const exact = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId);
  assert.deepEqual(exact, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'verified-vector',
  });
  const set = integrityApi.captureVerifiedRunSet(fixtureState.root, { runIds: [fixtureState.runId] });
  assert.deepEqual(Object.keys(set.runs), []);
  assert.equal(set.errors[fixtureState.runId].kind, 'integrity-invalid');
});

test('verified vector binds the initial regular-file identity against a symlink swap', () => {
  if (process.platform === 'win32') return;
  const fixtureState = anchoredSeed();
  mkdirSync(join(fixtureState.dir, 'artifacts'), { recursive: true });
  const target = join(fixtureState.dir, 'artifacts', 'race.bin');
  const outside = join(fixtureState.root, 'outside.bin');
  writeFileSync(target, 'inside');
  writeFileSync(outside, 'escape');
  let swapped = false;

  const exact = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
    vectorOptions: {
      lstatFn(path, ...args) {
        const stat = lstatSync(path, ...args);
        if (path === target && !swapped) {
          swapped = true;
          rmSync(target);
          createFileSymlink(outside, target);
        }
        return stat;
      },
    },
  });

  assert.deepEqual(exact, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'verified-vector',
  });
  const set = integrityApi.captureVerifiedRunSet(fixtureState.root, { runIds: [fixtureState.runId] });
  assert.deepEqual(Object.keys(set.runs), []);
  assert.equal(set.errors[fixtureState.runId].kind, 'integrity-invalid');
});

test('verified transaction inspection binds the initial directory identity before enumeration', () => {
  if (process.platform === 'win32') return;
  const fixtureState = anchoredSeed();
  assert.throws(
    () => publishOnce(fixtureState.root, fixtureState.runId, 'directory-swap-orphan', {
      faultAt(label) {
        if (label === 'prepared:before-write' || label === 'orphan:delete') {
          throw new Error('directory-swap-fixture');
        }
      },
    }),
    /TRANSACTION_NOT_PREPARED/,
  );
  const transactions = join(fixtureState.dir, 'transactions');
  const outside = join(fixtureState.root, 'outside-transactions');
  renameSync(transactions, outside);
  mkdirSync(transactions);
  let swapped = false;

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
    vectorOptions: {
      identityFn(path) {
        if (path === transactions && !swapped) {
          swapped = true;
          rmSync(transactions, { recursive: true });
          createDirectoryJunction(outside, transactions);
        }
        return captureStableFileIdentity(path);
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, 'integrity-invalid');
  assert.equal(result.operation_id, null);
  // The injected directory swap is fail-closed before data consumption. Depending on
  // filesystem observation order, the immutable vector or immediate transaction-tree
  // classifier may be the first boundary to report the same identity drift.
  assert.ok(['verified-vector', 'transaction-tree'].includes(result.phase),
    `directory race must fail closed at an allowed boundary, got ${result.phase}`);
});

test('verified clean capture rejects transaction-tree drift between vector and classification', () => {
  const fixtureState = anchoredSeed();
  let created = false;

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
    vectorOptions: {
      lstatFn(path, ...args) {
        const stat = lstatSync(path, ...args);
        if (path === fixtureState.dir && !created) {
          created = true;
          mkdirSync(join(fixtureState.dir, 'transactions', 'malformed entry'), { recursive: true });
        }
        return stat;
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'transaction-tree',
  });
});

test('verified vector binds parent directory identity while reading children', () => {
  const fixtureState = anchoredSeed();
  const artifacts = join(fixtureState.dir, 'artifacts');
  const outside = join(fixtureState.root, 'original-artifacts');
  const payload = join(artifacts, 'payload.bin');
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(payload, 'inside');
  let swapped = false;

  const result = integrityApi.captureVerifiedRunSnapshot(fixtureState.root, fixtureState.runId, {
    vectorOptions: {
      lstatFn(path, ...args) {
        const stat = lstatSync(path, ...args);
        if (path === payload && !swapped) {
          swapped = true;
          renameSync(artifacts, outside);
          mkdirSync(artifacts);
          writeFileSync(payload, 'escape');
        }
        return stat;
      },
    },
  });

  assert.deepEqual(result, {
    ok: false,
    kind: 'integrity-invalid',
    operation_id: null,
    phase: 'verified-vector',
  });
});

test('verified-read closure explicitly includes every local transitive reader and no writer', () => {
  for (const name of [
    'readRawRun',
    'snapshotRaw',
    'readStableRegularFile',
    'readStableDirectoryNames',
    'validTransactionOwner',
    'captureArtifactLocked',
    'captureArtifactsLocked',
    'validatePreparedAuthority',
    'classifyPreparedRun',
    'committedMarkerInspection',
    'inspectAnchoredPublication',
    'captureVerifiedDurableVectorLocked',
    'inspectTransactionTreeLocked',
    'verifiedCaptureLocked',
  ]) assert.ok(integrityApi.VERIFIED_READ_CLOSURE_NAMES.includes(name), name);
});
