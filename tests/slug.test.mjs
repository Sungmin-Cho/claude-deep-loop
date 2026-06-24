import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, runIdSlug } from '../scripts/lib/slug.mjs';

test('slugify kebab-cases and strips non-alnum', () => {
  assert.equal(slugify('Add Auth Flow!! 인증'), 'add-auth-flow');
  assert.equal(slugify('  Many   spaces  '), 'many-spaces');
});

test('slugify limits words', () => {
  assert.equal(slugify('one two three four five six seven', 3), 'one-two-three');
});

test('runIdSlug combines timestamp + slug', () => {
  const id = runIdSlug('Add auth', new Date('2026-06-24T15:42:00Z'));
  assert.match(id, /^20260624-154200-add-auth$/);
});
