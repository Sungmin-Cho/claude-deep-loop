import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { readBoundedText } from '../lib/bounded-input.mjs';
import {
  captureCheckpointSet,
  inspectCompactForSessionStart,
  selectCheckpoint,
} from '../lib/checkpoint.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { findRoot } from '../lib/state.mjs';

const CAP = 3072;
export const MAX_COMPACT_CAPSULE_WIRE_BYTES = 2048;

function clamp(value) {
  if (Buffer.byteLength(value, 'utf8') <= CAP) return value;
  const bytes = Buffer.from(value, 'utf8').subarray(0, CAP - 3);
  let cut = bytes.toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return `${cut}...`;
}

function currentRunId(root) {
  const path = join(root, '.deep-loop', 'current');
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : null;
}

function strictHostSessionIdentity(input) {
  if (input.hook_event_name !== 'SessionStart') throw new Error('host-context-invalid');
  if (!Object.hasOwn(input, 'session_id')) return undefined;
  if (typeof input.session_id !== 'string'
    || input.session_id.length === 0
    || input.session_id.length > 1024
    || /[\0\r\n]/.test(input.session_id)) {
    throw new Error('host-evidence-invalid');
  }
  return input.session_id;
}

function compactCapsule(runId, descriptor) {
  const wire = {
    marker: 'deep-loop-compact-capsule-v1',
    version: 1,
    injected_by: 'sessionstart',
    capsule: {
      kind: 'deep-loop-compact-capsule',
      phase: descriptor.phase,
      run_id: runId,
      checkpoint_key: descriptor.checkpoint_key,
      context_sha256: descriptor.context_sha256,
      pre_restore_loop_hash: descriptor.pre_restore_loop_hash,
      owner_run_id: descriptor.owner_run_id,
      generation: descriptor.generation,
      runtime: descriptor.runtime,
      workstream_id: descriptor.workstream_id,
      episode_id: descriptor.episode_id,
      provider_evidence: structuredClone(descriptor.provider_evidence),
      admission: structuredClone(descriptor.admission),
      restore_event: structuredClone(descriptor.restore_event),
      restore_command: descriptor.next_command,
    },
  };
  let serialized;
  try { serialized = JSON.stringify(wire); } catch { return null; }
  return Buffer.byteLength(serialized, 'utf8') <= MAX_COMPACT_CAPSULE_WIRE_BYTES
    ? serialized
    : null;
}

function strictRejectedContext(runtime) {
  const restoreCommand = runtime === 'claude'
    ? '/deep-loop-compact restore'
    : '$deep-loop:deep-loop-compact restore';
  const statusCommand = runtime === 'claude'
    ? '/deep-loop-status'
    : '$deep-loop:deep-loop-status';
  return clamp(
    'deep-loop-compact-preserve-pause-only '
    + 'checkpoint-unavailable-with-trusted-evidence provider-evidence-mismatch: '
    + `invoke ${restoreCommand} for preserve-pause only; run ${statusCommand} for host-resume guidance.`,
  );
}

function strictMissingContext(runtime) {
  const statusCommand = runtime === 'claude'
    ? '/deep-loop-status'
    : '$deep-loop:deep-loop-status';
  return clamp(`deep-loop checkpoint-unavailable: run ${statusCommand} for bounded diagnostics; no restore was authorized.`);
}

