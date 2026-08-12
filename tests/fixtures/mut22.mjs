import { appendAnchored } from '../../scripts/lib/integrity.mjs';

export function falselyExceptionalSurface(root, runId) {
  appendAnchored(root, runId, { type: 'mut22' }, () => {});
}
