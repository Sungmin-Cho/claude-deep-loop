import { appendAnchored } from '../../scripts/lib/integrity.mjs';

function hiddenWrite(root, runId) {
  appendAnchored(root, runId, { type: 'mut23' }, () => {});
}

export function falselyPureSurface(root, runId) {
  return hiddenWrite(root, runId);
}