export function resolveSessionStartProjectRoot(cwd, { expectedRoot } = {}) {
  try {
    if (typeof cwd !== 'string' || cwd.length === 0 || resolve(cwd) !== cwd) return null;
    const canonicalCwd = realpathSync(cwd);
    if (canonicalCwd !== cwd) return null;
    const found = findRoot(canonicalCwd);
    const base = realpathSync(found);
    if (found !== base || (expectedRoot !== undefined && realpathSync(expectedRoot) !== base)) return null;
    if (!existsSync(join(base, '.deep-loop', 'current'))) return null;
    if (canonicalCwd === base) return base;
    const rel = relative(base, canonicalCwd);
    if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return null;
    const parts = rel.split(sep);
    const offset = parts[0] === '.worktrees'
      ? 1
      : parts[0] === '.claude' && parts[1] === 'worktrees'
        ? 2
        : -1;
    if (offset < 0 || typeof parts[offset] !== 'string' || parts[offset].length === 0) return null;
    const worktreeRoot = join(base, ...parts.slice(0, offset + 1));
    if (realpathSync(worktreeRoot) !== worktreeRoot) return null;
    if (existsSync(join(worktreeRoot, '.deep-loop', 'current'))) return null;
    let current = canonicalCwd;
    while (current !== worktreeRoot) {
      if (existsSync(join(current, '.deep-loop', 'current')) || existsSync(join(current, '.git'))) {
        return null;
      }
      const parent = join(current, '..');
      const resolvedParent = resolve(parent);
      if (resolvedParent === current) return null;
      current = resolvedParent;
    }
    return base;
  } catch {
    return null;
  }
}

