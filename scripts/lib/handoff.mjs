import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readState, runDir } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { wrap, atomicWrite } from './envelope.mjs';
import { reserveHandoff, rollbackHandoff } from './lease.mjs';
import { defaultDesktopProbe } from './desktop-target.mjs';
import { sessionRuntime } from './runtime.mjs';
import { canonicalProjectRoot } from './project-root.mjs';
import { buildRuntimeResumeDescriptor } from './runtime-descriptor.mjs';
import { validateRuntimeProfile } from './session-profile.mjs';
import { resolveSpawnMode } from './respawn.mjs';

export { buildLaunchCommand } from './runtime-descriptor.mjs';

const DEFAULT_DEEP_LOOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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
  deepLoopRoot = DEFAULT_DEEP_LOOP_ROOT,
} = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isInteger(expect.generation)) throw new Error('FENCE_REQUIRED: emitHandoff');
  // Resolve runtime and canonical root from root-bound durable state. This read
  // fences copied roots and malformed runtime state before reservation or files.
  const { data: initialLoop } = readState(root, runId);
  const initialRuntime = sessionRuntime(initialLoop);
  const effectiveResumePolicy = resumePolicy
    ?? (resolveSpawnMode(initialLoop, { headless, env }) === 'headless' ? 'headless' : 'visible');
  validateRuntimeProfile(initialRuntime, {
    model: initialLoop.autonomy?.session_model ?? null,
    effort: initialLoop.autonomy?.session_effort ?? null,
  });
  const canonicalRoot = canonicalProjectRoot(initialLoop.project.root);
  const res = reserveHandoff(canonicalRoot, runId, { trigger, now, expect });
  if (!res.ok) {
    if (res.reason === 'RUN_TERMINAL') {
      // v1.6 (spec §2.3-2 / plan r1 P2-a): 기존-reserved terminal 잔여 정리. rollbackHandoff의 terminal
      // 분기가 idle(잔여 없음)이면 write 없이 no-op이므로 정상-finish 후 신규-예약-거부 경로는 아무것도 쓰지 않는다.
      try { rollbackHandoff(canonicalRoot, runId, { owner: expect.owner, generation: expect.generation }); } catch { /* fenced race — 잔여 불활성 */ }
    }
    return { ok: false, reason: res.reason, key: res.key };
  }
  // Codex r1 🔴1 / r2 🔴1 / r3 🔴1: 같은 트리거 재진입(reserved:false)이면 이미 in-flight handoff 가 있다.
  // childRunId 는 reserve 가 영속한 값(res.childRunId)이라 동시/재진입이 같은 child 를 본다.
  if (!res.reserved) {
    const { data } = readState(canonicalRoot, runId);
    const child = data.session_chain.sessions.find(s => s.run_id === res.childRunId);
    if (child) {
      // 이미 emit 됨(session 존재). emit 은 이제 원자적(child push + phase=emitted 가 한 트랜잭션, Codex impl r11)이라
      // child 가 존재하면 phase 는 반드시 emitted 이상 → 추가 전이 불필요. 기존 메타데이터를 멱등 반환.
      return { ok: true, reason: 'already-emitted', childRunId: res.childRunId, key: res.key,
        handoffRel: child.handoff_rel ?? null, handoffPath: child.handoff_path ?? null,
        csName: child.handoff_cs ?? null, mdName: child.handoff_md ?? null };
    }
    // reserved 됐지만 session 미생성 → fall-through 해 emit 완료 (res.childRunId 재사용 → 중복 child 없음)
  }
  const { data: loop } = readState(canonicalRoot, runId);
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
    descriptor = buildRuntimeResumeDescriptor({
      runtime, root: canonicalRoot, parentRunId: runId, childRunId, handoffRel,
      launcher: loop.session_spawn?.launcher,
      launcherBin: loop.session_spawn?.launcher_bin,
      launcherSocket: loop.session_spawn?.launcher_socket,
      platform, desktopTarget: dt && dt.ok ? dt.argvTarget : null,
      model: loop.autonomy?.session_model ?? null, effort: loop.autonomy?.session_effort ?? null,
      deepLoopRoot,
      runtimeExecutableIdentity: loop.autonomy?.runtime_executable_approval ?? null,
      launcherIdentity: descriptorLauncherIdentity(loop, runtime, platform),
    });
  } catch (error) {
    try { rollbackHandoff(canonicalRoot, runId, { owner: expect.owner, generation: expect.generation }); } catch { /* preserve original descriptor error */ }
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

  // Codex impl r11 🔴: child session push + superseded_by + lease reserved→emitted (releasing + stale TTL) must be
  // ONE atomic transaction — a crash between a separate event-append and the phase advance previously left a recorded
  // handoff-emitted with phase still 'reserved' (respawn requires emitted/releasing → stranded). Single appendAnchored.
  const ttlMs = (loop.session_chain.stale_lease_ttl_sec || 900) * 1000;
  try {
  appendAnchored(canonicalRoot, runId, { type: 'handoff-emitted', data: { child_run_id: childRunId, reason, key: res.key } }, (l) => {
    // 멱등 push (Codex r3 🔴1): 같은 childRunId 가 이미 있으면 재push 금지 → 동시 emit 도 child 1개.
    if (!l.session_chain.sessions.some(s => s.run_id === childRunId)) {
      l.session_chain.sessions.push({ run_id: childRunId, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null,
        handoff_rel: handoffRel, handoff_path: handoffPath, handoff_md: mdName, handoff_cs: csName });
    }
    const cur = l.session_chain.sessions.find(s => s.run_id === expect.owner);
    if (cur) cur.superseded_by = childRunId;
    const lease = l.session_chain.lease;
    if (lease.handoff_phase === 'reserved') {   // 부모 carve-out 시작 + stale TTL (Codex r1 🔴4)
      l.session_chain.lease = { ...lease, handoff_phase: 'emitted', state: 'releasing', expires_at: new Date(now + ttlMs).toISOString(), resume_policy: effectiveResumePolicy };
    }
  }, (l) => {
    if (l.status === 'paused') throw new Error('RUN_PAUSED: emitHandoff');
    // v1.6 (spec §2.3-2, r1 🔴1): reserve(lock A)↔이 최종 append(lock B) 사이 finish 경합을 in-lock에서 봉쇄.
    if (l.status === 'completed' || l.status === 'stopped') throw new Error('RUN_TERMINAL: emitHandoff');
    const lease = l.session_chain.lease;
    if (expect && (lease.owner_run_id !== expect.owner || lease.generation !== expect.generation)) throw new Error('LEASE_FENCED: handoff-emit');
    if (lease.handoff_idempotency_key !== res.key) throw new Error('HANDOFF_KEY_MISMATCH');
  });
  } catch (e) {
    if (String(e?.message || e).startsWith('RUN_TERMINAL')) {
      // 보상 롤백 (spec §2.3-2 r4): reservation residue-free — terminal-aware rollback이 released로 안착.
      // 이미 써진 handoffs/*·launch-command.txt 파일은 삭제하지 않는다(이벤트 미등록이라 세션 체인 미참조,
      // 모든 재개 경로가 terminal에서 불활성 — 감사 흔적 보존). 보상 실패(경합 fence) 시 잔여도 불활성.
      try { rollbackHandoff(canonicalRoot, runId, { owner: expect.owner, generation: expect.generation }); } catch { /* 잔여 불활성 */ }
      return { ok: false, reason: 'RUN_TERMINAL', key: res.key };
    }
    throw e;
  }
  // handoffRel 반환 → respawn 이 동일 경로로 launch 명령을 빌드 (Codex r1 🔴3)
  return { ok: true, reason: 'emitted', handoffPath, childRunId, key: res.key, csName, mdName, handoffRel };
}
