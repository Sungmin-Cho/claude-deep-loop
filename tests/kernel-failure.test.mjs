import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyKernelError, kernelFailure } from '../scripts/lib/kernel-failure.mjs';

test('RESPAWN_FENCED extra maps to exit 3 and the default folds to exit 1', () => {
  const fenced = kernelFailure(new Error('RESPAWN_FENCED: x'), { extra: [['RESPAWN_FENCED', 3]] });
  assert.equal(fenced.code, 3);
  assert.match(fenced.message, /^RESPAWN_FENCED:/);
  const folded = kernelFailure(new Error('RESPAWN_FENCED: x'));
  assert.equal(folded.code, 1);
});

test('unclassified rethrow keeps the same object; default folds to exit 1', () => {
  const e = new Error('SOMETHING_UNCLASSIFIED');
  assert.throws(() => kernelFailure(e, { unclassified: 'rethrow' }), (err) => err === e);
  assert.equal(kernelFailure(e).code, 1);
  assert.equal(kernelFailure(e).message, 'SOMETHING_UNCLASSIFIED');
});

test('canonical fence prefixes stay exit 3 after extra is considered first', () => {
  assert.equal(kernelFailure(new Error('PROJECT_ROOT_FENCED: moved')).code, 3);
  assert.equal(kernelFailure(new Error('LEASE_FENCED: owner')).code, 3);
  assert.equal(classifyKernelError(new Error('PROJECT_ROOT_FENCED: moved')).code, 3);
});

test('route extra mappings win over the default unclassified fold', () => {
  const recover = kernelFailure(new Error('NOT_RECOVERABLE: x'), {
    extra: [['NOT_RECOVERABLE', 2], ['CONFIRM_REQUIRED', 2]],
  });
  assert.equal(recover.code, 2);
  const confirm = kernelFailure(new Error('CONFIRM_REQUIRED: y'), {
    extra: [['CONFIRM_REQUIRED', 2], ['CONFIRM_FORBIDDEN', 2]],
  });
  assert.equal(confirm.code, 2);
});

test('unknown unclassified polarity fails closed instead of folding', () => {
  assert.throws(
    () => kernelFailure(new Error('x'), { unclassified: 're-throw' }),
    /INVALID_KERNEL_FAILURE/,
  );
});

test('extra prefixes do not match a longer sibling token', () => {
  const folded = kernelFailure(new Error('NOT_RECOVERABLE_YET: x'), {
    extra: [['NOT_RECOVERABLE', 2]],
  });
  assert.equal(folded.code, 1);
});
