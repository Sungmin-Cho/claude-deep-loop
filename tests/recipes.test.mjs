import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRecipe } from '../scripts/lib/recipes.mjs';

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
