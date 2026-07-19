import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';
import { runDir } from './state.mjs';
import { requirePrecompactMutationIdentity, withVerifiedMutationLock } from './integrity.mjs';
import { atomicWrite, contentHash, ulid, wrap } from './envelope.mjs';
import { reserveHandoff, rollbackReservedHandoff } from './lease.mjs';
import { APP_PREPARE_TIMEOUT_MS,
  deriveAppEmitAuthority } from './app-task-continuation.mjs';
import { validate } from './schema.mjs';
import { defaultDesktopProbe } from './desktop-target.mjs';
import { sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { buildRuntimeResumeDescriptor } from './runtime-descriptor.mjs';
import { validateRuntimeProfile } from './session-profile.mjs';
import { isHeadlessInvocation } from './respawn.mjs';

export { buildLaunchCommand } from './runtime-descriptor.mjs';

const DEFAULT_DEEP_LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLICY_ENV_KEYS = Object.freeze([
  'DEEP_LOOP_UNATTENDED', 'DEEP_LOOP_HEADLESS', 'CLAUDE_CODE_ENTRYPOINT',
]);
const RESUME_POLICIES = new Set(['visible', 'headless', 'human', 'app']);

function snapshotHandoffPolicyInputs(resumePolicy, headless, env) {
  if (resumePolicy !== undefined && resumePolicy !== null
      && !RESUME_POLICIES.has(resumePolicy)) {
    throw new Error('HANDOFF_POLICY_INPUT_INVALID');
  }
  if (env === null || typeof env !== 'object' || Array.isArray(env)
      || utilTypes.isProxy(env)) throw new Error('HANDOFF_POLICY_INPUT_INVALID');
  const captured = {};
  for (const key of POLICY_ENV_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (descriptor === undefined) continue;
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('HANDOFF_POLICY_INPUT_INVALID');
    const value = descriptor.value;
    if (value !== undefined && typeof value !== 'string' && typeof value !== 'boolean') {
      throw new Error('HANDOFF_POLICY_INPUT_INVALID');
    }
    captured[key] = value;
  }
  return Object.freeze({
    resumePolicyPresent: resumePolicy !== undefined,
    resumePolicy: resumePolicy ?? null,
    headless: Boolean(headless),
    envHeadlessClaude: isHeadlessInvocation(captured, 'claude'),
    envHeadlessCodex: isHeadlessInvocation(captured, 'codex'),
  });
}

function runtimePolicyIdentity(snapshot, runtime) {
  return Object.freeze({ resumePolicyPresent: snapshot.resumePolicyPresent,
    resumePolicy: snapshot.resumePolicy, headless: snapshot.headless,
    envHeadless: runtime === 'codex'
      ? snapshot.envHeadlessCodex : snapshot.envHeadlessClaude });
}

function policyBoundTrigger(trigger, identity) {
  const baseline = !identity.resumePolicyPresent && identity.resumePolicy === null
    && !identity.headless && !identity.envHeadless;
  if (baseline) return trigger;
  const digest = contentHash(JSON.stringify(identity)).slice(0, 16);
  return `${String(trigger)}\0handoff-policy:${digest}`;
}

function descriptorLauncherIdentity(loop, runtime, platform) {
  const sessionIdentity = loop.session_spawn?.launcher_identity ?? null;
  if (runtime !== 'claude' || platform !== 'win32' || loop.autonomy?.spawn_style !== 'desktop') {
    return sessionIdentity;
  }
  const approvals = loop.autonomy?.launcher_executable_approvals;
  // A present durable map is authoritative. Legacy states that truly predate the
  // map retain their prior session-identity artifact behavior; normal desktop
  // opt-in has launcher:none and consumes the durable PowerShell approval.
  if (approvals === undefined) return sessionIdentity;
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) return null;
  const powerShell = approvals.powershell;
  return powerShell && typeof powerShell === 'object' && !Array.isArray(powerShell)
    ? powerShell
    : null;
}

