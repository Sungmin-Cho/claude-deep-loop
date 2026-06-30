import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillPath = (dir) => join(ROOT, 'skills', dir, 'SKILL.md');

// 매니페스트: [dir, name, userInvocable, triggers[](영+한 둘 다 포함해야), refsCLI?(mutating이면 CLI 참조 필수)]
const SKILLS = [
  ['deep-loop', 'deep-loop', true, ['/deep-loop', '루프', 'loop engineering'], true],
  ['deep-loop-workflow', 'deep-loop-workflow', false, ['adapter', '어댑터'], false],
  ['deep-loop-discover', 'deep-loop-discover', true, ['/deep-loop-discover', 'discover', '발견'], true],
  ['deep-loop-triage', 'deep-loop-triage', true, ['/deep-loop-triage', 'triage', '분류'], true],
  ['deep-loop-continue', 'deep-loop-continue', true, ['/deep-loop-continue', 'tick', '진행', '계속'], true],
  ['deep-loop-handoff', 'deep-loop-handoff', true, ['/deep-loop-handoff', 'handoff', '인수인계'], true],
  ['deep-loop-resume', 'deep-loop-resume', true, ['/deep-loop-resume', 'resume', '이어'], true],
  ['deep-loop-status', 'deep-loop-status', true, ['/deep-loop-status', 'status', '상태'], false],
  ['deep-loop-ack', 'deep-loop-ack', true, ['/deep-loop-ack', 'ack', '검토'], true],
  ['deep-loop-finish', 'deep-loop-finish', true, ['/deep-loop-finish', 'finish', '종료'], true],
];

function frontmatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---/);
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
const MUTATING_SUB = /(state\s+patch|episode\s+(?:new|record|abandon)|workstream\s+(?:new|set|terminal)|review\s+(?:dispatch|record)|handoff\s+emit|budget\s+record|comprehension\s+ack|breaker\s+reset|lease\s+(?:acquire|release)|finish\b)/;
// Codex r5 sf-3: shorthand 명령(예: `episode record --status done`, `finish --status completed`)도 잡는다.
// "command 라인" = deep-loop.mjs 호출이거나, mutating sub 뒤에 CLI 플래그(--xxx)가 오는 경우. 순수 산문 멘션은 무시.
const MUTATING_CMD = /(?:state\s+patch|episode\s+(?:new|record|abandon)|workstream\s+(?:new|set|terminal)|review\s+(?:dispatch|record)|handoff\s+emit|budget\s+record|comprehension\s+ack|breaker\s+reset|lease\s+(?:acquire|release)|finish)\b[^\n]*\s--\w/;
function mutatingFenced(text) {
  // Codex r4 sf-2: 셸 라인 연속(\ 로 끝나는 줄)을 논리 명령으로 먼저 합친다 — multi-line unfenced 명령 회피 차단.
  const joined = text.replace(/\\\n\s*/g, ' ');
  return joined.split('\n').every(line => {
    if (!MUTATING_SUB.test(line)) return true;                       // mutating sub 언급 없음 → OK
    const isCommand = /deep-loop\.mjs/.test(line) || MUTATING_CMD.test(line);
    if (!isCommand) return true;                                     // 산문 멘션(플래그 없음) → 무시
    return /--owner\b/.test(line) && /--generation\b/.test(line);    // mutating 명령 → 두 fence flag 필수 (OR 아님)
  });
}

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
  assert.ok(mutatingFenced('node x/deep-loop.mjs \\\n  state patch --field x --value "[]" --owner $R --generation 1'));
  // Codex r5 sf-3: deep-loop.mjs 프리픽스 없는 shorthand mutating 명령도 fence 필요.
  assert.ok(!mutatingFenced('episode record --status done --artifacts \'["a"]\''));   // shorthand unfenced
  assert.ok(!mutatingFenced('finish --status completed --report final-report.md'));   // shorthand unfenced
  assert.ok(mutatingFenced('episode record --status done --owner $R --generation 1'));   // shorthand fenced OK
});

for (const [dir, name, invocable, triggers, refsCLI] of SKILLS) {
  test(`skill ${dir}: exists`, () => assert.ok(existsSync(skillPath(dir)), `${dir}/SKILL.md missing`));
  test(`skill ${dir}: frontmatter has exactly name/description/user-invocable`, () => {
    const fm = frontmatter(readFileSync(skillPath(dir), 'utf8'));
    assert.match(fm, new RegExp(`name:\\s*${name}\\b`));
    assert.match(fm, new RegExp(`user-invocable:\\s*${invocable}`));
    assert.match(fm, /description:/);
    // 허용 키만 (다른 top-level 키 금지)
    const keys = fm.split('\n').filter(l => /^[a-z-]+:/.test(l)).map(l => l.split(':')[0]);
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
  for (const r of ['adapters.md', 'review-strategy.md', 'handoff-respawn.md'])
    assert.ok(existsSync(join(ROOT, 'skills', 'deep-loop-workflow', 'references', r)), `missing reference ${r}`);
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
