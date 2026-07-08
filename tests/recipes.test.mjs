import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchRecipe, loadRecipes, validateRecipesDir } from '../scripts/lib/recipes.mjs';

const allInstalled = { 'deep-work': true };
test('implementation goal → robust-implementation + deep-work', () => {
  const r = matchRecipe('인증 기능 구현', allInstalled);
  assert.equal(r.recipe, 'robust-implementation');
  assert.equal(r.protocol, 'deep-work');
});
test('handoff goal → context-handoff-only + standalone when no deep-work', () => {
  const r = matchRecipe('세션 이어서 진행', {});
  assert.equal(r.recipe, 'context-handoff-only');
  assert.equal(r.protocol, 'standalone');
});
test('superpowers keyword forces superpowers protocol', () => {
  const r = matchRecipe('구현 using superpowers protocol', { 'deep-work': true });
  assert.equal(r.protocol, 'superpowers');
});
test('no match → triage-and-discovery fallback', () => {
  const r = matchRecipe('알 수 없는 목표 xyzzy', {});
  assert.equal(r.recipe, 'triage-and-discovery');
});
test('standalone-hinted recipe stays standalone even with deep-work installed', () => {
  const r = matchRecipe('세션 이어서 진행', { 'deep-work': true });
  assert.equal(r.recipe, 'context-handoff-only');
  assert.equal(r.protocol, 'standalone');
});

// ── C2: object-shape routing regression — routes on present (installed‖initialized) ───
test('C2: matchRecipe routes deep-work protocol only when present (object shape)', () => {
  assert.notEqual(matchRecipe('인증 기능 구현', { 'deep-work': { present: false } }).protocol, 'deep-work');
  assert.equal(matchRecipe('인증 기능 구현', { 'deep-work': { present: true } }).protocol, 'deep-work');
  // installed-but-uninitialized sibling (original Problem C) → present:true → routed
  assert.equal(matchRecipe('인증 기능 구현', { 'deep-work': { installed: true, initialized: false, present: true } }).protocol, 'deep-work');
});

test('harness-hill-climb: 트리거 매칭 + standalone 폴백', () => {
  const r = matchRecipe('하네스 개선: bootstrap_ack_friction', {});
  assert.equal(r.recipe, 'harness-hill-climb');
  assert.equal(r.protocol, 'standalone');
});

// ── impl-R1 🟡1: bare "harness" 트리거가 일반 목표를 hill-climb으로 오라우팅 (2026-07-08 리뷰) ───
test('일반 목표의 "harness" 언급만으로는 hill-climb으로 라우팅되지 않는다', () => {
  const r = matchRecipe('prepare a pytest harness for the auth module', {});
  assert.notEqual(r.recipe, 'harness-hill-climb');
});
test('hill-climb 의도 트리거(영/한)는 유지된다', () => {
  assert.equal(matchRecipe('run a harness hill-climb over past loop traces', {}).recipe, 'harness-hill-climb');
  assert.equal(matchRecipe('deep-loop 하네스 개선 사이클 시작', {}).recipe, 'harness-hill-climb');
});

// ── Phase6 warning-2: 광역 트리거("improve")가 더 특이한 트리거("hill-climb")를 first-match로 선점 —
// 최장 매칭 트리거의 recipe가 이기도록 교정 (r1/r2에 이은 같은 클래스 3회째 반복 종결) ───
test('최장 매칭 트리거 특이성: 광역 트리거가 더 특이한 트리거를 선점하지 않는다', () => {
  const r = matchRecipe('improve hill-climb harness', {});
  assert.equal(r.recipe, 'harness-hill-climb');
});
test('단일 recipe만 매칭될 때는 특이성 변경의 영향을 받지 않는다', () => {
  const r = matchRecipe('improve test coverage', {});
  assert.equal(r.recipe, 'autonomous-evolution');
});
test('트리거 길이가 동률이면 기존 파일 순서(첫 매칭)가 유지된다', () => {
  const recipes = [
    { id: 'first', triggers: ['abcde'] },
    { id: 'second', triggers: ['fghij'] },   // first와 동일 길이(5) 트리거 — 동률
  ];
  const r = matchRecipe('abcde fghij goal', {}, recipes);
  assert.equal(r.recipe, 'first');
});

