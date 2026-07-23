import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = (dir) => join(ROOT, 'skills', dir, 'SKILL.md');
const _rf = readFileSync;
const WORKFLOW_REFS = ['adapters.md', 'review-strategy.md', 'handoff-respawn.md', 'hill-climbing.md'];

// Portable recursive .md walk (no reliance on Node ≥20.12 Dirent.parentPath) — Node ≥20 (engines) safe.
function walkMdFiles(dir) {
  let out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(walkMdFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

// 매니페스트: [dir, name, userInvocable, triggers[](영+한 둘 다 포함해야), refsCLI?(mutating이면 CLI 참조 필수)]
const SKILLS = [
  ['deep-loop', 'deep-loop', true, ['/deep-loop', '루프', 'loop engineering'], true],
  ['deep-loop-workflow', 'deep-loop-workflow', false, ['adapter', '어댑터'], false],
  ['deep-loop-discover', 'deep-loop-discover', true, ['/deep-loop-discover', 'discover', '발견'], true],
  ['deep-loop-triage', 'deep-loop-triage', true, ['/deep-loop-triage', 'triage', '분류'], true],
  ['deep-loop-continue', 'deep-loop-continue', true, ['/deep-loop-continue', 'tick', '진행', '계속'], true],
  ['deep-loop-compact', 'deep-loop-compact', true, ['/deep-loop-compact', '$deep-loop:deep-loop-compact', 'compact', '압축'], true],
  ['deep-loop-handoff', 'deep-loop-handoff', true, ['/deep-loop-handoff', 'handoff', '인수인계'], true],
  ['deep-loop-resume', 'deep-loop-resume', true, ['/deep-loop-resume', 'resume', '이어'], true],
  ['deep-loop-status', 'deep-loop-status', true, ['/deep-loop-status', 'status', '상태'], false],
  ['deep-loop-ack', 'deep-loop-ack', true, ['/deep-loop-ack', 'ack', '검토'], true],
  ['deep-loop-finish', 'deep-loop-finish', true, ['/deep-loop-finish', 'finish', '종료'], true],
];

const EXECUTION_DOCS = [
  ...SKILLS.map(([dir]) => skillPath(dir)),
  ...WORKFLOW_REFS.map((name) => join(ROOT, 'skills', 'deep-loop-workflow', 'references', name)),
];

function kernelCommandLines(src) {
  return src.split('\n').filter((line) => /deep-loop\.mjs/.test(line));
}

function frontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(m, 'frontmatter block present');
  return m[1];
}

// Codex r1 sf-4 / r2 sf-3: 2-plane 경계 강제 — durable state 에 대한 *쓰기 지침*만 잡고 읽기/언급/마크다운 인용은 허용.
// durable paths: loop.json · event-log.jsonl · .loop.hash · .deep-loop/runs.
// 셸 redirect 는 **마크다운 blockquote(줄이 '>' 로 시작)를 제외하고** 줄 단위로만 판정한다
// — '> [!IMPORTANT] loop.json + handoff are source of truth' 같은 정상 callout 오탐 방지.
function violatesBoundary(src) {
  // Codex r6 sf-3: 금지 대상은 **커널 전용 durable state 파일 3종**뿐. `.deep-loop/runs/<id>/final-report.md`
  // 같은 비-상태 artifact 쓰기는 /deep-loop-finish 가 정당하게 수행하므로 차단하지 않는다(§12·§15).
  const DUR = '(loop\\.json|event-log\\.jsonl|\\.loop\\.hash)';
  const callForms = [
    new RegExp(`(Write|Edit)\\s*\\([^)]*?${DUR}`),
    new RegExp(`(writeFileSync|appendFileSync|writeFile|appendFile)\\s*\\([^)]*?${DUR}`),
    new RegExp(`\\bsed\\s+-i\\b[^\\n]*?${DUR}`),                     // sed -i 인플레이스
    new RegExp(`\\b(perl|ruby)\\s+-[a-z]*i[a-z]*\\b[^\\n]*?${DUR}`),  // perl/ruby -i 인플레이스
    new RegExp(`open\\s*\\([^)]*${DUR}[^)]*,\\s*["'][wa]`),           // python/ruby open(..., "w"/"a")
  ];
  if (callForms.some(re => re.test(src))) return true;
  // 줄 단위(blockquote 제외): state 파일을 대상으로 하는 셸 쓰기/redirect (cp/mv/rm/truncate/dd).
  const redirect = new RegExp(`(?:>>?|\\btee\\b)\\s+\\S*${DUR}`);
  const shellWrite = new RegExp(`\\b(cp|mv|rm|truncate|install|dd)\\b[^\\n]*${DUR}`);
  return src.split('\n').some(line => {
    if (/^\s*>/.test(line)) return false;   // 마크다운 blockquote — 셸 쓰기 아님
    return redirect.test(line) || shellWrite.test(line);
  });
}

// Codex r3 sf-4: deep-loop.mjs 를 실제 호출하는 라인 중 mutating subcommand 는 --owner 와 --generation 을 **둘 다** 가져야 한다.
// Task 8: insights emit 도 mutating (lease-fenced) — MUTATING_SUB/MUTATING_CMD 둘 다 확장.
const MUTATING_SUB = /(state\s+patch|episode\s+(?:new|record|abandon)|workstream\s+(?:new|set|terminal)|review\s+(?:dispatch|record)|handoff\s+emit|checkpoint\s+(?:emit|restore)|pause\b|budget\s+record|comprehension\s+ack|breaker\s+reset|session-profile\s+set|launcher-executable\s+approve|lease\s+(?:acquire|release)|finish\b|insights\s+emit)/;
// Codex r5 sf-3: shorthand 명령(예: `episode record --status done`, `finish --status completed`)도 잡는다.
// "command 라인" = deep-loop.mjs 호출이거나, mutating sub 뒤에 CLI 플래그(--xxx)가 오는 경우. 순수 산문 멘션은 무시.
const MUTATING_CMD = /(?:state\s+patch|episode\s+(?:new|record|abandon)|workstream\s+(?:new|set|terminal)|review\s+(?:dispatch|record)|handoff\s+emit|checkpoint\s+(?:emit|restore)|pause|budget\s+record|comprehension\s+ack|breaker\s+reset|session-profile\s+set|launcher-executable\s+approve|lease\s+(?:acquire|release)|finish|insights\s+emit)\b[^\n]*\s--\w/;
function mutatingFenced(text) {
  // Codex r4 sf-2: 셸 라인 연속(\ 로 끝나는 줄)을 논리 명령으로 먼저 합친다 — multi-line unfenced 명령 회피 차단.
  const joined = text.replace(/\r\n?/g, '\n').replace(/\\\n\s*/g, ' ');
  return joined.split('\n').every(line => {
    if (!MUTATING_SUB.test(line)) return true;                       // mutating sub 언급 없음 → OK
    const isCommand = /deep-loop\.mjs/.test(line) || MUTATING_CMD.test(line);
    if (!isCommand) return true;                                     // 산문 멘션(플래그 없음) → 무시
    return /--owner\b/.test(line) && /--generation\b/.test(line);    // mutating 명령 → 두 fence flag 필수 (OR 아님)
  });
}

// R3 high-3: bare-relative `.claude/worktrees/ws`(git이 cwd 기준 해석 → worktree 안에서 중첩)도 위험.
// 안전 조건을 강화: worktree 경로가 등장하면 반드시 $ORIG_ROOT 절대 앵커여야 한다. '..'·foreign-abs·bare-relative 모두 flag.
// 산문 오탐 회피: worktrees 경로 토큰이나 foreign 절대경로가 없는 순수 멘션 라인은 무시.
function worktreeWriteOutsideRoot(src) {
  const joined = src.replace(/\r\n?/g, '\n').replace(/\\\n\s*/g, ' ');   // 백슬래시 연속줄 join (mutatingFenced 패턴)
  return joined.split('\n').some(line => {
    // R5 P2-1: git 옵션(-C 등)이 git 과 worktree add 사이에 와도 매칭.
    if (!/\bgit\b[^\n]*\bworktree\s+add\b/.test(line)) return false;
    if (/\.\.(\/|\\)/.test(line)) return true;                                    // '..' escape
    const origRootAnchored = /(?:\$\{?ORIG_ROOT\}?|<canonical_project_root>)\/[^"'\s]*\.(claude\/worktrees|worktrees)\//.test(line);
    const mentionsWtPath = /\.(claude\/worktrees|worktrees)\//.test(line);
    if (mentionsWtPath && !origRootAnchored) return true;                         // bare/cwd-relative worktrees path
    const hasForeignAbs = /\s["']?\/(?!\/)/.test(line) || /\s["']?[A-Za-z]:\\/.test(line);
    return hasForeignAbs && !origRootAnchored;                                    // /tmp 등 foreign abs
  });
}

test('boundary: worktree-write guard flags root-escape/bare-relative/git-options, allows $ORIG_ROOT-anchored', () => {
  assert.ok(worktreeWriteOutsideRoot('git worktree add /tmp/wt -b x base'), 'abs /tmp flagged');
  assert.ok(worktreeWriteOutsideRoot('git worktree add ../sib/wt -b x base'), '.. flagged');
  assert.ok(worktreeWriteOutsideRoot('git worktree add -b x \\\n  /tmp/wt base'), 'multiline escape flagged');
  assert.ok(worktreeWriteOutsideRoot('git worktree add .claude/worktrees/ws -b x base'), 'bare-relative worktrees flagged (R3 high-3)');
  assert.ok(worktreeWriteOutsideRoot('git -C "$ORIG_ROOT" worktree add /tmp/wt -b x base'), 'git -C option + /tmp flagged (R5 P2-1)');
  assert.ok(!worktreeWriteOutsideRoot('git worktree add -b worktree-ws "$ORIG_ROOT/.claude/worktrees/ws" "$BASE_REF"'), 'ORIG_ROOT-anchored allowed');
  assert.ok(!worktreeWriteOutsideRoot('git worktree add -b "worktree-ws" "<canonical_project_root>/.claude/worktrees/ws" "<base_ref>"'), 'portable canonical-root placeholder allowed');
  assert.ok(!worktreeWriteOutsideRoot('git worktree add \\\n  -b w "$ORIG_ROOT/.claude/worktrees/ws" "$BASE_REF"'), 'ORIG_ROOT-anchored multiline allowed');
  assert.ok(!worktreeWriteOutsideRoot('이미 worktree 안이면 재사용 (산문)'), 'prose without git-worktree-add ignored');
});

test('CLAUDE.md: invariant #7 carries explicit worktree-write carve-out', () => {
  const md = _rf(join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(md, /\.claude\/worktrees\//, 'names .claude/worktrees/ carve-out');
  assert.match(md, /worktree[\s\S]{0,400}(proposal-only|사람 승인|human|containment)/i, 'carve-out rules present');
});

test('boundary scan flags forbidden write forms and allows reads/mentions/blockquotes (fixtures)', () => {
  const bad = [
    'Write({ file_path: ".deep-loop/runs/x/loop.json", content: "..." })',
    'fs.appendFileSync(".deep-loop/runs/x/event-log.jsonl", line)',
    'echo "$JSON" > .deep-loop/runs/$ID/loop.json',
    'sed -i "s/running/paused/" .deep-loop/runs/x/loop.json',
    'cp tmp .deep-loop/runs/$ID/loop.json',
    'mv tmp .deep-loop/runs/x/event-log.jsonl',
    'truncate -s 0 .deep-loop/runs/x/loop.json',
    "python -c \"open('.deep-loop/runs/x/loop.json', 'w')\"",
    'node -e "fs.writeFileSync(\'a/.loop.hash\', h)"',
  ];
  for (const s of bad) assert.ok(violatesBoundary(s), `should flag: ${s}`);
  const ok = [
    'loop.json + handoff 가 source of truth. 이전 대화 가정 금지.',
    '> [!IMPORTANT] loop.json + handoff are the source of truth.',   // blockquote 오탐 금지
    '> .deep-loop/runs/<id>/loop.json 은 커널만 쓴다.',               // blockquote path 언급 허용
    'run dir 은 .deep-loop/runs/<id>/ 이다 (커널만 씀).',             // 비-blockquote path 언급(쓰기 동사 없음) 허용
    'Write({ file_path: ".deep-loop/runs/<id>/final-report.md", content: report })',   // Codex r6 sf-3: 정당한 artifact write 허용
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/deep-loop.mjs" state get --field status',
    'Read .deep-loop/runs/<id>/handoffs/<ts>-next-session.md first; then /deep-loop-resume',
    'event-log.jsonl 은 커널이 appendAnchored 단일 경로로만 쓴다 (스킬은 절대 직접 쓰지 않음).',
  ];
  for (const s of ok) assert.ok(!violatesBoundary(s), `should allow: ${s}`);
});

test('mutatingFenced requires both fence flags on mutating CLI lines (fixtures)', () => {
  assert.ok(mutatingFenced('node x/deep-loop.mjs episode record --status done --owner $R --generation 1'));
  assert.ok(!mutatingFenced('node x/deep-loop.mjs episode record --status done --owner $R'));   // --generation 누락
  assert.ok(!mutatingFenced('node x/deep-loop.mjs review record --verdict APPROVE --generation 1'));   // --owner 누락
  assert.ok(mutatingFenced('node x/deep-loop.mjs next-action --json'));   // read-only → fence 불필요
  assert.ok(mutatingFenced('record the result via `episode record`'));    // 산문(플래그 없음) → 무시
  // Codex r4 sf-2: 셸 연속줄로 fence 를 분리해 회피하는 시도 차단.
  assert.ok(!mutatingFenced('node x/deep-loop.mjs \\\n  state patch --field discovered_items --value "[]"'));
  assert.ok(!mutatingFenced('node x/deep-loop.mjs \\\r\n  state patch --field discovered_items --value "[]"'));
  assert.ok(mutatingFenced('node x/deep-loop.mjs \\\n  state patch --field x --value "[]" --owner $R --generation 1'));
  // Codex r5 sf-3: deep-loop.mjs 프리픽스 없는 shorthand mutating 명령도 fence 필요.
  assert.ok(!mutatingFenced('episode record --status done --artifacts \'["a"]\''));   // shorthand unfenced
  assert.ok(!mutatingFenced('finish --status completed --report final-report.md'));   // shorthand unfenced
  assert.ok(mutatingFenced('episode record --status done --owner $R --generation 1'));   // shorthand fenced OK
});

// Task 4.1: the execution plane is copied between Claude Code, Codex CLI/App, POSIX,
// PowerShell, and cmd.exe.  Command examples therefore describe argv, never a shell program.
test('portable command contract: every entry derives and substitutes an absolute DEEP_LOOP_ROOT', () => {
  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    assert.match(src, /loaded SKILL\.md path|로드된 `?SKILL\.md`? 경로/i,
      `${file}: root derivation must start from the loaded SKILL.md path`);
    assert.match(src, /DEEP_LOOP_ROOT[\s\S]{0,360}(?:absolute|절대)/i,
      `${file}: DEEP_LOOP_ROOT must be an absolute derived root`);
    assert.match(src, /(?:replace|substitut|치환)[\s\S]{0,240}DEEP_LOOP_ROOT|DEEP_LOOP_ROOT[\s\S]{0,240}(?:replace|substitut|치환)/i,
      `${file}: the placeholder must be replaced before execution`);
    assert.match(src, /literal[\s\S]{0,160}DEEP_LOOP_ROOT[\s\S]{0,200}(?:never|금지|않)/i,
      `${file}: literal DEEP_LOOP_ROOT must never reach Node`);
  }
});

test('portable command contract: kernel examples are one-line canonical argv templates', () => {
  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    const commands = kernelCommandLines(src);
    for (const line of commands) {
      assert.match(line, /^\s*node "DEEP_LOOP_ROOT\/scripts\/deep-loop\.mjs"(?:\s|$)/,
        `${file}: non-canonical or non-one-line kernel command: ${line}`);
      assert.doesNotMatch(line, /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}|%(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)%|\$env:(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)/i,
        `${file}: command depends on an ambient plugin-root expansion`);
      assert.doesNotMatch(line, /\\\s*$/, `${file}: command uses backslash continuation`);
    }
  }
});

test('portable command contract: execution docs contain no shell-only construction', () => {
  const forbidden = [
    [/\$\(/, 'command substitution'],
    [/\b[A-Z][A-Z0-9_]*\s*=\s*\(/, 'Bash array'],
    [/\$\{[A-Z][A-Z0-9_]*\[@\]\}/, 'Bash array expansion'],
    [/^\s*[A-Z][A-Z0-9_]*=\S+(?:\s+[A-Z][A-Z0-9_]*=\S+)*\s+\S+/m, 'POSIX env-prefix assignment'],
    [/^\s*\[[^\n]*\]\s*(?:&&|\|\|)/m, 'Bash test/chaining'],
    [/(?:&&|\|\|)/, 'shell command chaining'],
    [/\\\s*$/m, 'backslash continuation'],
  ];
  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    for (const [pattern, label] of forbidden) {
      assert.doesNotMatch(src, pattern, `${file}: ${label} is not host-neutral`);
    }
  }
});

test('portable command contract: runtime and resumed mutation identity are explicit', () => {
  const init = kernelCommandLines(readFileSync(skillPath('deep-loop'), 'utf8'))
    .find((line) => /\binit-run\b/.test(line)) || '';
  assert.match(init, /--runtime\s+<claude\|codex>/, 'init-run must carry the asserted current runtime');
  assert.match(init, /--project-root\s+"<canonical_project_root>"/, 'init-run must pin the canonical root');

  for (const file of EXECUTION_DOCS) {
    const src = readFileSync(file, 'utf8');
    for (const line of kernelCommandLines(src)) {
      if (/\blease acquire\b/.test(line)) {
        assert.match(line, /--runtime\s+<claude\|codex>/, `${file}: lease acquire must assert runtime`);
      }
      if (/--project-root\b/.test(line)) {
        assert.match(line, /--project-root\s+"<canonical_project_root>"/,
          `${file}: project-root placeholder must be quoted`);
      }
      if (MUTATING_SUB.test(line) && /--owner\b/.test(line)) {
        assert.match(line, /--project-root\s+"<canonical_project_root>"/,
          `${file}: resumed mutation must pin project root`);
        assert.match(line, /--run-id\s+<run_id>/,
          `${file}: resumed mutation must pin logical run id`);
        assert.match(line, /--generation\b/, `${file}: resumed mutation must retain generation fence`);
      }
    }
  }
});

test('portable host invocation contract: every user entry names Claude slash and Codex qualified dollar forms', () => {
  for (const [dir, name, invocable] of SKILLS) {
    if (!invocable) continue;
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.match(src, new RegExp(`/${name}\\b`), `${dir}: Claude slash invocation missing`);
    assert.match(src, new RegExp(`\\$deep-loop:${name}\\b`), `${dir}: Codex qualified dollar invocation missing`);
  }
});

// Task 4: deep-loop §2-6 worktree creation discipline
const dlSkill = () => _rf(skillPath('deep-loop'), 'utf8');

test('deep-loop §2-6: native-first + git-fallback + convention path + single/multi split', () => {
  const s = dlSkill();
  assert.match(s, /EnterWorktree/, 'native example');
  assert.match(s, /git worktree add/, 'git fallback');
  assert.match(s, /\.claude\/worktrees\//, 'convention path');
  assert.match(s, /단일[\s\S]{0,80}native/, 'single-run native');
  assert.match(s, /다중[\s\S]{0,120}(git|전부 git|모든)/, 'multi-run git');
});

test('deep-loop §2-6: detection-first + reuse eligibility gate', () => {
  const s = dlSkill();
  assert.match(s, /git-common-dir|이미 (격리|worktree)/, 'Step 0 detection');
  assert.match(s, /clean[\s\S]{0,160}base[\s\S]{0,160}(소유|브랜치)/, 'reuse eligibility');
  assert.match(s, /(사용자 확인|human|승인)/, 'reuse confirm gate');
});

test('deep-loop §2-6: gitignore proposal-only + check-ignore precedes add', () => {
  const s = dlSkill();
  const ci = s.indexOf('check-ignore'), wa = s.indexOf('git worktree add');
  assert.ok(ci !== -1 && wa !== -1 && ci < wa, 'check-ignore precedes worktree add');
  const autoCommit = s.split('\n').some(l => /gitignore/i.test(l) && /\bgit\s+commit\b/.test(l));
  assert.ok(!autoCommit, 'no auto-commit .gitignore');
  assert.match(s, /proposal-only|제안|승인 시에만/, 'gitignore proposal-only');
});

test('deep-loop §2-6: worktree creation never escapes root + post-init mutations pin root/run', () => {
  const s = dlSkill();
  assert.ok(!worktreeWriteOutsideRoot(s), 'no root-escaping git worktree add');
  const resumedMutations = kernelCommandLines(s).filter((line) => MUTATING_SUB.test(line) && /--owner\b/.test(line));
  assert.ok(resumedMutations.length > 0, 'post-init mutation examples exist');
  for (const line of resumedMutations) {
    assert.match(line, /--project-root\s+"<canonical_project_root>"/);
    assert.match(line, /--run-id\s+<run_id>/);
  }
  assert.ok(mutatingFenced(s), 'mutating CLI still fenced');
});

// Task 5: §0.5 cwd split + artifact ORIG_ROOT-relative + Step 1.5 orphan mitigation
test('deep-loop: ORIG_ROOT/BASE_REF capture (sibling path) + cwd split + artifact ORIG_ROOT-rel', () => {
  const s = dlSkill();
  // Extract the §0.5 section: from its heading to the next #### heading
  const sec05Match = s.match(/####\s*§0\.5[\s\S]*?(?=\n####|\n###|\n##|$)/);
  assert.ok(sec05Match, '§0.5 section present');
  const sec05 = sec05Match[0];
  // Rule 1: ORIG_ROOT/BASE_REF capture must be documented IN the §0.5 section
  assert.match(sec05, /ORIG_ROOT/, 'ORIG_ROOT capture documented in §0.5 section');
  assert.match(sec05, /BASE_REF/, 'BASE_REF capture documented in §0.5 section');
  assert.match(sec05, /(sibling|캡처)/, 'capture purpose (sibling/캡처) documented in §0.5 section');
  // Rule 4: cwd split
  assert.match(sec05, /cwd[\s\S]{0,80}(분리|worktree)/, 'cwd split in §0.5 section');
  // Rule 5: artifact ORIG_ROOT-relative
  assert.match(sec05, /artifact[\s\S]{0,160}(ORIG_ROOT|상대|\.claude\/worktrees)/, 'artifact ORIG_ROOT-relative in §0.5 section');
  // FIX P: ORIG_ROOT must use git-common-dir (main repo root), not bare --show-toplevel
  // (in a linked worktree, --show-toplevel returns the worktree path, not the project root)
  assert.match(sec05, /git-common-dir/, 'ORIG_ROOT must use git-common-dir main-root derivation in §0.5 (not bare --show-toplevel)');
});

test('deep-loop Step 1.5: lease check precheck + orphan handling (no --field lease command)', () => {
  const s = dlSkill();
  assert.match(s, /lease check/, 'lease check precheck');
  assert.ok(!/state\s+get[^\n]*--field\s+lease\b/.test(s), 'no `state get --field lease` command');
  assert.match(s, /(reconcile|audit)/, 'reconcile audit');
  assert.match(s, /(고아|orphan)/, 'orphan handling');
});

for (const [dir, name, invocable, triggers, refsCLI] of SKILLS) {
  test(`skill ${dir}: exists`, () => assert.ok(existsSync(skillPath(dir)), `${dir}/SKILL.md missing`));
  test(`skill ${dir}: frontmatter has exactly name/description/user-invocable`, () => {
    const fm = frontmatter(readFileSync(skillPath(dir), 'utf8'));
    assert.match(fm, new RegExp(`name:\\s*${name}\\b`));
    assert.match(fm, new RegExp(`user-invocable:\\s*${invocable}`));
    assert.match(fm, /description:/);
    // 허용 키만 (다른 top-level 키 금지)
    const keys = fm.split(/\r?\n/).filter(l => /^[a-z-]+:/.test(l)).map(l => l.split(':')[0]);
    for (const k of keys) assert.ok(['name', 'description', 'user-invocable'].includes(k), `unexpected key ${k} in ${dir}`);
  });
  test(`skill ${dir}: triggers present (en+ko)`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    for (const t of triggers) assert.ok(src.includes(t), `${dir} missing trigger "${t}"`);
  });
  test(`skill ${dir}: language-detect instruction`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.match(src, /언어|language/i);
  });
  test(`skill ${dir}: never instructs a direct durable-state write`, () => {
    assert.ok(!violatesBoundary(readFileSync(skillPath(dir), 'utf8')),
      `${dir} instructs a direct durable-state write — must route through the fenced CLI`);
  });
  if (refsCLI) {
    test(`skill ${dir}: every mutating CLI line carries both fence flags`, () => {
      const src = readFileSync(skillPath(dir), 'utf8');
      assert.match(src, /deep-loop\.mjs/, `${dir} must invoke kernel CLI`);
      // Codex r3 sf-4: --owner 와 --generation 둘 다 (OR 아님). mutating CLI 라인마다 fence 필수.
      assert.ok(mutatingFenced(src), `${dir} has a mutating deep-loop.mjs line missing --owner or --generation`);
    });
  }
  if (invocable && dir !== 'deep-loop-status') {
    test(`skill ${dir}: entry skills carry echo-suppression + safety boilerplate`, () => {
      const src = readFileSync(skillPath(dir), 'utf8');
      assert.match(src, /echo 금지|IMPORTANT/, `${dir} missing echo-suppression callout`);
      assert.match(src, /proposal-only|사람 승인|human/i, `${dir} missing external-action safety note`);
    });
  }
}

test('episode abandon must be fenced (mutatingFenced)', () => {
  assert.equal(mutatingFenced('node deep-loop.mjs episode abandon --id x --reason r --confirm'), false);   // fence 없음 → false
  assert.equal(mutatingFenced('node deep-loop.mjs episode abandon --id x --reason r --confirm --owner R --generation 1'), true);
});

test('deep-loop-workflow references exist', () => {
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md', 'hill-climbing.md'])
    assert.ok(existsSync(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r)), `missing reference ${r}`);
});

// Task 8: hill-climbing protocol reference — Tier 목록 전문 + 증거 계약 (a)~(f) + ledger append 규약.
test('hill-climbing reference: 존재 + Tier 목록 + 증거 계약 (a)~(f)', () => {
  const src = readFileSync(join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'hill-climbing.md'), 'utf8');
  for (const marker of ['Tier 1', 'Tier 2', 'recipes/*.json', 'recipes/automation/*.yml',
    'insights latest', 'falsification', 'hillclimb-ledger.json', '(e)', '(f)', 'append',
    'diff', '수정', '삭제', '재배열', 'git log']) {   // ledger 순수-append 계약 핵심어 (r1 codex S3)
    assert.ok(src.includes(marker), `hill-climbing.md missing marker: ${marker}`);
  }
  assert.ok(mutatingFenced(src), 'mutating commands must carry --owner/--generation');
  assert.ok(!violatesBoundary(src));
});

// Task 8: finish must emit insights (non-fatal on failure); init must read insights latest (read-only).
// Both must go through the kernel CLI — never parse/write .deep-loop/insights/ directly.
test('finish/init 스킬: insights CLI 경유만 (직접 파싱·쓰기 금지)', () => {
  for (const dir of ['deep-loop-finish', 'deep-loop']) {
    const src = readFileSync(skillPath(dir), 'utf8');
    // .deep-loop/insights/ 를 언급하는 명령 라인은 반드시 deep-loop.mjs insights 호출이어야 함
    const bad = src.split('\n').some(line =>
      /\.deep-loop\/insights\//.test(line) && !/deep-loop\.mjs/.test(line)
      && (/(?:^|\s)(?:cat|jq|head|tail)\b/.test(line) || /readFileSync|Read\(/.test(line) || />>?\s*\S*\.deep-loop\/insights\//.test(line)));
      // r1 opus S3: `>`는 \b 워드경계가 안 걸리므로 redirect 분기를 별도 패턴으로 — `> .deep-loop/insights/...` 미탐 방지
    assert.ok(!bad, `${dir}: direct insights file access`);
  }
  assert.ok(readFileSync(skillPath('deep-loop-finish'), 'utf8').includes('insights emit'));
  assert.ok(readFileSync(skillPath('deep-loop'), 'utf8').includes('insights latest'));
});

test('worktree-aware skills: action-keyed entry in continue; resume defers; handoff no entry; verify unchanged', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  // continue §1.5 must key entry on action.workstream_id (not blind active workstream pick)
  assert.match(cont, /action\.workstream_id/, 'continue §1.5 keys worktree entry by action.workstream_id — not blind active workstream pick');
  assert.ok(mutatingFenced(cont), 'continue fenced');
  const res = _rf(skillPath('deep-loop-resume'), 'utf8');
  assert.match(res, /(무결성|existsSync|경로.*확인|needs-human)/, 'resume verify unchanged');
  // resume §3.5 defers per-action worktree entry to /deep-loop-continue (avoids mis-routing in multi-parallel runs)
  assert.match(res, /단계 3\.5[\s\S]{0,300}위임/, 'resume §3.5 defers worktree entry to /deep-loop-continue (not pre-entering)');
  // handoff §1.5: kernel resolves root via findRoot; no file work → no worktree entry needed
  const hand = _rf(skillPath('deep-loop-handoff'), 'utf8');
  assert.match(hand, /단계 1\.5[\s\S]{0,200}(불필요|findRoot)/, 'handoff §1.5 documents no worktree entry needed (kernel resolves root via findRoot)');
  assert.ok(mutatingFenced(hand), 'handoff fenced');
});

// Codex r3 sf-4: SKILL.md + workflow references 의 *모든* mutating CLI 라인이 fence(--owner+--generation)를 갖는지 전역 검사.
// deep-loop-workflow 는 references 에 review dispatch/record(mutating)를 담으므로 여기서 함께 검증된다.
test('all skills + workflow references fence every mutating CLI line', () => {
  const files = SKILLS.map(([dir]) => skillPath(dir));
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md'])
    files.push(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r));
  for (const f of files) {
    if (!existsSync(f)) continue;
    assert.ok(mutatingFenced(readFileSync(f, 'utf8')), `${f} has an unfenced mutating CLI invocation`);
  }
});

// Task 12: visible respawn decision flow — string-presence checks (read+CLI only, 2-plane boundary).
test('continue + handoff Decide: detect-terminal subcommand documented', () => {
  for (const dir of ['deep-loop-continue', 'deep-loop-handoff']) {
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.ok(src.includes('detect-terminal'),
      `${dir} Decide step must reference the detect-terminal subcommand`);
  }
});

test('continue + handoff Decide: respawn --attended documented', () => {
  for (const dir of ['deep-loop-continue', 'deep-loop-handoff']) {
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.ok(src.includes('respawn'),
      `${dir} must reference the respawn subcommand`);
    assert.ok(src.includes('--attended'),
      `${dir} must reference the --attended flag for visible-session respawn`);
  }
});

test('continue + handoff Decide: fenced pause --mode preserve (R6-plan: --owner+--generation mandatory)', () => {
  for (const dir of ['deep-loop-continue', 'deep-loop-handoff']) {
    const src = readFileSync(skillPath(dir), 'utf8');
    assert.ok(src.includes('--mode preserve'),
      `${dir} must document pause --mode preserve for the legacy-interactive branch`);
    // R6-plan: handoff emit already moved lease to 'releasing'; unfenced pause exits 3 → stale takeover.
    // Assert the --mode preserve guidance carries BOTH --owner and --generation on the same line.
    const hasFencedPause = src.split('\n').some(
      l => l.includes('--mode preserve') && l.includes('--owner') && l.includes('--generation')
    );
    assert.ok(hasFencedPause,
      `${dir} pause --mode preserve must carry --owner and --generation on the same line (R6-plan)`);
  }
});

test('resume: recover --confirm documented as human escape hatch', () => {
  const src = readFileSync(skillPath('deep-loop-resume'), 'utf8');
  assert.ok(src.includes('recover --confirm'),
    'deep-loop-resume must document recover --confirm as the escape hatch for stuck preserve-paused/gate-blocked runs');
});

// Codex r6 CRITICAL: no-launcher else-branch must always route through respawn (gate-first) before preserve-pause.
// respawn returns gate-blocked (rollback+paused, skill must NOT re-pause) or no-launcher (gate passed, then preserve).
test('continue + handoff no-launcher else-branch: respawn before preserve-pause, gate-blocked/no-launcher branching', () => {
  for (const dir of ['deep-loop-continue', 'deep-loop-handoff']) {
    const src = readFileSync(skillPath(dir), 'utf8');
    // Must document gate-blocked outcome (respawn already paused — skill must NOT pause again).
    assert.ok(src.includes('gate-blocked'),
      `${dir}: no-launcher branch must handle respawn gate-blocked outcome`);
    // gate-blocked recovery: recover --confirm (documented escape hatch), not re-pause.
    assert.ok(src.includes('recover --confirm'),
      `${dir}: gate-blocked path must document recover --confirm (not re-pause)`);
    // Must document no-launcher outcome (gate passed but no auto-launcher — then preserve-pause).
    assert.ok(src.includes('no-launcher'),
      `${dir}: must reference no-launcher outcome from respawn`);
    // preserve-pause must be conditioned on no-launcher outcome:
    // 'no-launcher' substring must appear BEFORE '--mode preserve' in the text.
    const noLauncherIdx = src.lastIndexOf('no-launcher');
    const preserveIdx = src.lastIndexOf('--mode preserve');
    assert.ok(noLauncherIdx !== -1, `${dir}: must reference no-launcher outcome`);
    assert.ok(preserveIdx !== -1, `${dir}: must reference --mode preserve`);
    assert.ok(noLauncherIdx < preserveIdx,
      `${dir}: no-launcher outcome must appear before --mode preserve (preserve-pause conditioned on no-launcher, not before respawn gate)`);
  }
});

// Task 6: worktree-entry ordering constraints
// resume: integrity-verify (단계 3) MUST precede §3.5 deferral section
test('resume: ordering — integrity-verify step must precede §3.5 worktree-deferral section', () => {
  const res = readFileSync(skillPath('deep-loop-resume'), 'utf8');
  // '무결성' appears in §3 heading/body (path integrity check) — stable, won't move to §3.5
  const verifyIdx = res.indexOf('무결성');
  // '단계 3.5' is the section documenting that worktree entry is DEFERRED to /deep-loop-continue
  const deferIdx  = res.indexOf('단계 3.5');
  assert.ok(verifyIdx !== -1,
    'resume: integrity-verify marker (무결성) must exist in SKILL.md');
  assert.ok(deferIdx !== -1,
    'resume: §3.5 deferral section marker (단계 3.5) must exist in SKILL.md');
  assert.ok(verifyIdx < deferIdx,
    'resume: 무결성 verify step must appear BEFORE 단계 3.5 — verify first, then deferral note explains /deep-loop-continue handles per-action worktree entry');
});

// continue: worktree-entry (§1.5) MUST precede maker/checker dispatch (§2)
test('continue: worktree-entry ordering — §1.5 entry must precede §2 dispatch', () => {
  const cont = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  // '1.5' is the section number in the §1.5 heading (Active Worktree 진입)
  const entryIdx    = cont.indexOf('1.5');
  // '## 2.' is the dispatch/action-branch section header
  const dispatchIdx = cont.indexOf('## 2.');
  assert.ok(entryIdx !== -1,
    'continue: worktree-entry section (§1.5) must exist in SKILL.md');
  assert.ok(dispatchIdx !== -1,
    'continue: dispatch section (## 2.) must exist in SKILL.md');
  assert.ok(entryIdx < dispatchIdx,
    'continue: worktree-entry (§1.5) must appear BEFORE dispatch (§2) — file work must run in the correct worktree');
});

// Task 1.6 follow-up: fresh resume must use descriptor-bound root/run/runtime;
// only per-action worktree entry remains delegated to continue.
test('handoff-respawn resume contract uses descriptor root/run/runtime and delegates worktree routing', () => {
  const refPath = join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md');
  const src = readFileSync(refPath, 'utf8');
  assert.match(src, /Resume 흐름[\s\S]{0,800}--project-root "<canonical_project_root>"[\s\S]{0,240}--run-id <run_id>/,
    'resume flow must consume the descriptor canonical root and logical run id');
  assert.match(src, /lease acquire[^\n]*--runtime <claude\|codex>[^\n]*--project-root "<canonical_project_root>"[^\n]*--run-id <run_id>/,
    'resume lease acquisition must assert runtime and explicit root/run identity');
  assert.doesNotMatch(src, /--project-root[^\n]{0,100}(?:불필요|unnecessary)/i,
    'resume reference must not claim explicit --project-root is unnecessary');
  assert.match(src, /worktree[\s\S]{0,240}\/deep-loop-continue/,
    'per-action worktree routing must remain delegated to deep-loop-continue');
});

// FIX D: continue skill must document ORIG_ROOT-relative, worktree-prefixed artifact paths.
test('deep-loop-continue: artifact paths in record/dispatch examples are ORIG_ROOT-relative worktree-prefixed', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  // Must NOT have bare relative paths like 'path/to/artifact' or 'path/to/fix-output' in --artifacts examples
  assert.ok(!cont.includes('"path/to/artifact"'), 'bare "path/to/artifact" must be replaced with worktree-prefixed path');
  assert.ok(!cont.includes('"path/to/fix-output"'), 'bare "path/to/fix-output" must be replaced with worktree-prefixed path');
  // Must have worktree-prefixed artifact paths (.claude/worktrees/<slug>/... OR .worktrees/<slug>/...) — FIX J: generic convention
  assert.match(cont, /(?:\.claude\/worktrees|\.worktrees)\/[^\s"]*\/[^\s"]+/, 'artifact examples must use recorded worktree path (.claude/worktrees/<slug>/ or .worktrees/<slug>/) as prefix');
  // Must have explicit instruction about project-root-relative artifact paths (generic rule — FIX J)
  assert.match(cont, /(project.root|ORIG_ROOT|루트 기준|worktree.*접두|recorded.worktree)[\s\S]{0,400}artifact|artifact[\s\S]{0,400}(project.root|ORIG_ROOT|루트 기준|worktree.*접두|recorded.worktree)/i, 'must instruct project-root-relative artifact paths with recorded worktree prefix');
});

test('deep-loop-finish: proposal-only worktree cleanup + reconcile audit surface', () => {
  const s = _rf(skillPath('deep-loop-finish'), 'utf8');
  assert.match(s, /Worktree 사용 현황/, 'report section');
  assert.match(s, /(ExitWorktree|git worktree remove)/, 'native cleanup proposed');
  assert.match(s, /proposal-only|제안|사람 승인|human/i, 'cleanup proposal-only');
  assert.match(s, /(reconcile|audit|미기록|기록에 없는|고아)/, 'reconcile audit surface');
});

// FIX E: await_result must enter the worktree (it carries action.workstream_id)
test('deep-loop-continue §1.5: await_result is in the worktree-entry set (not skipped)', () => {
  const cont = _rf(skillPath('deep-loop-continue'), 'utf8');
  // The gating sentence must key on action.workstream_id PRESENCE, not a hardcoded type list
  // that excludes await_result. Verify await_result is explicitly mentioned as entering.
  assert.ok(
    cont.includes('await_result'),
    'continue §1.5 must mention await_result'
  );
  // await_result must NOT appear in the skip/건너뛴다 sentence
  const skipLine = cont.split('\n').find(l => /건너뛴다|skip/.test(l) && /await_result/.test(l));
  assert.ok(!skipLine, 'await_result must not appear in the skip sentence of §1.5');
  // The gating sentence must key on workstream_id presence (not an explicit list that omits await_result)
  assert.match(cont, /workstream_id[\s\S]{0,300}await_result|await_result[\s\S]{0,300}workstream_id/, 'await_result and workstream_id must be co-located in §1.5 gating text');
});

// FIX K: deep-loop-finish must write final-report to project.root-anchored absolute path.
// Bare relative Write(".deep-loop/runs/...") breaks when cwd is inside a worktree.
test('deep-loop-finish: final-report Write must be project.root-anchored (not bare relative)', () => {
  const s = _rf(skillPath('deep-loop-finish'), 'utf8');
  // Must instruct reading project.root from state before writing
  assert.match(s, /state get[\s\S]{0,80}--field[\s\S]{0,40}project\.root|project\.root[\s\S]{0,40}--field[\s\S]{0,40}state get/,
    'must read project.root from state (state get --field project.root) before writing final report');
  // Must NOT have a bare relative Write to .deep-loop/runs/.../final-report.md (without a project.root anchor).
  const bareWrite = s.split('\n').some(l =>
    /Write\s*\(/.test(l) &&
    /\.deep-loop\/runs\/[^"]*final-report\.md/.test(l) &&
    !/(project\.root|<project-root>|\$\{?PROJECT_ROOT\}?|\$\{?ROOT\}?)/.test(l)
  );
  assert.ok(!bareWrite, 'deep-loop-finish must not instruct a bare relative Write(".deep-loop/runs/...final-report.md"); must anchor to project.root');
  // Must use project.root in the Write call or nearby absolute path pattern
  assert.match(s, /(project\.root|<project-root>|\$PROJECT_ROOT|\$ROOT)[\s\S]{0,300}final-report\.md|final-report\.md[\s\S]{0,100}(project\.root|<project-root>|\$PROJECT_ROOT|\$ROOT)/,
    'final-report.md Write must reference project.root or <project-root>-anchored absolute path');
  // deep-wiki delegation args must also be anchored (not bare relative .deep-loop/...)
  const bareWikiArg = s.split('\n').some(l =>
    /wiki-ingest/.test(l) &&
    /args.*\.deep-loop\/runs/.test(l) &&
    !/(project\.root|<project-root>|\$\{?PROJECT_ROOT\}?|\$\{?ROOT\}?)/.test(l)
  );
  assert.ok(!bareWikiArg, 'deep-wiki wiki-ingest delegation must not use bare relative .deep-loop path; must anchor to project.root');
});

// FIX L: adapter read.path must be explicitly described as requiring TRANSFORMATION to worktree-prefixed form.
test('deep-loop §2-7: adapter read.path must be explicitly transformed to worktree-prefixed path (FIX L)', () => {
  const s = dlSkill();
  // Must explicitly state adapter read.path is TRANSFORMED/PREFIXED with the recorded worktree path.
  // Acceptable signals: 변환, TRANSFORM, transform, 접두(prefix), or worktree + prefix in close proximity to adapter read.path.
  assert.match(
    s,
    /adapter[\s\S]{0,300}(read\.path|read path)[\s\S]{0,300}(변환|TRANSFORM|transform|접두|prefix)|(변환|TRANSFORM|transform|접두|prefix)[\s\S]{0,200}adapter[\s\S]{0,200}(read\.path|read path)/i,
    'must explicitly instruct transformation of adapter read.path to worktree-prefixed form before passing to --artifacts'
  );
});

// FIX N: workstream new --worktree must record root-relative path, not $ORIG_ROOT absolute.
// git worktree add uses $ORIG_ROOT absolute (correct — git needs an absolute target); but the
// value RECORDED via workstream new must be root-relative (.claude/worktrees/<slug>) so that
// artifact prefixes are root-relative and pass episode.mjs containment (no absolute/.. paths).
test('deep-loop §2-6: workstream new records root-relative .claude/worktrees/<slug> (not $ORIG_ROOT absolute)', () => {
  const s = dlSkill();
  const joined = s.replace(/\\\n\s*/g, ' ');
  // workstream new and --worktree must appear on the same logical line after joining continuations
  const wsNewLine = joined.split('\n').find(l => /workstream\s+new/.test(l) && /--worktree/.test(l));
  assert.ok(wsNewLine, 'workstream new --worktree must appear in a joined logical command line');
  assert.ok(
    /--worktree\s+"?\.claude\/worktrees\//.test(wsNewLine),
    'workstream new --worktree must record root-relative .claude/worktrees/<slug> path (not $ORIG_ROOT absolute)'
  );
  assert.ok(
    !/--worktree\s+"?\$\{?ORIG_ROOT\}?\//.test(wsNewLine),
    'workstream new --worktree must NOT use $ORIG_ROOT absolute path for the recorded value'
  );
});

// FIX O: state get --field project.root emits JSON-encoded string with quotes (e.g. "/repo").
// Assigning that raw to a shell variable and using it as a path embeds literal quotes →
// final-report path is wrong → finish --status completed fails final-report-missing.
test('deep-loop-finish: project.root read must strip JSON quotes before use as filesystem path', () => {
  const s = _rf(skillPath('deep-loop-finish'), 'utf8');
  // Must document JSON quote-stripping (JSON.parse, tr -d, or sed) near the project.root read
  assert.match(s,
    /project\.root[\s\S]{0,400}(JSON\.parse|tr\s+-d\s+['"]|sed\b[^\n]*s[^\n]*")/,
    'deep-loop-finish must document JSON quote-stripping when reading project.root for filesystem path use (state get emits quoted JSON)'
  );
});

test('deep-loop-continue §1.5: project.root read must strip JSON quotes before filesystem path use', () => {
  const s = _rf(skillPath('deep-loop-continue'), 'utf8');
  // state get --field project.root emits JSON-encoded string with quotes; must document stripping
  assert.match(s,
    /project\.root[\s\S]{0,400}(JSON\.parse|tr\s+-d\s+['"]|sed\b[^\n]*s[^\n]*")/,
    'deep-loop-continue §1.5 must document JSON quote-stripping when reading project.root for path absolutization'
  );
});

// FIX G: deep-loop SKILL.md episode new --artifacts example must use worktree-prefixed paths
test('deep-loop §2-7: episode new --artifacts example uses worktree-prefixed paths', () => {
  const s = dlSkill();
  // Must NOT have bare path/to/... in --artifacts
  assert.ok(!s.includes('"path/to/expected-output.md"'), 'bare path/to/expected-output.md must be replaced with worktree-prefixed path in episode new example');
  // Must have worktree-prefixed expected-artifacts example (.claude/worktrees/ OR .worktrees/) — FIX J: generic convention
  assert.match(s, /--artifacts[\s\S]{0,200}(?:\.claude\/worktrees|\.worktrees)\//, '--artifacts example in episode new must use recorded worktree path (.claude/worktrees/<slug>/ or .worktrees/<slug>/) as prefix');
  // Must carry a note that expected artifacts and submitted artifacts use same ORIG_ROOT-relative worktree-prefixed paths
  assert.match(s, /(expected|episode new)[\s\S]{0,400}(ORIG_ROOT|worktree.*prefix|워크트리.*접두사|\.claude\/worktrees)[\s\S]{0,400}(episode record|submitted|동일)/, 'note that expected and submitted artifacts must use same ORIG_ROOT-relative worktree-prefixed paths');
});

// Task 8: Claude Desktop deeplink respawn — init opt-in offer + handoff/continue desktop branch wiring.
test('desktop skill wiring stays 2-plane (kernel CLI only)', () => {
  for (const dir of ['deep-loop', 'deep-loop-handoff', 'deep-loop-continue']) {
    const s = _rf(skillPath(dir), 'utf8');
    if (/spawn_style==='desktop'|offer-desktop|confirm-desktop/.test(s)) {
      assert.ok(!violatesBoundary(s), `${dir}/SKILL.md must not instruct a direct durable-state write (2-plane)`);
    }
  }
});

test('all three declared desktop skill paths branch to respawn --attended', () => {
  const files = [
    skillPath('deep-loop-handoff'),
    skillPath('deep-loop-continue'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ];
  for (const f of files) {
    const s = _rf(f, 'utf8');
    assert.match(s, /spawn_style==='desktop'[\s\S]*respawn[\s\S]*--attended/, `${f} missing desktop branch (spawn_style==='desktop' → respawn ... --attended)`);
  }
});

// Round-8 review Finding 1: the CONTINUE/HANDOFF unattended branch previously keyed off a bare
// non-tty check ("드라이버 마커 / DEEP_LOOP_UNATTENDED / non-tty"), inconsistent with the kernel's
// isHeadlessInvocation semantics and the init-skill fix that treats non-tty Desktop Code tabs as
// attended. A launcher=none attended non-tty session (desktop declined/suppressed) would fall into
// the do-nothing unattended branch after handoff emit — stranding the lease in 'releasing' with no
// respawn/preserve-pause. Fixed to key unattended ONLY off headless markers (isHeadlessInvocation:
// DEEP_LOOP_UNATTENDED/DEEP_LOOP_HEADLESS/driver entrypoint heuristic), never a bare tty check.
test('continue + handoff + handoff-respawn.md: unattended branch keys ONLY off headless markers, not non-tty', () => {
  const files = [
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ];
  for (const f of files) {
    const s = _rf(f, 'utf8');
    // The unattended branch heading/description must reference the kernel's isHeadlessInvocation
    // semantics (or the concrete headless markers it recognizes), not a bare tty check.
    assert.match(s, /isHeadlessInvocation|DEEP_LOOP_HEADLESS/,
      `${f}: unattended branch must reference isHeadlessInvocation/DEEP_LOOP_HEADLESS kernel markers`);
    // Must explicitly state tty/non-tty is NOT a trigger for the unattended branch (documents the
    // fix, guards against reintroducing the bare tty check).
    assert.match(s, /tty[\s\S]{0,80}(아니다|not a (signal|trigger))/i,
      `${f}: must explicitly document that non-tty alone is not an unattended signal`);
    // The unattended branch's own heading/description must NOT contain a bare "non-tty" trigger
    // token immediately inside its own parenthetical marker list (i.e. no regression to
    // "드라이버 마커 / DEEP_LOOP_UNATTENDED / non-tty" style bare-list phrasing).
    assert.ok(!/(?:드라이버 마커|explicit driver marker)\s*\/\s*`?DEEP_LOOP_UNATTENDED`?\s*(?:set)?\s*\/\s*non-tty/.test(s),
      `${f}: must not regress to the bare "driver marker / DEEP_LOOP_UNATTENDED / non-tty" unattended trigger list`);
  }
});

// Round-8 review Finding 1 (part 2): a launcher=none ATTENDED session (not a headless marker, not
// desktop) must route through respawn (gate-first) then preserve-pause on the no-launcher outcome —
// the existing else/manual path — never the do-nothing unattended branch. Verify structurally: the
// unattended-branch text block must appear BEFORE the else/no-launcher/preserve-pause block (so an
// attended non-tty session that isn't caught by the (now headless-marker-only) unattended check
// falls through to the manual respawn-gate → preserve-pause path documented later in the file),
// and the file must NOT describe the unattended branch as also covering launcher=none/attended cases.
test('continue + handoff + handoff-respawn.md: launcher=none attended routes to respawn/preserve-pause (manual), not a no-op', () => {
  const files = [
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ];
  for (const f of files) {
    const s = _rf(f, 'utf8');
    // else/manual branch (launcher=none / visible 아님 / legacy interactive) must exist and route
    // through respawn (gate) before any pause, exactly like the existing no-launcher-else assertions
    // elsewhere in this file — reconfirm no-launcher precedes --mode preserve.
    const noLauncherIdx = s.lastIndexOf('no-launcher');
    const preserveIdx = s.lastIndexOf('--mode preserve');
    assert.ok(noLauncherIdx !== -1 && preserveIdx !== -1 && noLauncherIdx < preserveIdx,
      `${f}: launcher=none attended path must reach the no-launcher → --mode preserve manual path (not the unattended do-nothing branch)`);
    // The unattended branch must not itself instruct pause/preserve or claim it is a no-op for
    // launcher=none — it defers entirely to the driver.
    const unattendedHeadingIdx = s.search(/unattended|Unattended/);
    assert.ok(unattendedHeadingIdx !== -1, `${f}: unattended branch heading must exist`);
  }
});

// Round-9 review Finding: the CONTINUE/HANDOFF/handoff-respawn.md desktop branch (spawn_style==='desktop'
// → respawn --attended) previously preceded the unattended/headless-marker branch. A run that opted into
// desktop but is later executing under a headless invocation (DEEP_LOOP_UNATTENDED / headless entrypoint)
// would take the desktop branch and call `respawn --attended` directly from the skill — bypassing the
// drive-headless wrapper that records measured usage, undermining the budget/fail-closed model (invariant
// #6 at the skill layer). Fixed by reordering so the unattended/headless-marker branch is evaluated BEFORE
// the desktop branch, mirroring the kernel's resolveSpawnMode precedence (headless > desktop > visible >
// interactive). Verify structurally: the unattended/headless-marker branch text must appear BEFORE the
// spawn_style==='desktop' branch text in each of the three files.
test('continue + handoff + handoff-respawn.md: unattended/headless branch precedes the desktop branch (kernel precedence: headless > desktop)', () => {
  const files = [
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ];
  for (const f of files) {
    const s = _rf(f, 'utf8');
    // First occurrence of the unattended/headless-marker branch heading (isHeadlessInvocation reference)
    // must come before the first occurrence of the spawn_style==='desktop' branch condition.
    const unattendedIdx = s.search(/isHeadlessInvocation/);
    const desktopIdx = s.indexOf(`spawn_style==='desktop'`);
    assert.ok(unattendedIdx !== -1, `${f}: unattended/headless branch (isHeadlessInvocation) must exist`);
    assert.ok(desktopIdx !== -1, `${f}: desktop branch (spawn_style==='desktop') must exist`);
    assert.ok(unattendedIdx < desktopIdx,
      `${f}: unattended/headless-marker branch must precede the spawn_style==='desktop' branch (kernel resolveSpawnMode: headless preempts desktop, invariant #6) — got unattendedIdx=${unattendedIdx}, desktopIdx=${desktopIdx}`);
  }
});

test('deep-loop SKILL.md: init opt-in offer gated on launcher===none + attended + darwin/win32', () => {
  const s = dlSkill();
  assert.match(s, /detect-terminal/, 'must run detect-terminal before offering desktop opt-in');
  assert.match(s, /launcher\s*===?\s*'none'/, "must gate on session_spawn.launcher === 'none'");
  assert.match(s, /attended/, 'must gate on the session being attended (not headless)');
  assert.match(s, /darwin/, 'must gate on process.platform darwin');
  assert.match(s, /win32/, 'must gate on process.platform win32');
  assert.match(s, /spawn-style offer-desktop/, 'must call spawn-style offer-desktop');
  assert.match(s, /AskUserQuestion/, 'must present the opt-in question via AskUserQuestion');
  assert.match(s, /spawn-style confirm-desktop/, 'must call spawn-style confirm-desktop on yes');
  assert.match(s, /spawn-style decline-desktop/, 'must call spawn-style decline-desktop on no');
  // both offer/confirm/decline lines must carry the fence (kernel requires it; not enforced by mutatingFenced's MUTATING_SUB list)
  for (const line of s.split('\n').filter(l => /spawn-style\s+(offer|confirm|decline)-desktop/.test(l))) {
    assert.ok(/--owner\b/.test(line) && /--generation\b/.test(line), `spawn-style line missing fence flags: ${line}`);
  }
});

test('runtime-facing launcher recovery docs diagnose read-only, require explicit human approval, then re-detect', () => {
  const files = [
    skillPath('deep-loop'),
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ];
  for (const file of files) {
    const body = _rf(file, 'utf8');
    assert.match(body, /windows-terminal-unverified/, `${file}: WT fail-closed reason must branch to recovery`);
    assert.match(body, /powershell-unverified/, `${file}: PowerShell fail-closed reason must branch to recovery`);
    const diagnose = body.indexOf('launcher-executable diagnose');
    const approve = body.indexOf('launcher-executable approve');
    const redetect = body.indexOf('detect-terminal', approve);
    assert.ok(diagnose !== -1 && approve > diagnose && redetect > approve,
      `${file}: required order is diagnose -> explicit approve -> detect-terminal`);
    assert.match(body.slice(Math.max(0, diagnose - 500), approve), /read-only|읽기 전용/i,
      `${file}: diagnosis must be described as read-only`);
    assert.match(body.slice(Math.max(0, approve - 900), approve + 500), /AskUserQuestion|explicit human|명시적.*사람/i,
      `${file}: approval must be offered to a human, never inferred`);
    assert.match(body.slice(Math.max(0, approve - 900), approve + 500), /auto-confirm|자동.*confirm|자동 확인/i,
      `${file}: docs must explicitly prohibit auto-confirmation`);
    const approvalLines = body.split('\n').filter(line => /launcher-executable\s+approve/.test(line));
    assert.ok(approvalLines.length > 0, `${file}: approval command example is required`);
    for (const line of approvalLines) {
      assert.match(line, /--actor\s+human/);
      assert.match(line, /--confirm\b/);
      assert.match(line, /--owner\b/);
      assert.match(line, /--generation\b/);
    }
    assert.match(body, /node "DEEP_LOOP_ROOT\/scripts\/deep-loop\.mjs"/,
      `${file}: launcher commands must use the canonical root placeholder`);
  }
});

test('launcher approval recovery runs before handoff emit enters the releasing lease', () => {
  const files = [
    skillPath('deep-loop-continue'),
    skillPath('deep-loop-handoff'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
  ];
  for (const file of files) {
    const body = _rf(file, 'utf8');
    const approval = body.indexOf('launcher-executable approve');
    const emit = body.indexOf('node "DEEP_LOOP_ROOT/scripts/deep-loop.mjs" handoff emit');
    assert.ok(approval !== -1 && emit !== -1 && approval < emit,
      `${file}: human launcher approval must complete before handoff emit changes the lease to releasing`);
    assert.match(body.slice(Math.max(0, approval - 1400), emit), /handoff emit[\s\S]{0,240}(?:before|이전|전)/i,
      `${file}: ordering rationale must explicitly name the pre-emit fence boundary`);
  }
});

test('continue/handoff/resume skills + shared reference wire session-profile refresh (WS1)', () => {
  const paths = [
    '../skills/deep-loop-continue/SKILL.md',
    '../skills/deep-loop-handoff/SKILL.md',
    '../skills/deep-loop-resume/SKILL.md',
    '../skills/deep-loop-workflow/references/handoff-respawn.md',
  ];
  for (const p of paths) {
    const body = readFileSync(new URL(p, import.meta.url), 'utf8');
    assert.match(body, /session-profile set/, `${p} should reference session-profile set`);
  }
});

test('deep-loop init skill observes + seeds session model/effort into init-run (WS1)', () => {
  const body = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');
  assert.match(body, /CLAUDE_EFFORT/, 'init skill observes CLAUDE_EFFORT');
  assert.match(body, /init-run[\s\S]*--model[\s\S]*--effort/, 'init skill threads --model/--effort into init-run');
});

test('runtime-facing skills assert runtime and carry explicit resume root/run identity', () => {
  const entry = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');
  assert.match(entry, /init-run[\s\S]{0,500}--runtime\s+<claude\|codex>/, 'new runs must record the asserted host runtime');

  const resume = readFileSync(new URL('../skills/deep-loop-resume/SKILL.md', import.meta.url), 'utf8');
  assert.match(resume, /\$deep-loop:deep-loop-resume/, 'Codex resume must use the qualified dollar skill token');
  assert.match(resume, /--project-root\s+"<canonical_project_root>"/, 'resume must accept the canonical project root from the descriptor');
  assert.match(resume, /--run-id\s+<run_id>/, 'resume must accept the explicit logical run id from the descriptor');
  const acquire = resume.split('\n').find((line) => /lease acquire/.test(line)) || '';
  assert.match(acquire, /--runtime\s+<claude\|codex>/, 'lease acquisition must assert the actual host runtime');
  assert.match(acquire, /--project-root\s+"<canonical_project_root>"/);
  assert.match(acquire, /--run-id\s+<run_id>/);
});

test('handoff execution docs preserve runtime-correct resume tokens and current Codex transport boundaries', () => {
  const paths = [
    '../skills/deep-loop-continue/SKILL.md',
    '../skills/deep-loop-handoff/SKILL.md',
    '../skills/deep-loop-workflow/references/handoff-respawn.md',
  ];
  for (const path of paths) {
    const body = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(body, /\/deep-loop-resume/, `${path} must retain the Claude resume token`);
    assert.match(body, /\$deep-loop:deep-loop-resume/, `${path} must document the Codex resume token`);
    assert.match(body, /codex-transport-not-activated/, `${path} must retain the fail-closed reason for unsupported Codex paths`);
    assert.match(body, /native Windows|네이티브 Windows/i,
      `${path} must distinguish the activated native-Windows Codex path`);
    assert.match(body, /macOS\/Linux[\s\S]{0,360}cmux/i,
      `${path} must document approved Codex visible cmux continuation on POSIX`);
    assert.match(body, /macOS[\s\S]{0,360}(?:iTerm2|Terminal\.app)/i,
      `${path} must bind Darwin Codex continuation to the detected Apple terminal`);
    assert.match(body, /runtime-identity-unavailable/,
      `${path} must name the missing approved-runtime fail-closed reason`);
    assert.match(body, /trusted|승인된|검증된/i,
      `${path} must bind native-Windows transport to trusted executable identities`);
    assert.match(body, /Codex App[\s\S]{0,240}(?:manual|수동)/i,
      `${path} must keep Codex App new-task continuation manual`);
    assert.doesNotMatch(body, /visible\/headless\/App 자동 process transport는 아직 활성화하지 않는다/,
      `${path} must not retain the obsolete blanket Slice 1 transport claim`);
  }
});

test('runtime-facing headless docs describe both measured drivers without a cross-runtime fallback', () => {
  const shared = readFileSync(
    new URL('../skills/deep-loop-workflow/references/handoff-respawn.md', import.meta.url),
    'utf8',
  );
  const headlessStart = shared.indexOf('### Headless /');
  const headlessEnd = shared.indexOf('## Respawn 게이트', headlessStart);
  assert.ok(headlessStart !== -1 && headlessEnd > headlessStart,
    'shared reference must retain a bounded later Headless section');
  const headless = shared.slice(headlessStart, headlessEnd);

  const documents = [
    ['shared handoff reference', headless],
    ['English README', readFileSync(new URL('../README.md', import.meta.url), 'utf8')],
    ['Korean README', readFileSync(new URL('../README.ko.md', import.meta.url), 'utf8')],
    ['CLAUDE project guide', readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8')],
  ];
  for (const [name, body] of documents) {
    assert.match(body, /Claude[\s\S]{0,500}claude -p/i,
      `${name}: Claude headless driver must remain explicit`);
    assert.match(body, /Codex[\s\S]{0,500}codex exec --json/i,
      `${name}: measured Codex JSONL driver must be explicit`);
    assert.match(body, /JSONL/i, `${name}: Codex transport must name its JSONL accounting format`);
    assert.match(body, /(?:no cross-runtime fallback|교차 런타임[^\n]{0,120}(?:fallback|폴백)[^\n]{0,80}(?:없|금지|하지))/i,
      `${name}: docs must prohibit fallback to the other runtime`);
  }

  assert.doesNotMatch(documents[1][1], /headless driver wraps `claude -p`/i,
    'English README must not describe the runtime-selected driver as Claude-only');
  assert.doesNotMatch(documents[2][1], /무인 모드에서는 headless respawn도 트리거/i,
    'Korean README must keep PreCompact emit-only');
  assert.match(documents[2][1], /PreCompact[\s\S]{0,300}(?:emit-only|방출 전용)[\s\S]{0,300}drive-headless/i,
    'Korean README must assign unattended continuation to the measured driver');
});

test('runtime-neutral adapter reference routes exact skill/agent/blocked descriptors and capability flag', () => {
  const body = readFileSync(new URL('../skills/deep-loop-workflow/references/adapters.md', import.meta.url), 'utf8');
  assert.match(body, /dispatch\.kind = "skill"/, 'maker descriptor example must use production kind=skill');
  assert.match(body, /dispatch\.kind === 'skill'/, 'maker branch must route production kind=skill');
  assert.doesNotMatch(body, /invoke_skill/, 'stale invoke_skill must not remain active in the reference');
  assert.match(body, /Claude[\s\S]{0,240}Skill\(/);
  assert.match(body, /Codex[\s\S]{0,240}\$<descriptor\.skill>/);
  assert.match(body, /checker\.kind === 'skill'[\s\S]{0,260}(?:independent|독립)/,
    'skill checker must run in an independent session');
  assert.match(body, /checker\.kind === 'agent'[\s\S]{0,260}(?:fresh|새)[\s\S]{0,160}code-reviewer/,
    'agent checker must spawn a fresh code-reviewer subagent');
  assert.match(body, /checker\.kind === 'blocked'[\s\S]{0,260}needs-human[\s\S]{0,180}(?:proof|증명)/,
    'blocked checker must route needs-human without proof');
  assert.match(body, /--independent-subagent[\s\S]{0,260}(?:실제로 있을 때만|only when)/,
    'independent-subagent assertion must be capability-gated');
  assert.match(body, /(?:없으면|without)[^\n]{0,180}(?:전달하지|omit)/,
    'reference must omit the flag when cooperative capability is absent');
});

test('checker routing contract is explicit, mutually exclusive, and closes every independent execution path', () => {
  const adapters = readFileSync(new URL('../skills/deep-loop-workflow/references/adapters.md', import.meta.url), 'utf8');
  const cont = readFileSync(new URL('../skills/deep-loop-continue/SKILL.md', import.meta.url), 'utf8');

  assert.match(adapters, /상호 배타|mutually exclusive/i, 'checker routes must be mutually exclusive');

  const cooperative = adapters.match(/### Route A[\s\S]*?(?=\n### Route B)/)?.[0] || '';
  assert.match(cooperative, /cooperative[\s\S]{0,240}(?:실제로 사용 가능|actually available)/i);
  assert.match(cooperative, /--independent-subagent/);
  assert.match(cooperative, /fresh `?code-reviewer`?[\s\S]{0,240}(?:host tool|호스트 도구)/i);
  assert.ok(cooperative.indexOf('실제로 사용 가능') < cooperative.indexOf('review dispatch'),
    'cooperative capability must be asserted before review dispatch');

  const unattended = adapters.match(/### Route B[\s\S]*?(?=\n### Route C)/)?.[0] || '';
  assert.match(unattended, /Codex[\s\S]{0,160}unattended[\s\S]{0,300}host-owned/i);
  assert.match(unattended, /isolated[\s\S]{0,120}read-only[\s\S]{0,180}(?:second|두 번째) `?codex exec`?/i);
  assert.match(unattended, /claim[\s\S]{0,240}import[\s\S]{0,240}accounting/i);
  assert.match(unattended, /execution skill[\s\S]{0,180}review record[\s\S]{0,120}(?:않|never)/i,
    'host-owned checker path must not be recorded by the execution skill');

  const interactive = adapters.match(/### Route C[\s\S]*?(?=\n### Route D)/)?.[0] || '';
  assert.match(interactive, /interactive[\s\S]{0,260}(?:distinct|별도)[\s\S]{0,160}(?:fresh session|fresh task|새 세션|새 task)/i);
  assert.match(interactive, /reviewed worktree|리뷰 대상 worktree/i);
  assert.match(interactive, /Claude[\s\S]{0,180}Skill\([\s\S]{0,300}Codex[\s\S]{0,180}\$<checker\.skill>/i);
  assert.match(interactive, /Codex[\s\S]{0,260}(?:manual|수동)[\s\S]{0,220}(?:task|세션)/i);
  assert.match(interactive, /contained report|containment[\s\S]{0,160}report|포함[\s\S]{0,160}리포트/i);
  assert.match(interactive, /original execution session|원래 execution session/i);
  assert.match(interactive, /same-task|같은 task[\s\S]{0,200}\$<checker\.skill>[\s\S]{0,180}(?:proof|증명)[\s\S]{0,80}(?:금지|아님)/i);

  const blocked = adapters.match(/### Route D[\s\S]*?(?=\n### Verdict 기록)/)?.[0] || '';
  assert.match(blocked, /needs-human/);
  assert.match(blocked, /review dispatch[\s\S]{0,160}(?:하지|금지|never)/i);
  assert.match(blocked, /review record[\s\S]{0,160}(?:하지|금지|never)/i);
  assert.match(blocked, /fabricat|날조|proof[\s\S]{0,80}(?:만들지|금지)/i);
  assert.match(blocked, /checker\.kind === 'agent'[\s\S]{0,260}cooperative[\s\S]{0,220}(?:before|이전|전에)[\s\S]{0,180}review dispatch/i);

  const branch = cont.indexOf('상호 배타 checker routing');
  const record = cont.indexOf('review record', branch);
  assert.ok(branch !== -1 && record > branch,
    'continue must defer to the checker routing contract before review record');
});

test('review strategy separates durable reviewer enums from host invocation skill ids', () => {
  const strategy = readFileSync(new URL('../skills/deep-loop-workflow/references/review-strategy.md', import.meta.url), 'utf8');
  const entry = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');

  for (const [name, body] of [['review strategy', strategy], ['entry skill', entry]]) {
    assert.match(body, /deep-review[\s\S]{0,500}durable[\s\S]{0,260}"reviewer"\s*:\s*"deep-review-loop"/i,
      `${name}: deep-review selection must store the accepted durable enum`);
    assert.match(body, /subagent[\s\S]{0,500}durable[\s\S]{0,260}"reviewer"\s*:\s*"subagent-checker"/i,
      `${name}: cooperative subagent selection must store subagent-checker`);
    assert.match(body, /descriptor[\s\S]{0,300}deep-review:deep-review-loop/i,
      `${name}: only the returned descriptor uses the qualified invocation id`);
    assert.doesNotMatch(body, /"reviewer"\s*:\s*"deep-review:deep-review-loop"/,
      `${name}: qualified invocation id must never enter durable review JSON`);
  }
});

test('init review JSON is one exact cross-POSIX/PowerShell single-quoted argv argument', () => {
  const entry = readFileSync(new URL('../skills/deep-loop/SKILL.md', import.meta.url), 'utf8');
  const initCommands = kernelCommandLines(entry).filter((line) => /\binit-run\b/.test(line));
  assert.ok(initCommands.length >= 3, 'all documented model/effort variants remain explicit');
  for (const line of initCommands) {
    assert.match(line, /--review\s+'<review_json_compact>'(?:\s|$)/,
      `init-run review JSON must be one single-quoted argv argument: ${line}`);
    assert.doesNotMatch(line, /--review\s+"<review_json_compact>"/);
  }
  assert.match(entry, /<review_json_compact>[\s\S]{0,360}(?:compact JSON|압축 JSON)[\s\S]{0,240}(?:JSON double quotes|JSON 이중 따옴표)/i,
    'placeholder substitution must preserve JSON double quotes inside the single-quoted argument');
});

test('portable command contract: free-form reason placeholders remain one argv value', () => {
  for (const file of EXECUTION_DOCS) {
    for (const line of kernelCommandLines(readFileSync(file, 'utf8')).filter((candidate) => /--reason\b/.test(candidate))) {
      assert.match(line, /--reason\s+"[^"]*<[^>]+>[^"]*"(?:\s|$)/,
        `${file}: free-form reason placeholder must be double-quoted: ${line}`);
    }
  }
});

test('lease-fenced argv keeps the immutable logical run id separate from the current lease owner', () => {
  for (const file of EXECUTION_DOCS) {
    const body = readFileSync(file, 'utf8');
    assert.doesNotMatch(body, /--owner\s+<run_id>/,
      `${file}: logical run id must never be used as the lease owner`);

    for (const line of kernelCommandLines(body).filter((candidate) => /--owner\b/.test(candidate))) {
      assert.match(line, /--run-id\s+<run_id>/,
        `${file}: every fenced command must retain the immutable logical run id: ${line}`);
      if (/\blease acquire\b/.test(line)) {
        assert.match(line, /--owner\s+<child_run_id>/,
          `${file}: lease acquire alone uses the reserved child owner: ${line}`);
        assert.match(line, /--generation\s+<new_generation>/,
          `${file}: lease acquire uses the requested next generation: ${line}`);
      } else {
        assert.match(line, /--owner\s+<owner_run_id>/,
          `${file}: non-acquire commands use the freshly read lease owner: ${line}`);
        assert.match(line, /--generation\s+<(?:generation|n)>/,
          `${file}: non-acquire commands use the current lease generation placeholder: ${line}`);
      }
    }
  }
});

test('entry, resume, and continue preserve logical identity across lease ownership transitions', () => {
  const entry = readFileSync(skillPath('deep-loop'), 'utf8');
  assert.match(entry, /<run_id>[\s\S]{0,240}(?:logical|논리)[\s\S]{0,160}(?:immutable|불변)/i,
    'entry must define run_id as the immutable logical loop id');
  assert.match(entry, /<owner_run_id>\s*=\s*<run_id>[\s\S]{0,120}<generation>\s*=\s*1/,
    'after init the initial owner equals, but remains distinct from, the logical run id');

  const resume = readFileSync(skillPath('deep-loop-resume'), 'utf8');
  const acquire = kernelCommandLines(resume).find((line) => /\blease acquire\b/.test(line)) || '';
  assert.match(acquire, /--owner\s+<child_run_id>[\s\S]*--run-id\s+<run_id>/,
    'lease acquire must bind the reserved child to the immutable logical run');
  assert.match(resume, /<owner_run_id>\s*=\s*<child_run_id>[\s\S]{0,160}<generation>\s*=\s*<new_generation>/,
    'successful acquire must promote the child and returned generation to current fence variables');
  const postAcquire = resume.slice(resume.indexOf('## 단계 2.5'));
  for (const line of kernelCommandLines(postAcquire).filter((candidate) => /--owner\b/.test(candidate))) {
    assert.match(line, /--owner\s+<owner_run_id>/,
      `post-acquire resume command must use current owner_run_id: ${line}`);
    assert.match(line, /--run-id\s+<run_id>/,
      `post-acquire resume command must preserve logical run_id: ${line}`);
  }

  const cont = readFileSync(skillPath('deep-loop-continue'), 'utf8');
  assert.match(cont, /<run_id>[\s\S]{0,240}(?:logical|논리)[\s\S]{0,160}(?:immutable|불변)/i,
    'continue must preserve the descriptor/current-run logical id');
  assert.match(cont, /<owner_run_id>\s*=\s*(?:`)?lease\.owner_run_id(?:`)?[\s\S]{0,160}<generation>\s*=\s*(?:`)?lease\.generation(?:`)?/,
    'continue must bind fence variables from the freshly read lease');
  assert.doesNotMatch(cont, /(?:<run_id>|(?<!owner_)run_id)(?:`)?\s*=\s*(?:`)?lease\.owner_run_id(?:`)?/,
    'continue must never rebind the logical run id to the session owner');
});

test('mutation entry skills and shared references source fresh fence identity without conflating state keys', () => {
  const freshLeaseSkills = [
    'deep-loop-ack',
    'deep-loop-continue',
    'deep-loop-discover',
    'deep-loop-finish',
    'deep-loop-handoff',
    'deep-loop-status',
    'deep-loop-triage',
  ];
  for (const dir of freshLeaseSkills) {
    const body = readFileSync(skillPath(dir), 'utf8');
    const leaseRead = body.indexOf('state get --field session_chain.lease');
    const firstFencedCommand = kernelCommandLines(body).findIndex((line) => /--owner\b/.test(line));
    const firstFencedOffset = firstFencedCommand === -1
      ? -1
      : body.indexOf(kernelCommandLines(body)[firstFencedCommand]);
    assert.ok(leaseRead !== -1 && firstFencedOffset !== -1 && leaseRead < firstFencedOffset,
      `${dir}: read session_chain.lease before the first fenced mutation`);
    assert.match(body, /<owner_run_id>[\s\S]{0,240}session_chain\.lease\.owner_run_id/,
      `${dir}: owner_run_id must come from the fresh lease state`);
    assert.match(body, /<generation>[\s\S]{0,240}session_chain\.lease\.generation/,
      `${dir}: generation must come from the fresh lease state`);
  }

  const sharedDocs = [
    skillPath('deep-loop-workflow'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'adapters.md'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'handoff-respawn.md'),
    join(ROOT, 'skills', 'deep-loop-workflow', 'references', 'hill-climbing.md'),
  ];
  for (const file of sharedDocs) {
    const body = readFileSync(file, 'utf8');
    assert.match(body, /<run_id>[\s\S]{0,240}(?:logical|논리)[\s\S]{0,160}(?:immutable|불변)/i,
      `${file}: shared contract must name immutable logical run identity`);
    assert.match(body, /<owner_run_id>[\s\S]{0,240}session_chain\.lease\.owner_run_id/,
      `${file}: shared contract must source the current owner from lease state`);
    assert.match(body, /<generation>[\s\S]{0,240}session_chain\.lease\.generation/,
      `${file}: shared contract must source the current generation from lease state`);
  }
});

test('deep-loop-compact exposes only explicit prepare and restore modes with public fenced checkpoint routes', () => {
  const body = readFileSync(skillPath('deep-loop-compact'), 'utf8');
  assert.match(body, /\/deep-loop-compact prepare\|restore/);
  assert.match(body, /\$deep-loop:deep-loop-compact prepare\|restore/);
  assert.match(body, /trusted (?:PreCompact|host context)[\s\S]{0,240}prepare/i);
  assert.match(body, /trusted (?:SessionStart|host context)[\s\S]{0,240}restore/i);
  assert.match(body, /checkpoint presence[\s\S]{0,160}(?:never|must not)[\s\S]{0,120}(?:phase|mode)/i);
  assert.match(body, /missing[\s\S]{0,120}unknown[\s\S]{0,160}reject/i);

  const prepare = body.match(/## Prepare([\s\S]*?)## Restore/i)?.[1] ?? '';
  assert.match(prepare, /state get --field session_chain\.lease/);
  assert.match(prepare, /state get --field session_chain\.sessions/);
  assert.match(prepare, /checkpoint emit[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--runtime <claude\|codex>/);
  assert.match(prepare, /Claude[\s\S]{0,160}\/compact <focus>/);
  assert.match(prepare, /Codex[\s\S]{0,160}`\/compact`/);
  assert.doesNotMatch(prepare, /Codex:[^\n]*\/compact <focus>/);
  assert.match(prepare, /(?:print|출력)[\s\S]{0,160}(?:never execute|실행하지)/i);

  const restore = body.match(/## Restore([\s\S]*)/i)?.[1] ?? '';
  assert.match(restore, /checkpoint inspect --json/);
  assert.match(restore, /checkpoint restore[^\n]*--checkpoint <checkpoint_rel>[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--runtime <claude\|codex>[^\n]*--json/);
  assert.match(restore, /\/deep-loop-continue/);
  assert.match(restore, /\$deep-loop:deep-loop-continue/);
  assert.match(restore, /same (?:owner )?session|동일 owner 세션/i);
  assert.match(restore, /provider-evidence-mismatch[\s\S]{0,300}do not retry without trusted evidence/i);
  assert.match(restore, /<pause_reason>[\s\S]{0,80}exactly[\s\S]{0,80}host-session-lost/);
  assert.match(restore, /pause[^\n]*--owner <owner_run_id>[^\n]*--generation <generation>[^\n]*--mode preserve[^\n]*--reason "<pause_reason>"/);
  assert.match(restore, /host resume/i);
  assert.match(restore, /missing checkpoint[\s\S]{0,500}fresh[\s\S]{0,300}same owner[\s\S]{0,300}open bound Workstream affinity/i);
  assert.doesNotMatch(body, /\/deep-loop-resume/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+lease acquire/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+handoff emit/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+respawn/);
  assert.doesNotMatch(body, /deep-loop\.mjs"\s+(?:finish|workstream terminal)/);
});

// Task 9 (spec §8.2): 게이트-크리티컬 마커 — 위치-독립 '존재' 단언, 삭제-회귀만 결정론 방어.
// 마커 선정 기준: budget/breaker/comprehension 검사 지시, fence 플래그(--owner/--generation/--expect-generation),
// human-only confirm(--confirm/--actor human/recover --confirm), proposal-only 선언 등 "게이트 의미"를 담은
// 표현만 채택한다 — 테스트를 통과시키기 위한 임의 토큰은 배제(구현 주의 준수).
// 잡는 것은 **삭제**뿐이다: 마커 문자열이 남아 있으면 그 옆의 지시문이 약화·반전되어도 이 존재-검사는 통과한다.
// 의미 반전 탐지는 hill-climb checker 계약 (e)(적대적 diff 리뷰) + 사람 머지 리뷰의 몫이다 — overclaim 금지.
const GATE_MARKERS = {
  'deep-loop-continue': ['budget', 'breaker', 'comprehension', 'gate.allowed', '--confirm'],
  'deep-loop-handoff': ['handoff emit', '--owner', 'gate-blocked', 'recover --confirm', 'isHeadlessInvocation'],
  'deep-loop-resume': ['lease acquire', '--expect-generation', 'recover --confirm', 'needs-human'],
  'deep-loop-ack': ['--actor human', '--confirm', 'CONFIRM_REQUIRED', 'ACK_REJECTED'],
  'deep-loop-discover': ['state patch', '--owner', '--generation', 'debt_ratio'],
  'deep-loop-finish': ['proof', '--confirm', 'FINISH_PROOF_UNMET', 'proposal-only'],
  'deep-loop': ['proposal-only', 'AskUserQuestion', 'fail-closed', 'recipe_override_auth'],
};
for (const [dir, markers] of Object.entries(GATE_MARKERS)) {
  test(`gate-critical markers present: ${dir}`, () => {
    const src = readFileSync(skillPath(dir), 'utf8');
    for (const m of markers) assert.ok(src.includes(m), `${dir}/SKILL.md lost gate marker: ${m}`);
  });
}

// ── impl-R3 🟡B: finish의 hill-climb 제안 명령 goal에 candidate id 원문을 넣지 않는다 —
// id의 "fix"/"implement" 등이 다른 recipe 트리거와 substring 충돌해 비결정 라우팅이 된다 ───
test('deep-loop-finish: hill-climb 제안 명령은 candidate id 없는 고정 문구다', () => {
  const src = readFileSync(skillPath('deep-loop-finish'), 'utf8');
  assert.ok(!src.includes('하네스 개선: <'), 'goal 템플릿에 candidate id 자리표시자가 남아 있음');
  assert.ok(src.includes('/deep-loop "하네스 개선"'), '고정 문구 제안 명령이 없음');
});

// ── Phase6 ITEM-3: r3 fix 57b8364가 finish 스킬의 제안 명령을 고정 문구로 바꿨지만 계약 문서
// (hill-climbing.md:128)에 콜론-템플릿 형태가 남아 SSOT 불일치가 있었다 — skills/ 전역에서
// 회귀를 결정론적으로 방어한다(위치 무관, 어느 .md 파일이든 이 패턴이 재도입되면 실패) ───
test('skills/ 전역: hill-climb 제안 명령에 candidate id 콜론-템플릿 형태("하네스 개선: )가 남아있지 않다', () => {
  const files = walkMdFiles(join(ROOT, 'skills'));
  assert.ok(files.length > 0, 'skills/ 하위 .md 파일 탐색 실패(회귀 테스트가 무의미해짐)');
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!src.includes('"하네스 개선:'),
      `${f}: candidate id 콜론-템플릿("하네스 개선:) 잔존 — 고정 문구 /deep-loop "하네스 개선" 로 동기화되어야 함`);
  }
});

test('continue SKILL: compact-in-place does not rotate on cap alone (advice display only)', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  assert.ok(md.includes('advice'), 'advice 필드 처리 지시 필요');
  assert.ok(md.includes('compact-in-place'), '정책 분기 지시 필요');
  assert.ok(/compact-in-place[^\n]*rotate하지 않는다|cap 도달만으로 rotate하지 않는다/.test(md));
});
test('continue SKILL: milestone rotation gated on unconsumed_milestones', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  assert.ok(md.includes('unconsumed_milestones'));
});
test('continue SKILL: §0.5 covers reserved (finalization) in addition to emitted/spawned', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  const s = md.split('## 0.5.')[1] ?? '';
  assert.ok(/handoff emit[\s\S]*reserved-finalization/.test(s.slice(0, 1500)),
    '§0.5 must instruct handoff emit → reserved-finalization');
});
test('continue SKILL: post-compact comprehension check present', () => {
  const md = readFileSync('skills/deep-loop-continue/SKILL.md', 'utf8');
  assert.ok(md.includes('comprehension') && md.includes('2회'));
});