// Read-only restore glue (spec §4.2). No branch mutates durable state.
export function runSessionStartRestore(input = {}, {
  root = findRoot(process.cwd()),
  now = Date.now(),
  readCheckpoint = (_path, bytes) => bytes.toString('utf8'),
  inspectCompact = inspectCompactForSessionStart,
  runtimeHint = 'claude',
} = {}) {
  if (input.source !== 'compact') {
    return { ok: true, branch: 'source-other', additionalContext: null };
  }
  const runId = currentRunId(root);
  if (!runId) return { ok: true, branch: 'no-run', additionalContext: null };

  let hostSessionIdentity;
  try { hostSessionIdentity = strictHostSessionIdentity(input); } catch {
    return { ok: false, branch: 'evidence-invalid', additionalContext: null };
  }

  let inspected;
  try {
    inspected = inspectCompact(root, runId, {
      hostSessionEvidence: hostSessionIdentity === undefined ? undefined : { id: hostSessionIdentity },
      now,
    });
  } catch {
    return { ok: true, branch: 'unreadable', additionalContext: null };
  }

  if (inspected !== null) {
    if (!inspected.ok) {
      if (inspected.reason === 'trusted-evidence-rejected') {
        return {
          ok: true,
          branch: 'checkpoint-unavailable-with-trusted-evidence',
          additionalContext: strictRejectedContext(runtimeHint),
        };
      }
      if (['checkpoint-not-found', 'checkpoint-ineligible'].includes(inspected.reason)) {
        return {
          ok: true,
          branch: 'no-checkpoint',
          additionalContext: strictMissingContext(runtimeHint),
        };
      }
      return {
        ok: true,
        branch: inspected.reason === 'run-not-resumable'
          ? 'terminal-or-paused'
          : inspected.reason,
        additionalContext: null,
      };
    }
    if (inspected.phase === 'restored') {
      return { ok: true, branch: 'restored', additionalContext: null };
    }
    const additionalContext = compactCapsule(runId, inspected);
    return additionalContext === null
      ? { ok: true, branch: 'capsule-unavailable', additionalContext: null }
      : { ok: true, branch: inspected.phase, additionalContext };
  }

  let loop;
  let hash;
  let checkpointSet;
  try {
    checkpointSet = captureCheckpointSet(root, runId);
    ({ data: loop, hash } = checkpointSet.snapshot);
  } catch {
    return { ok: true, branch: 'unreadable', additionalContext: null };
  }

  if (['completed', 'stopped', 'paused'].includes(loop.status)) {
    return { ok: true, branch: 'terminal-or-paused', additionalContext: null };
  }

  const lease = loop.session_chain?.lease || {};

  const advisory = `deep-loop lease owner=${lease.owner_run_id} gen=${lease.generation}. 이 세션이 해당 run의 owner가 아니면 mutation을 시도하지 말 것.`;

  if (lease.handoff_phase === 'reserved' && lease.state === 'active') {
    return {
      ok: true,
      branch: 'reserved-recovery',
      additionalContext: clamp(
        `${advisory} deep-loop: handoff 예약 잔재가 남아 있다(미완결 emission). /deep-loop-continue 실행 시 reserved-finalization이 완결하거나 /deep-loop-status 로 확인하라.`,
      ),
    };
  }

  const emitted = ['emitted', 'spawned'].includes(lease.handoff_phase)
    && lease.state === 'releasing'
    && Boolean(lease.handoff_child_run_id);
  if (emitted) {
    return {
      ok: true,
      branch: 'rotation',
      additionalContext: clamp(
        `${advisory} deep-loop: handoff가 emit되어 reserved child(${lease.handoff_child_run_id})가 있다. 이 세션이 아니라 **새 세션**에서 resume하라 — .deep-loop/runs/${runId}/handoffs/ 의 next-session 아티팩트와 launch-command 참조.`,
      ),
    };
  }

  if (loop.autonomy?.continuation_policy === 'rotate-per-unit') {
    return {
      ok: true,
      branch: 'rotate-retry',
      additionalContext: clamp(
        `${advisory} deep-loop: compaction이 발생했으나 handoff 미-emit 상태다(PreCompact 실패 가능). 다음 /deep-loop-continue tick이 fenced handoff emission을 수행한다.`,
      ),
    };
  }

  const checkpoint = selectCheckpoint(checkpointSet, {
    owner: lease.owner_run_id,
    generation: lease.generation,
    loopHash: hash,
  });
  if (!checkpoint) {
    return {
      ok: true,
      branch: 'no-checkpoint',
      additionalContext: clamp(
        `${advisory} deep-loop: 일치하는 compact checkpoint 없음 — /deep-loop-status 로 상태 확인.`,
      ),
    };
  }

  let envelope;
  try {
    envelope = JSON.parse(readCheckpoint(checkpoint.path, checkpoint.bytes));
  } catch {
    return {
      ok: true,
      branch: 'no-checkpoint',
      additionalContext: clamp(
        `${advisory} deep-loop: compact checkpoint를 읽을 수 없음 — /deep-loop-status 로 상태 확인.`,
      ),
    };
  }
  const payload = envelope.payload || {};
  return {
    ok: true,
    branch: 'resume',
    additionalContext: clamp(
      `${advisory} deep-loop continuation (compact-in-place): run=${runId} ws=${payload.current_episode_detail?.workstream_id ?? 'none'} episode=${payload.current_episode ?? 'none'}`
      + `${payload.current_episode_detail ? `(${payload.current_episode_detail.role}/${payload.current_episode_detail.status}@${payload.current_episode_detail.point})` : ''} `
      + `active_ws=${(payload.active_workstreams || []).join(',') || 'none'} `
      + `next=${payload.next_action_hint?.type ?? 'unknown'}(${payload.next_action_hint?.next_command ?? '/deep-loop-continue'}) `
      + `artifacts=${(payload.artifacts || []).join(',') || 'none'}. 완료된 작업을 반복하지 말 것. 상세: ${checkpoint.path}.`,
    ),
  };
}

export async function main() {
  try {
    const raw = await readBoundedText(process.stdin);
    const input = raw.length === 0 ? {} : JSON.parse(raw);
    const cwd = input && typeof input.cwd === 'string' && input.cwd.length > 0
      ? input.cwd
      : process.cwd();
    const root = resolveSessionStartProjectRoot(cwd);
    if (root === null) return;
    const result = runSessionStartRestore(input ?? {}, {
      root,
      runtimeHint: process.env.CLAUDE_PLUGIN_ROOT ? 'claude' : 'codex',
    });
    if (!result.ok) throw new Error('restore-context-invalid');
    if (result.additionalContext) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: result.additionalContext,
        },
      })}\n`);
    }
  } catch {
    process.stderr.write('deep-loop: sessionstart restore hook failed\n');
  }
}

const { isMain, diagnostic } = detectMain(import.meta.url, process.argv[1]);
if (diagnostic) process.stderr.write(`${diagnostic}\n`);
else if (isMain) await main();