// ── impl-R2 🟡1: cross-recipe 트리거 섀도잉 lint — substring first-match에서 다른 recipe의 트리거를
// 부분문자열로 포함하는 트리거는 dead trigger(도달 불가) 또는 readdir 순서 의존 비결정 라우팅이 된다 ───
test('recipe 트리거는 다른 recipe의 트리거를 부분문자열로 포함하지 않는다(섀도잉 방지)', () => {
  const recipes = loadRecipes();
  for (const r of recipes) {
    for (const t of r.triggers) {
      for (const o of recipes) {
        if (o.id === r.id) continue;
        for (const ot of o.triggers) {
          assert.ok(!t.toLowerCase().includes(ot.toLowerCase()),
            `${r.id} trigger "${t}"가 ${o.id} trigger "${ot}"에 가려짐`);
        }
      }
    }
  }
});

// ── impl-R2 ℹ️5: loadRecipes가 malformed/null JSON에서 전체 라우팅을 깨뜨리지 않는다 ───
test('loadRecipes: malformed/null JSON 파일은 건너뛰고 유효 recipe만 반환한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-'));
  writeFileSync(join(dir, 'good.json'), JSON.stringify({ id: 'good', triggers: ['xyzzy-trigger'] }));
  writeFileSync(join(dir, 'null.json'), 'null');
  writeFileSync(join(dir, 'broken.json'), '{oops');
  const rs = loadRecipes(dir);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].id, 'good');
});

// ── Phase6 ITEM-1: validate의 정적 검사가 런타임 loadRecipes와 동일한 dir을 봐야 한다는 계약을
// dir-injection으로 고립 검증 — CLI 레벨 assertion(project-root recipes/는 검사 대상 아님)은
// tests/validate-cli.test.mjs가 담당한다 ───
test('validateRecipesDir: 주입 dir의 malformed JSON을 파일명 포함 에러로 fail-closed 반환한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-validate-'));
  writeFileSync(join(dir, 'broken.json'), '{oops');
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ id: 'ok', triggers: ['x'] }));
  const r = validateRecipesDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('broken.json')), `expected filename in errors: ${r.errors}`);
});
test('validateRecipesDir: triggers 비-배열 recipe도 파일명 포함 에러로 fail-closed 반환한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-validate-'));
  writeFileSync(join(dir, 'not-a-recipe.json'), JSON.stringify({ id: 'x' }));
  const r = validateRecipesDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('not-a-recipe.json')));
});
test('validateRecipesDir: 기본 인자는 번들 recipesDir이며 현재 번들은 통과한다', () => {
  const r = validateRecipesDir();
  assert.deepEqual(r, { ok: true, errors: [] });
});
test('validateRecipesDir: 존재하지 않는 dir은 ok(빈 dir과 동형 — validate가 existsSync로 감쌌던 것과 동일 의미)', () => {
  const r = validateRecipesDir(join(tmpdir(), 'dl-recipes-does-not-exist-' + Date.now()));
  assert.deepEqual(r, { ok: true, errors: [] });
});

// ── Phase6 info-3: loadRecipes(dir)에 커스텀 부재 dir을 주입하면 validateRecipesDir과 달리
// existsSync 가드가 없어 readdirSync가 ENOENT를 throw했다 — validateRecipesDir과 동형으로 빈 목록을
// 반환하게 한다(matchRecipe의 NO_VALID_RECIPES fail-closed로 이어지므로 침묵 실패 아님) ───
test('loadRecipes: 존재하지 않는 dir을 주입하면 throw 없이 빈 배열을 반환한다 (validateRecipesDir과 동형)', () => {
  const dir = join(tmpdir(), 'dl-recipes-load-does-not-exist-' + Date.now());
  assert.deepEqual(loadRecipes(dir), []);
});

