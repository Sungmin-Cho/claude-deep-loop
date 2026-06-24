import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readState, runDir } from './state.mjs';
import { appendAnchored } from './integrity.mjs';
import { wrap, atomicWrite } from './envelope.mjs';
import { reserveHandoff } from './lease.mjs';

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

export function emitHandoff(root, runId, { reason = 'milestone', trigger = 'milestone', now = Date.now(), headless = false, expect } = {}) {
  if (!expect || typeof expect.owner !== 'string' || !Number.isInteger(expect.generation)) throw new Error('FENCE_REQUIRED: emitHandoff');
  const res = reserveHandoff(root, runId, { trigger, now, expect });
  if (!res.ok) return { ok: false, reason: res.reason, key: res.key };
  // Codex r1 🔴1 / r2 🔴1 / r3 🔴1: 같은 트리거 재진입(reserved:false)이면 이미 in-flight handoff 가 있다.
  // childRunId 는 reserve 가 영속한 값(res.childRunId)이라 동시/재진입이 같은 child 를 본다.
  if (!res.reserved) {
    const { data } = readState(root, runId);
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

  // Codex impl r11 🔴: child session push + superseded_by + lease reserved→emitted (releasing + stale TTL) must be
  // ONE atomic transaction — a crash between a separate event-append and the phase advance previously left a recorded
  // handoff-emitted with phase still 'reserved' (respawn requires emitted/releasing → stranded). Single appendAnchored.
  const ttlMs = (loop.session_chain.stale_lease_ttl_sec || 900) * 1000;
  appendAnchored(root, runId, { type: 'handoff-emitted', data: { child_run_id: childRunId, reason, key: res.key } }, (l) => {
    // 멱등 push (Codex r3 🔴1): 같은 childRunId 가 이미 있으면 재push 금지 → 동시 emit 도 child 1개.
    if (!l.session_chain.sessions.some(s => s.run_id === childRunId)) {
      l.session_chain.sessions.push({ run_id: childRunId, started_at: null, ended_at: null, turns: 0, outcome: null, superseded_by: null,
        handoff_rel: handoffRel, handoff_path: handoffPath, handoff_md: mdName, handoff_cs: csName });
    }
    const cur = l.session_chain.sessions.find(s => s.run_id === runId);
    if (cur) cur.superseded_by = childRunId;
    const lease = l.session_chain.lease;
    if (lease.handoff_phase === 'reserved') {   // 부모 carve-out 시작 + stale TTL (Codex r1 🔴4)
      l.session_chain.lease = { ...lease, handoff_phase: 'emitted', state: 'releasing', expires_at: new Date(now + ttlMs).toISOString() };
    }
  }, (l) => {
    const lease = l.session_chain.lease;
    if (expect && (lease.owner_run_id !== expect.owner || lease.generation !== expect.generation)) throw new Error('LEASE_FENCED: handoff-emit');
    if (lease.handoff_idempotency_key !== res.key) throw new Error('HANDOFF_KEY_MISMATCH');
  });
  // handoffRel 반환 → respawn 이 동일 경로로 launch 명령을 빌드 (Codex r1 🔴3)
  return { ok: true, reason: 'emitted', handoffPath, childRunId, key: res.key, csName, mdName, handoffRel };
}