function tsName(now) { return new Date(now).toISOString().replace(/[:.]/g, '-'); }

function handoffMarkdown(loop, childRunId, reason, descriptor) {
  const wsLines = (loop.workstreams || []).map(w => `- ${w.id} [${w.status}] branch=${w.branch} worktree=${w.worktree}`).join('\n') || '- (none)';
  const doneEp = (loop.episodes || []).filter(e => ['done', 'approved'].includes(e.status)).map(e => e.id).join(', ') || '(none)';
  const abandonedEp = (loop.episodes || []).filter(e => e.status === 'abandoned').map(e => e.id).join(', ') || '(none)';
  return [
    `# Handoff — next session (${childRunId})`, '',
    `> source of truth: 이 파일 + loop.json. **이전 대화 컨텍스트를 가정하지 말라.**`, '',
    `## Goal`, '', loop.goal, '',
    `## Routing`, `- recipe: ${loop.recipe?.id}`, `- protocol: ${loop.routing?.protocol}`, `- reason for handoff: ${reason}`, '',
    `## Session continuity`,
    `- model: ${loop.autonomy?.session_model || '(미지정 — CLI 기본값)'}`,
    `- effort: ${loop.autonomy?.session_effort || '(미지정 — CLI 기본값)'}`,
    descriptor.runtime === 'claude'
      ? `> desktop transport는 URL로 model/effort를 전달할 수 없으니, desktop 재개 시 이 값으로 세션을 맞추세요.`
      : `> Codex model과 low/medium/high/xhigh effort 매핑은 격리 descriptor에 고정되며 max effort는 fail-closed다. 실행은 별도 executable 승인·preflight 전까지 비활성이다.`, '',
    `## Episodes`, `- completed: ${doneEp}`, `- abandoned: ${abandonedEp}`, `- current: ${loop.current_episode || '(none)'}`, '',
    `## Workstreams`, wsLines, '',
    `## Triage`, `- actionable: ${(loop.triage?.actionable || []).length}, needs_human: ${(loop.triage?.needs_human || []).length}`, '',
    `## Git`, `- branch: ${loop.project?.branch}  head: ${loop.project?.head}  dirty: ${loop.project?.dirty}`, '',
    `## Resume target`,
    `- runtime: ${descriptor.runtime}`,
    `- canonical project root: ${descriptor.projectRoot}`,
    `- run id: ${descriptor.runId}`,
    `- usage output: ${descriptor.usageOutputKind}`, '',
    `## Human verification checklist`, '- [ ] 미검토 episode/diff 확인', '- [ ] 진행 중 workstream worktree 무결성 확인', '',
    `## Next prompt (정확히)`, '', '```', descriptor.resumeInvocation, '```', '',
  ].join('\n');
}

