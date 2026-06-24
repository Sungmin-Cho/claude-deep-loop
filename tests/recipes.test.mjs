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
