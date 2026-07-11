import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { isTrustedPsBin, trustedPsCandidates } from './detect-terminal.mjs';
import { validateSessionRuntime } from './runtime.mjs';
import { buildCodexExecEntry } from './codex-runtime.mjs';
import { validateRuntimeProfile } from './session-profile.mjs';

const CODEX_TRANSPORT_UNAVAILABLE = 'codex-transport-not-activated';

// POSIX single-quote wrap: embed s safely in a single-quoted shell argument.
// ' → '\'' (close-quote, literal-quote, reopen-quote).
function q(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Escape for an AppleScript double-quoted string literal. Backslashes must be
// doubled before quotes are escaped so shell quoting survives AppleScript.
function escApple(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }

// PowerShell single-quote escaping: ' → '' (doubling).
function psq(s) { return String(s).replace(/'/g, "''"); }

function meArgv(model, effort) {
  const argv = [];
  if (model) argv.push('--model', model);
  if (effort) argv.push('--effort', effort);
  return argv;
}

function meSh(quote, model, effort) {
  return `${model ? ` --model ${quote(model)}` : ''}${effort ? ` --effort ${quote(effort)}` : ''}`;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_HANDOFF_REL = /^handoffs\/[A-Za-z0-9._-]+$/;

function validateSpawnArgs({ parentRunId, childRunId, handoffRel }) {
  if (!SAFE_ID.test(String(parentRunId))) {
    throw Object.assign(new Error(`UNSAFE_SPAWN_ARG: parentRunId=${parentRunId}`), { code: 'UNSAFE_SPAWN_ARG' });
  }
  if (!SAFE_ID.test(String(childRunId))) {
    throw Object.assign(new Error(`UNSAFE_SPAWN_ARG: childRunId=${childRunId}`), { code: 'UNSAFE_SPAWN_ARG' });
  }
  if (!SAFE_HANDOFF_REL.test(String(handoffRel))) {
    throw Object.assign(new Error(`UNSAFE_SPAWN_ARG: handoffRel=${handoffRel}`), { code: 'UNSAFE_SPAWN_ARG' });
  }
}

export function resumeSkillToken(runtime = 'claude') {
  return validateSessionRuntime(runtime) === 'codex'
    ? '$deep-loop:deep-loop-resume'
    : '/deep-loop-resume';
}

export function usageOutputKind(runtime = 'claude') {
  return validateSessionRuntime(runtime) === 'codex' ? 'codex-jsonl' : 'claude-json';
}

function resumeInvocation(runtime, root, runId) {
  return `${resumeSkillToken(runtime)} --project-root ${JSON.stringify(root)} --run-id ${JSON.stringify(runId)}`;
}

function absolutePath(value) {
  return typeof value === 'string' && value.length > 0 && (posix.isAbsolute(value) || win32.isAbsolute(value));
}

function pathFor(root, ...segments) {
  return win32.isAbsolute(root) ? win32.join(root, ...segments) : posix.join(root, ...segments);
}

function buildCodexEntries({
  root, parentRunId, childRunId, handoffRel,
  model = null, effort = null, codexExecutable = null, deepLoopRoot = null,
}) {
  validateRuntimeProfile('codex', { model, effort });
  const invocation = resumeInvocation('codex', root, parentRunId);
  const handoffPath = pathFor(root, '.deep-loop', 'runs', parentRunId, handoffRel);
  const manualPrompt = `Read ${JSON.stringify(handoffPath)} first; then run ${invocation}`;
  const unavailable = (surface) => ({
    unavailable: true,
    reason: CODEX_TRANSPORT_UNAVAILABLE,
    display: `# ${surface}: unavailable (${CODEX_TRANSPORT_UNAVAILABLE})`,
  });
  const entries = {
    cmux: unavailable('cmux'),
    iterm2: unavailable('iterm2'),
    'terminal-app': unavailable('terminal-app'),
    wt: unavailable('wt'),
    powershell: unavailable('powershell'),
    desktop: {
      unavailable: true,
      reason: CODEX_TRANSPORT_UNAVAILABLE,
      manual: true,
      display: `# Codex App (manual): open a new task at ${JSON.stringify(root)}; then enter ${invocation}`,
    },
    headless: unavailable('headless'),
    interactive: {
      manual: true,
      display: `# Codex CLI (manual): open a new task at ${JSON.stringify(root)}; ${manualPrompt}`,
    },
  };
  if (codexExecutable != null) {
    if (!absolutePath(deepLoopRoot)) throw new Error('INVALID_DEEP_LOOP_ROOT: explicit absolute deep-loop root required');
    const skillPath = pathFor(deepLoopRoot, 'skills', 'deep-loop-resume', 'SKILL.md');
    const prompt = `Read ${JSON.stringify(handoffPath)} first. Then read ${JSON.stringify(skillPath)} and execute that workflow inline for project root ${JSON.stringify(root)} and run id ${JSON.stringify(parentRunId)}.`;
    entries.headless = {
      ...buildCodexExecEntry({ executable: codexExecutable, projectRoot: root, prompt, model, effort }),
      display: `# Codex CLI headless: ${JSON.stringify(codexExecutable)} (isolated descriptor; prompt via stdin)`,
    };
  }
  return entries;
}

function buildClaudeEntries({
  root, parentRunId, childRunId, handoffRel,
  launcherBin, launcherSocket,
  platform = process.platform, desktopTarget = null, exists = existsSync,
  model = null, effort = null,
}) {
  const resumePrompt = `Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume`;
  const inner = `deep-loop-${childRunId}`;

  // Desktop URLs remain a Claude-only machine argv detail. No URL is ever put
  // in a human-readable display field.
  const desktopUrl = `claude://code/new?folder=${encodeURIComponent(root)}&q=${encodeURIComponent(resumePrompt)}`;
  let desktopEntry;
  if (desktopTarget && desktopTarget.kind === 'macos-app' && platform === 'darwin') {
    desktopEntry = { bin: '/usr/bin/open', argv: ['-a', desktopTarget.appPath, desktopUrl], available: true };
  } else if (desktopTarget && desktopTarget.kind === 'win-exe' && platform === 'win32') {
    const psBin = trustedPsCandidates(exists)[0];
    if (psBin) {
      const psCmd = `Start-Process -FilePath '${psq(desktopTarget.exePath)}' -ArgumentList '${psq(desktopUrl)}'`;
      desktopEntry = { bin: psBin, argv: ['-NoProfile', '-Command', psCmd], available: true };
    } else {
      desktopEntry = { unavailable: true };
    }
  } else {
    desktopEntry = { unavailable: true };
  }

  const cmuxCmdStr = `claude -n ${q(inner)} ${q(resumePrompt)}${meSh(q, model, effort)}`;
  const cmuxArgv = launcherSocket
    ? ['--socket', launcherSocket, 'new-workspace', '--cwd', root, '--command', cmuxCmdStr, '--focus', 'true']
    : ['new-workspace', '--cwd', root, '--command', cmuxCmdStr, '--focus', 'true'];
  const effectiveBin = launcherBin || 'cmux';

  const innerSh = `cd ${q(root)} && claude -n ${inner} "${resumePrompt}"${meSh(q, model, effort)}`;
  const iterm2Script = `tell application "iTerm" to create window with default profile command "${escApple(innerSh)}"`;
  const terminalScript = `tell application "Terminal" to do script "${escApple(innerSh)}"`;

  let powershellEntry;
  if (isTrustedPsBin(launcherBin)) {
    const innerPS = `Set-Location -LiteralPath '${psq(root)}'; & claude -n '${psq(inner)}' '${psq(resumePrompt)}'${meSh((x) => `'${psq(x)}'`, model, effort)}`;
    const b64 = Buffer.from(innerPS, 'utf16le').toString('base64');
    const psCmd = `Start-Process '${psq(launcherBin)}' -ArgumentList '-NoExit','-EncodedCommand','${b64}'`;
    powershellEntry = { bin: launcherBin, argv: ['-Command', psCmd], display: `& '${psq(launcherBin)}' -Command "${psCmd}"` };
  } else {
    powershellEntry = { bin: null, argv: null, unavailable: true, display: '# powershell: unavailable (no trusted launcher_bin)' };
  }

  const headlessDisplay = `cd ${q(root)} && claude -p "${resumePrompt}"${meSh(q, model, effort)} --output-format json --permission-mode acceptEdits`;
  const interactiveDisplay = `cd ${q(root)} && claude -n ${inner} "${resumePrompt}"${meSh(q, model, effort)}`;
  const cmuxDisplay = `${effectiveBin}${launcherSocket ? ` --socket ${q(launcherSocket)}` : ''} new-workspace --cwd ${q(root)} --command ${q(cmuxCmdStr)} --focus true`;

  return {
    cmux: {
      bin: effectiveBin,
      argv: cmuxArgv,
      display: cmuxDisplay,
    },
    iterm2: {
      bin: 'osascript',
      argv: ['-e', iterm2Script],
      display: `osascript -e '${iterm2Script}'`,
    },
    'terminal-app': {
      bin: 'osascript',
      argv: ['-e', terminalScript],
      display: `osascript -e '${terminalScript}'`,
    },
    wt: {
      bin: 'wt.exe',
      argv: ['-d', root, 'claude', '-n', inner, resumePrompt, ...meArgv(model, effort)],
      display: `wt.exe -d ${q(root)} claude -n ${inner} "${resumePrompt}"${meSh(q, model, effort)}`,
    },
    powershell: powershellEntry,
    desktop: desktopEntry,
    headless: {
      bin: 'claude',
      argv: ['-p', resumePrompt, ...meArgv(model, effort), '--output-format', 'json', '--permission-mode', 'acceptEdits'],
      cwd: root,
      display: headlessDisplay,
    },
    interactive: {
      display: interactiveDisplay,
    },
  };
}

export function buildRuntimeResumeDescriptor({
  runtime = 'claude', root, parentRunId, childRunId, handoffRel,
  launcher, launcherBin, launcherSocket,
  platform = process.platform, desktopTarget = null, exists = existsSync,
  model = null, effort = null,
  codexExecutable = null, deepLoopRoot = null,
} = {}) {
  const selectedRuntime = validateSessionRuntime(runtime);
  validateRuntimeProfile(selectedRuntime, { model, effort });
  validateSpawnArgs({ parentRunId, childRunId, handoffRel });
  const invocation = resumeInvocation(selectedRuntime, root, parentRunId);
  const resumePrompt = selectedRuntime === 'claude'
    ? `Read .deep-loop/runs/${parentRunId}/${handoffRel} first; then run /deep-loop-resume`
    : `Read ${JSON.stringify(`${root}/.deep-loop/runs/${parentRunId}/${handoffRel}`)} first; then run ${invocation}`;
  const entries = selectedRuntime === 'claude'
    ? buildClaudeEntries({ root, parentRunId, childRunId, handoffRel, launcher, launcherBin, launcherSocket, platform, desktopTarget, exists, model, effort })
    : buildCodexEntries({ root, parentRunId, childRunId, handoffRel, model, effort, codexExecutable, deepLoopRoot });
  return {
    runtime: selectedRuntime,
    projectRoot: root,
    runId: parentRunId,
    childRunId,
    handoffRel,
    resumeSkillToken: resumeSkillToken(selectedRuntime),
    usageOutputKind: usageOutputKind(selectedRuntime),
    resumeInvocation: invocation,
    resumePrompt,
    entries,
  };
}

// Compatibility surface: callers historically imported this from handoff.mjs
// and expect the launcher entry map directly.
export function buildLaunchCommand(options = {}) {
  return buildRuntimeResumeDescriptor(options).entries;
}
