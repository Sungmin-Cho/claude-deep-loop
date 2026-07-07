import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchRecipe, loadRecipes } from '../scripts/lib/recipes.mjs';

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