export function emitHandoff(root, runId, {
  reason = 'milestone', trigger = 'milestone', now = Date.now(), headless = false, resumePolicy, expect,
  platform = process.platform, desktopProbe = defaultDesktopProbe, env = process.env,
  deepLoopRoot = DEFAULT_DEEP_LOOP_ROOT, exists = existsSync,
  descriptorBuilder = buildRuntimeResumeDescriptor,
  appIntent = false, cwdFn = process.cwd, nowFn = Date.now,
  attemptIdFactory = () => ulid(), beforeFinalAppendFn = () => {},
  mutationIdentity = null,
} = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isInteger(expect.generation)) throw new Error('FENCE_REQUIRED: emitHandoff');
  if (typeof appIntent !== 'boolean') throw new Error('APP_INTENT_BOOLEAN_REQUIRED');
  const policySnapshot = snapshotHandoffPolicyInputs(resumePolicy, headless, env);
  const callerBinding = { owner: expect.owner, generation: expect.generation };
  const observedCwd = cwdFn();
  const intentDigest = contentHash(JSON.stringify({ operation: 'handoff-emit',
    owner: expect.owner, generation: expect.generation,
    trigger_digest: contentHash(`emit-trigger\0${String(trigger)}`),
    reason_digest: contentHash(`emit-reason\0${String(reason ?? '')}`),
    observed_cwd_digest: contentHash(`emit-cwd\0${String(observedCwd)}`),
    policy: policySnapshot,
    app_intent: appIntent }));
  const identity = mutationIdentity === null
    ? { callerBinding, intentDigest, fenceError: 'LEASE_FENCED: handoff-emit' }
    : requirePrecompactMutationIdentity(mutationIdentity, 'emit', callerBinding);
  const withEmitMutation = body => withVerifiedMutationLock(root, runId, identity, body);
  const emitFence = loop => {
    const lease = loop?.session_chain?.lease;
    if (lease?.owner_run_id !== expect.owner || lease?.generation !== expect.generation) {
      throw new Error('LEASE_FENCED: handoff-emit');
    }
  };
  const reservationPhase = withEmitMutation(mutation => {
    let initialLoop;
    try {
      ({ data: initialLoop } = mutation.readVerifiedState({ fenceCheck: emitFence }));
    } catch (error) {
      if (String(error?.message || error).startsWith('LEASE_FENCED: handoff-emit')) {
        return { fencedResult: { ok: false, reason: 'fenced', key: null } };
      }
      throw error;
    }
    const initialRuntime = sessionRuntime(initialLoop);
    const policyIdentity = runtimePolicyIdentity(policySnapshot, initialRuntime);
    const effectiveResumePolicy = policySnapshot.resumePolicy
      ?? (policySnapshot.headless || policyIdentity.envHeadless
        || initialLoop.autonomy?.spawn_style === 'headless' ? 'headless' : 'visible');
    validateRuntimeProfile(initialRuntime, {
      model: initialLoop.autonomy?.session_model ?? null,
      effort: initialLoop.autonomy?.session_effort ?? null,
    });
    const canonicalRoot = canonicalProjectRoot(initialLoop.project.root);
    const initialAppAuthority = appIntent
      ? deriveAppEmitAuthority(initialLoop, canonicalRoot, expect.owner, observedCwd) : null;
    const reservationTrigger = policyBoundTrigger(trigger, policyIdentity);
    const res = reserveHandoff(canonicalRoot, runId,
      { trigger: reservationTrigger, now, expect, mutation });
    return { initialLoop, canonicalRoot, initialAppAuthority, res,
      effectiveResumePolicy };
  });
  if (reservationPhase.fencedResult) return reservationPhase.fencedResult;
  const { canonicalRoot, initialAppAuthority, res,
    effectiveResumePolicy } = reservationPhase;
  if (!res.ok) return { ok: false, reason: res.reason, key: res.key };
  if (!res.reserved) {
    const { data: current } = withEmitMutation(mutation =>
      mutation.readVerifiedState({ fenceCheck: emitFence }));
    const child = current.session_chain.sessions.find(session => session.run_id === res.childRunId);
    if (child) {
      const stored = child.continuation;
      if (!appIntent)
      {
        if (stored?.transport === 'codex-app') throw new Error('APP_TRANSPORT_OWNED');
      } else {
        const fresh = deriveAppEmitAuthority(current, canonicalRoot, expect.owner, cwdFn());
        const same = stored?.transport === 'codex-app' && stored.phase === 'emitted'
          && stored.route === fresh.route && stored.context_mode === fresh.contextMode
          && stored.target_cwd === fresh.targetCwd
          && stored.host_task_cwd_digest === fresh.hostTaskCwdDigest
          && stored.workstream_id === fresh.workstreamId && stored.project_id === null
          && stored.expected_runtime === 'codex' && stored.expected_host_surface === 'codex-app'
          && current.session_chain.lease.handoff_transport === 'codex-app'
          && current.session_chain.lease.handoff_attempt_id === stored.attempt_id
          && current.session_chain.lease.handoff_child_run_id === child.run_id
          && current.session_chain.sessions.find(session => session.run_id === expect.owner)
            ?.host_surface?.structured_stdin_mode === fresh.stdinMode;
        if (!same) throw new Error('APP_EMIT_BINDING_CONFLICT');
      }
      const appOriginFallback = !appIntent
        && current.autonomy?.session_runtime === 'codex'
        && current.session_chain.sessions.find(session => session.run_id === expect.owner)
          ?.host_surface?.kind === 'codex-app'
        && current.session_chain.lease.resume_policy === 'human';
      return { ok: true, reason: 'already-emitted', childRunId: res.childRunId, key: res.key,
        attemptId: stored?.attempt_id ?? null,
        handoffRel: child.handoff_rel ?? null, handoffPath: child.handoff_path ?? null,
        csName: child.handoff_cs ?? null, mdName: child.handoff_md ?? null,
        ...(appOriginFallback ? { appOriginFallback: true } : {}) };
    }
  }
  const { data: loop } = withEmitMutation(mutation =>
    mutation.readVerifiedState({ fenceCheck: emitFence }));
  const reserved = loop.session_chain.lease;
  const exactReservation = reserved.state === 'active'
    && reserved.handoff_phase === 'reserved'
    && reserved.handoff_idempotency_key === res.key
    && reserved.handoff_child_run_id === res.childRunId
    && !loop.session_chain.sessions.some(session => session.run_id === res.childRunId);
  if (!exactReservation) throw new Error('HANDOFF_PHASE_FENCED');
  const newAttemptId = appIntent ? attemptIdFactory() : null;
  if (
    appIntent
    && !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(newAttemptId)
  ) {
    try { rollbackReservedHandoff(canonicalRoot, runId, { owner: expect.owner,
      generation: expect.generation, key: res.key, childRunId: res.childRunId }); }
    catch { /* preserve validation error */ }
    throw new Error('APP_ATTEMPT_ID_INVALID');
  }
  const runtime = sessionRuntime(loop);
  const childRunId = res.childRunId;
  const dir = join(runDir(canonicalRoot, runId), 'handoffs');
  const termDir = join(runDir(canonicalRoot, runId), 'terminal');
  const stamp = tsName(now);
  const mdName = `${stamp}-next-session.md`;
  const csName = `${stamp}-compaction-state.json`;
  const handoffPath = join(dir, mdName);
  const handoffRel = `handoffs/${mdName}`;

  // Claude Desktop probing is transport-specific. Codex App continuation is
  // manual in Slice 1 and must never construct or probe a private URL handler.
  let dt = null;
  if (runtime === 'claude' && loop.autonomy?.spawn_style === 'desktop') {
    try { dt = desktopProbe({ platform }); } catch { dt = null; }
  }
  let descriptor;
  try {
    // Foreign-platform tests inject only the pure descriptor builder so their
    // physical fixture root never masquerades as a target-platform path. The
    // production CLI always uses the canonical state root through the default.
    descriptor = descriptorBuilder({
      runtime, root: canonicalRoot, parentRunId: runId, childRunId, handoffRel,
      launcher: loop.session_spawn?.launcher,
      launcherBin: loop.session_spawn?.launcher_bin,
      launcherSocket: loop.session_spawn?.launcher_socket,
      platform, desktopTarget: dt && dt.ok ? dt.argvTarget : null,
      exists,
      model: loop.autonomy?.session_model ?? null, effort: loop.autonomy?.session_effort ?? null,
      deepLoopRoot,
      runtimeExecutableIdentity: loop.autonomy?.runtime_executable_approval ?? null,
      launcherIdentity: descriptorLauncherIdentity(loop, runtime, platform),
    });
  } catch (error) {
    try { rollbackReservedHandoff(canonicalRoot, runId, { owner: expect.owner,
      generation: expect.generation, key: res.key, childRunId: res.childRunId }); }
    catch { /* preserve original descriptor error */ }
    throw error;
  }
  const cmds = descriptor.entries;

  mkdirSync(dir, { recursive: true });
  mkdirSync(termDir, { recursive: true });

  atomicWrite(handoffPath, handoffMarkdown(loop, childRunId, reason, descriptor));
  const compaction = wrap({
    producer: 'deep-loop', artifact_kind: 'compaction-state',
    schema: { name: 'compaction-state', version: '1.0' }, run_id: childRunId, parent_run_id: runId,
    git: loop.project ? { head: loop.project.head, branch: loop.project.branch, dirty: loop.project.dirty } : {},
    provenance: { source_artifacts: [handoffRel], tool_versions: {} },
    payload: { goal: loop.goal, routing: loop.routing, recipe: loop.recipe, current_episode: loop.current_episode, active_workstreams: loop.active_workstreams, reason },
    now: new Date(now).toISOString(),
  });
  atomicWrite(join(dir, csName), JSON.stringify(compaction, null, 2));

  // desktop 라인은 여기서 구성(P4-2/P5): available이면 사람용 재개 지시(URL 없음), 아니면 마커.
  // 자동 auto-pop이 주 경로. 이 수동 fallback은 auto-pop readiness timeout 시 사람이 쓰며, releasing lease를
  // 인수하도록 이미 설계된 /deep-loop-resume 를 재사용한다(child 식별·releasing/paused fence를 resume이 처리 — P5).
  // raw claude:// deeplink는 절대 여기 쓰지 않는다 — URL은 cmds.desktop.argv(machine 전용)에만 존재한다.
  // WS1: desktop URL cannot carry --model/--effort (§4), so state the intended values on the desktop
  // line for a human resuming via Claude Desktop (they set them with /model etc after resume).
  const meNote = (loop.autonomy?.session_model || loop.autonomy?.session_effort)
    ? ` [model=${loop.autonomy?.session_model || 'default'} effort=${loop.autonomy?.session_effort || 'default'}]`
    : '';
  const desktopLine = runtime === 'codex'
    ? cmds.desktop.display
    : (cmds.desktop.available
      ? '# desktop: 새 Claude Desktop Code 탭을 열고 `/deep-loop-resume` 실행 (auto-pop 미개방 시 수동 재개)'
      : '# desktop: unavailable (handler unverified)') + meNote;
  atomicWrite(join(termDir, 'launch-command.txt'), [
    `# interactive`, cmds.interactive.display, ``,
    `# headless`, cmds.headless.display, ``,
    `# cmux`, cmds.cmux.display, ``,
    `# iterm2`, cmds.iterm2.display, ``,
    `# terminal-app`, cmds['terminal-app'].display, ``,
    `# wt`, cmds.wt.display, ``,
    `# powershell`, cmds.powershell.display, ``,
    `# desktop`, desktopLine, ``,
  ].join('\n'));

  const appAttemptId = appIntent ? newAttemptId : null;
  let committedAppOriginFallback = false;
  const eventData = { child_run_id: childRunId, reason, key: res.key,
    ...(appAttemptId ? { attempt_id: appAttemptId } : {}) };
  const applyFinalEmit = (candidate, clock) => {
    const child = { run_id: childRunId, started_at: null, ended_at: null, turns: 0,
      outcome: null, superseded_by: null, handoff_rel: handoffRel,
      handoff_path: handoffPath, handoff_md: mdName, handoff_cs: csName,
      ...(appIntent
        ? { host_surface: null, continuation: {
        transport: 'codex-app', attempt_id: appAttemptId,
        route: initialAppAuthority.route, context_mode: initialAppAuthority.contextMode,
        phase: 'emitted', expected_runtime: 'codex', expected_host_surface: 'codex-app',
        target_cwd: initialAppAuthority.targetCwd,
        host_task_cwd_digest: initialAppAuthority.hostTaskCwdDigest,
        workstream_id: initialAppAuthority.workstreamId, project_id: null,
        descriptor_digest: null, emitted_at: clock.iso,
        prepare_deadline: new Date(clock.ms + APP_PREPARE_TIMEOUT_MS).toISOString(),
        prepared_at: null, confirmation_deadline: null, confirmed_at: null,
        acquired_at: null, acquired_generation: null, thread_id: null,
        unconfirmed_thread_id: null, failure_code: null, failure_binding: null } } : {}) };
    candidate.session_chain.sessions.push(child);
    const parent = candidate.session_chain.sessions.find(session => session.run_id === expect.owner);
    if (parent) parent.superseded_by = childRunId;
    const appOriginFallback = !appIntent
      && candidate.autonomy?.session_runtime === 'codex'
      && parent?.host_surface?.kind === 'codex-app';
    const lease = candidate.session_chain.lease;
    const clockMs = appIntent ? clock.ms : now;
    candidate.session_chain.lease = { ...lease, handoff_phase: 'emitted', state: 'releasing',
      expires_at: new Date(clockMs
        + (candidate.session_chain.stale_lease_ttl_sec || 900) * 1000).toISOString(),
      resume_policy: appIntent ? 'app'
        : appOriginFallback ? 'human' : effectiveResumePolicy,
      handoff_transport: appIntent ? 'codex-app' : lease.handoff_transport ?? null,
      handoff_attempt_id: appIntent ? appAttemptId : lease.handoff_attempt_id ?? null };
    return appOriginFallback;
  };
  try {
    beforeFinalAppendFn({ key: res.key, childRunId });
    const finalObservedCwd = cwdFn();
    withEmitMutation(mutation => mutation.appendAnchored(
      { type: 'handoff-emitted', data: eventData },
      (fresh, _spent, clock) => {
        committedAppOriginFallback = applyFinalEmit(fresh, clock);
      },
      (fresh, clock) => {
        const lease = fresh.session_chain.lease;
        if (fresh.status === 'paused') throw new Error('RUN_PAUSED: emitHandoff');
        if (fresh.status === 'completed' || fresh.status === 'stopped') {
          throw new Error('RUN_TERMINAL: emitHandoff');
        }
        if (appIntent)
        {
          const authority = deriveAppEmitAuthority(
            fresh, canonicalRoot, expect.owner, finalObservedCwd);
          if (JSON.stringify(authority) !== JSON.stringify(initialAppAuthority)) {
            throw new Error('APP_EMIT_AUTHORITY_FENCED');
          }
        }
        if (lease.handoff_idempotency_key !== res.key
            || lease.handoff_child_run_id !== childRunId) throw new Error('HANDOFF_KEY_MISMATCH');
        if (lease.state !== 'active' || lease.handoff_phase !== 'reserved'
            || fresh.session_chain.sessions.some(session => session.run_id === childRunId)) {
          throw new Error('HANDOFF_PHASE_FENCED');
        }
        const candidate = structuredClone(fresh);
        applyFinalEmit(candidate, clock);
        const checked = validate(candidate);
        if (!checked.ok) throw new Error(`STATE_INVALID: ${checked.errors.join('; ')}`);
      }, { ...(appIntent
        ? { nowFn } : {}), fenceCheck: emitFence }));
  } catch (error) {
    try { rollbackReservedHandoff(canonicalRoot, runId, { owner: expect.owner,
      generation: expect.generation, key: res.key, childRunId: res.childRunId }); }
    catch { /* keep first failure */ }
    if (String(error?.message || error).startsWith('RUN_TERMINAL')) {
      return { ok: false, reason: 'RUN_TERMINAL', key: res.key };
    }
    throw error;
  }
  return { ok: true, reason: 'emitted', handoffPath, childRunId, key: res.key, csName, mdName,
    handoffRel, ...(committedAppOriginFallback ? { appOriginFallback: true } : {}) };
}
