import { readBoundedText } from '../lib/bounded-input.mjs';
import { relative } from 'node:path';
import {
  captureVerifiedCheckpointSet,
  selectCheckpoint,
} from '../lib/checkpoint.mjs';
import { detectMain } from '../lib/detect-main.mjs';
import { findRoot } from '../lib/state.mjs';
import { runDir } from '../lib/state.mjs';
import { formatBoundedRoutingDiagnostic, resolveRunContext } from '../lib/run-context.mjs';
import { sessionRuntime } from '../lib/runtime.mjs';

const CAP = 3072;

function clamp(value) {
  if (Buffer.byteLength(value, 'utf8') <= CAP) return value;
  const bytes = Buffer.from(value, 'utf8').subarray(0, CAP - 3);
  let cut = bytes.toString('utf8');
  if (cut.endsWith('\uFFFD')) cut = cut.slice(0, -1);
  return `${cut}...`;
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

function strictRestoreContext(runId, descriptor, { source, selectionSource }) {
  const runtime = descriptor.runtime;
  const command = runtime === 'claude'
    ? '/deep-loop-compact restore'
    : '$deep-loop:deep-loop-compact restore';
  const sourceLabel = source === 'compact' ? 'source=compact' : 'source-unverified';
  const evidenceLabel = descriptor.provider_evidence?.matched === true
    ? 'evidence-verified'
    : 'evidence-unverified';
  return clamp(
    `deep-loop compact restore ${sourceLabel} selection=${selectionSource} ${evidenceLabel}: invoke ${command} now in the same owner session. `
    + `checkpoint_rel=${descriptor.checkpoint_rel} owner=${descriptor.owner_run_id} `
    + `generation=${descriptor.generation} runtime=${runtime} `
    + `workstream=${descriptor.scope?.workstream_id ?? 'none'} run=${runId}.`,
  );
}

function strictUnavailableContext({ evidencePresent, runtime }) {
  const restoreCommand = runtime === 'claude'
    ? '/deep-loop-compact restore'
    : '$deep-loop:deep-loop-compact restore';
  const statusCommand = runtime === 'claude'
    ? '/deep-loop-status'
    : '$deep-loop:deep-loop-status';
  return evidencePresent
    ? clamp(
      `deep-loop checkpoint-unavailable-with-trusted-evidence: invoke ${restoreCommand} now for `
      + 'preserve-pause and host resume guidance; do not retry without trusted evidence. '
      + `Run ${statusCommand} for bounded diagnostics.`,
    )
    : clamp(
      `deep-loop checkpoint-unavailable evidence-unverified: invoke ${restoreCommand} now for the `
      + `state-derived fallback; run ${statusCommand} for bounded diagnostics and preserve the current owner session.`,
    );
}

function routingDiagnostic(selection) {
  if (!selection || selection.kind === 'none') return null;
  return formatBoundedRoutingDiagnostic({
    kind: selection.kind,
    reason: selection.reason,
    ...(selection.errors && typeof selection.errors === 'object' && !Array.isArray(selection.errors)
      ? { errors: selection.errors } : {}),
    ...(selection.candidates ? { candidates: selection.candidates } : {}),
    ...(selection.total !== undefined ? { total: selection.total } : {}),
    ...(selection.max_run_ids !== undefined ? { max_run_ids: selection.max_run_ids } : {}),
    ...(selection.deadline_ms !== undefined ? { deadline_ms: selection.deadline_ms } : {}),
    ...(selection.observed_count !== undefined ? { observed_count: selection.observed_count } : {}),
    ...(selection.total_is_lower_bound !== undefined
      ? { total_is_lower_bound: selection.total_is_lower_bound } : {}),
  });
}

function strictDescriptorFromVerifiedBytes(root, runId, checkpointSet) {
  const candidates = [];
  for (const checkpoint of checkpointSet.checkpoints || []) {
    try {
      const envelope = JSON.parse(checkpoint.bytes.toString('utf8'));
      const context = envelope?.payload?.context;
      if (!context || typeof envelope?.envelope?.generated_at !== 'string') continue;
      const relCandidate = relative(runDir(root, runId), checkpoint.path);
      const rel = relCandidate && !relCandidate.startsWith('..')
        ? relCandidate.split('\\').join('/')
        : null;
      if (!rel) continue;
      candidates.push({ checkpoint, envelope, context, rel });
    } catch { /* captureVerifiedCheckpointSet already rejected malformed bytes */ }
  }
  candidates.sort((left, right) => (
    right.envelope.envelope.generated_at.localeCompare(left.envelope.envelope.generated_at)
      || right.rel.localeCompare(left.rel)
  ));
  const selected = candidates[0];
  if (!selected) return null;
  const { context } = selected;
  return {
    ok: true,
    checkpoint_rel: selected.rel,
    owner_run_id: context.owner_run_id,
    generation: context.generation,
    runtime: context.runtime,
    scope: context.scope,
    workstream: context.workstream,
    current_episode: context.current_episode,
    next_action: context.next_action,
    provider_evidence: {
      present: context.provider_evidence !== null,
      matched: context.provider_evidence !== null,
    },
  };
}

// Read-only restore glue (spec §4.2). No branch mutates durable state.
export function runSessionStartRestore(input = {}, {
  root = findRoot(process.cwd()),
  now = Date.now(),
  readCheckpoint = (_path, bytes) => bytes.toString('utf8'),
  resolveContextFn = resolveRunContext,
  captureVerifiedCheckpointSetFn = captureVerifiedCheckpointSet,
} = {}) {
  if (Object.hasOwn(input, 'source') && input.source !== 'compact') {
    return { ok: true, branch: 'source-other', additionalContext: null };
  }
  const selection = resolveContextFn({
    root,
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    purpose: 'hook-restore',
    nowFn: () => (now instanceof Date ? now.getTime() : now),
  });
  if (!selection?.ok || selection.kind !== 'selected') {
    const branch = selection?.reason === 'no-runs' ? 'no-run'
      : selection?.reason === 'run-set-integrity' ? 'unreadable'
        : selection?.reason || selection?.kind || 'unreadable';
    const diagnostic = routingDiagnostic(selection);
    return {
      ok: true,
      branch,
      ...(diagnostic ? { diagnostic } : {}),
      additionalContext: null,
    };
  }
  const runId = selection.runId;
  const loop = selection.snapshot.data;
  const hash = selection.snapshot.hash;

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
    const checkpointSet = captureVerifiedCheckpointSetFn({
      root,
      runId,
      snapshot: selection.snapshot,
      hostSessionEvidence,
      now,
    });
    if (!checkpointSet?.ok) {
      return {
        ok: true,
        branch: checkpointSet?.kind || 'checkpoint-unavailable',
        diagnostic: JSON.stringify({
          kind: checkpointSet?.kind || 'checkpoint-unavailable',
          phase: checkpointSet?.phase || 'checkpoint',
        }).slice(0, 220),
        additionalContext: null,
      };
    }
    const inspected = strictDescriptorFromVerifiedBytes(root, runId, checkpointSet);
    if (!inspected) return { ok: true, branch: 'no-checkpoint', additionalContext: null };
    return {
      ok: true,
      branch: input.source === 'compact' ? 'resume' : 'resume-source-unverified',
      additionalContext: strictRestoreContext(runId, inspected, {
        source: input.source,
        selectionSource: selection.source,
      }),
    };
  }

  const advisory = `deep-loop lease owner=${lease.owner_run_id} gen=${lease.generation} selection=${selection.source}. 이 세션이 해당 run의 owner가 아니면 mutation을 시도하지 말 것.`;

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

  const checkpointSet = captureVerifiedCheckpointSetFn({
    root,
    runId,
    snapshot: selection.snapshot,
    now,
  });
  if (!checkpointSet?.ok) return {
    ok: true,
    branch: checkpointSet?.kind || 'checkpoint-unavailable',
    diagnostic: JSON.stringify({
      kind: checkpointSet?.kind || 'checkpoint-unavailable',
      phase: checkpointSet?.phase || 'checkpoint',
    }).slice(0, 220),
    additionalContext: null,
  };
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
    // The checkpoint bytes are already part of the verified immutable vector;
    // never reopen the live path after capture.
    envelope = JSON.parse(checkpoint.bytes.toString('utf8'));
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
    if (result.diagnostic) process.stderr.write(`deep-loop: sessionstart ${result.diagnostic.slice(0, 220)}\n`);
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