// ── Phase6 ITEM-2 (adversarial): triggers:[null]이 loadRecipes 필터·validate 정적 검사 둘 다
// `Array.isArray(r.triggers)`만 확인해 통과한 뒤, matchRecipe의 `t.toLowerCase()`에서 TypeError로
// recipe-match/init-run 전체가 크래시했다 — 원소 타입까지 fail-closed로 강제한다 ───
test('loadRecipes: triggers 원소가 non-string(null)인 recipe는 경고와 함께 skip되고 matchRecipe는 크래시하지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-badtrig-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad', triggers: [null] }));
  writeFileSync(join(dir, 'good.json'), JSON.stringify({ id: 'good', triggers: ['xyzzy-trigger'] }));
  const rs = loadRecipes(dir);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].id, 'good');
  // 크래시 없이 정상 라우팅 — bad.json이 loadRecipes 결과에 없으므로 matchRecipe가 그 triggers를 볼 일이 없다
  assert.doesNotThrow(() => matchRecipe('xyzzy-trigger goal', {}, rs));
});
test('loadRecipes: id가 문자열이 아닌 recipe도 경고와 함께 skip된다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-badid-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 42, triggers: ['x'] }));
  const rs = loadRecipes(dir);
  assert.equal(rs.length, 0);
});
test('loadRecipes: hillclimb-ledger.json은 shape 위반 경고 없이 조용히 제외된다(예외 처리 보존)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-ledger-'));
  writeFileSync(join(dir, 'hillclimb-ledger.json'), '[]');
  writeFileSync(join(dir, 'good.json'), JSON.stringify({ id: 'good', triggers: ['x'] }));
  const origWrite = process.stderr.write;
  const warnings = [];
  process.stderr.write = (s) => { warnings.push(String(s)); return true; };
  let rs;
  try { rs = loadRecipes(dir); } finally { process.stderr.write = origWrite; }
  assert.equal(rs.length, 1);
  assert.ok(!warnings.some(w => w.includes('hillclimb-ledger.json')), `unexpected ledger warning: ${warnings}`);
});
test('validateRecipesDir: triggers 원소가 non-string(null)인 recipe를 파일명 포함 에러로 fail-closed 반환한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-validate-badtrig-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 'bad', triggers: [null] }));
  const r = validateRecipesDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('bad.json')));
});
test('validateRecipesDir: id가 문자열이 아닌 recipe도 파일명 포함 에러로 fail-closed 반환한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-recipes-validate-badid-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({ id: 42, triggers: ['x'] }));
  const r = validateRecipesDir(dir);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('bad.json')));
});

// ── Phase6 warning-1 (adversarial): 전 recipe가 skip되거나 fallback('triage-and-discovery')이 없는
// degraded 번들이 matchRecipe에 도달하면 `chosen.protocol_hint` deref에서 uncaught TypeError로
// 라우팅 전체가 크래시했다 — 통제된 fail-closed 에러(NO_VALID_RECIPES)로 종료해야 한다 ───
test('matchRecipe: 빈 recipes 목록(전원 skip, fallback 부재)은 TypeError가 아닌 NO_VALID_RECIPES를 throw한다', () => {
  assert.throws(() => matchRecipe('anything', {}, []), (e) => {
    assert.ok(!(e instanceof TypeError), `expected non-TypeError, got ${e.constructor.name}`);
    assert.match(e.message, /^NO_VALID_RECIPES:/);
    return true;
  });
});
test('matchRecipe: triage-and-discovery fallback이 없는 목록도 NO_VALID_RECIPES를 throw한다', () => {
  const recipes = [{ id: 'unrelated', triggers: ['zzz-nomatch-zzz'] }];
  assert.throws(() => matchRecipe('anything', {}, recipes), (e) => {
    assert.match(e.message, /^NO_VALID_RECIPES:/);
    return true;
  });
});
// CLI-level: recipe-match의 recipesDir은 자기 모듈 위치(scripts/lib/recipes.mjs) 기준으로 고정돼 있어
// (--project-root와 무관), 실제 degraded 번들을 재현하려면 scripts/ 전체를 임시 복사하고 그 복사본의
// recipes/를 비워야 한다 — 진짜 번들(recipes/*.json)은 절대 건드리지 않는다.
test('CLI recipe-match: degraded 번들(recipes 전무)에서 uncaught 스택 없이 exit 1', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dl-recipe-cli-degraded-'));
  cpSync(join(process.cwd(), 'scripts'), join(tmp, 'scripts'), { recursive: true });
  mkdirSync(join(tmp, 'recipes'), { recursive: true });   // empty — no fallback, no recipes at all
  const root = mkdtempSync(join(tmpdir(), 'dl-'));
  let status, stderr = '';
  try {
    execFileSync('node', [join(tmp, 'scripts', 'deep-loop.mjs'), 'recipe-match', '--goal', 'x', '--project-root', root], { encoding: 'utf8' });
    status = 0;
  } catch (e) { status = e.status ?? 1; stderr = String(e.stderr || ''); }
  assert.notEqual(status, 0);
  assert.ok(stderr.includes('NO_VALID_RECIPES'), `expected NO_VALID_RECIPES in stderr: ${stderr}`);
  assert.ok(!stderr.includes('TypeError') && !stderr.includes(' at '), `unexpected uncaught stack: ${stderr}`);
});
