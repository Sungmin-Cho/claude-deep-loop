import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundedText } from '../lib/bounded-input.mjs';
import {
  captureCheckpointSet,
  inspectCompactCheckpoint,
  selectCheckpoint,
} from '../lib/checkpoint.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { findRoot } from '../lib/state.mjs';
import { sessionRuntime } from '../lib/runtime.mjs';

const CAP = 3072;

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

function strictHostSessionEvidence(input, runtime) {
  if (input.hook_event_name !== 'SessionStart') throw new Error('host-context-invalid');
  if (!Object.hasOwn(input, 'session_id')) return undefined;
  if (typeof input.session_id !== 'string'
    || input.session_id.length === 0
    || input.session_id.length > 1024
    || /[\0\r\n]/.test(input.session_id)) {
    throw new Error('host-evidence-invalid');
  }
  return {
    provider: runtime === 'claude' ? 'claude-code' : 'codex',
    id: input.session_id,
  };
}

function strictRestoreContext(runId, descriptor, { source }) {
  const runtime = descriptor.runtime;
  const command = runtime === 'claude'
    ? '/deep-loop-compact restore'
    : '$deep-loop:deep-loop-compact restore';
  const sourceLabel = source === 'compact' ? 'source=compact' : 'source-unverified';
  const evidenceLabel = descriptor.provider_evidence?.matched === true
    ? 'evidence-verified'
    : 'evidence-unverified';
  return clamp(
    `deep-loop compact restore ${sourceLabel} ${evidenceLabel}: invoke ${command} now in the same owner session. `
    + `checkpoint_rel=${descriptor.checkpoint_rel} owner=${descriptor.owner_run_id} `
    + `generation=${descriptor.generation} runtime=${runtime} `
    + `workstream=${descriptor.scope?.workstream_id ?? 'none'} run=${runId}.`,
  );
}

function strictUnavailableContext({ evidencePresent }) {
  return evidencePresent
    ? clamp(
      'deep-loop checkpoint-unavailable-with-trusted-evidence: preserve-pause and use host resume guidance. '
      + 'do not retry without trusted evidence. Run /deep-loop-status for bounded diagnostics.',
    )
    : clamp(
      'deep-loop checkpoint-unavailable evidence-unverified: run /deep-loop-status and preserve the current owner session.',
    );
}

// Read-only restore glue (spec §4.2). No branch mutates durable state.
export function runSessionStartRestore(input = {}, {
  root = findRoot(process.cwd()),
  now = Date.now(),
  readCheckpoint = (_path, bytes) => bytes.toString('utf8'),
} = {}) {
  if (Object.hasOwn(input, 'source') && input.source !== 'compact') {
    return { ok: true, branch: 'source-other', additionalContext: null };
  }
  const runId = currentRunId(root);
  if (!runId) return { ok: true, branch: 'no-run', additionalContext: null };

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
  if (loop.autonomy?.continuation_policy === 'workstream-session') {
    let runtime;
    let hostSessionEvidence;
    try {
      runtime = sessionRuntime(loop);
      hostSessionEvidence = strictHostSessionEvidence(input, runtime);
    } catch {
      return { ok: false, branch: 'evidence-invalid', additionalContext: null };
    }
    const inspected = inspectCompactCheckpoint(root, runId, {
      hostSessionEvidence,
      now,
    });
    if (!inspected.ok) {
      return {
        ok: true,
        branch: hostSessionEvidence
          ? 'checkpoint-unavailable-with-trusted-evidence'
          : 'no-checkpoint',
        additionalContext: strictUnavailableContext({
          evidencePresent: hostSessionEvidence !== undefined,
        }),
      };
    }
    return {
      ok: true,
      branch: input.source === 'compact' ? 'resume' : 'resume-source-unverified',
      additionalContext: strictRestoreContext(runId, inspected, {
        source: input.source,
      }),
    };
  }

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
    const result = runSessionStartRestore(input ?? {}, { root: findRoot(cwd) });
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
