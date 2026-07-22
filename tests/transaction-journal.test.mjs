import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
import { captureStableFileIdentity } from '../scripts/lib/fs-safe.mjs';
import { runDir, withLock } from '../scripts/lib/state.mjs';
import { createDirectoryJunction, createFileSymlinkOrSkip } from './helpers/fs-fixtures.mjs';

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
