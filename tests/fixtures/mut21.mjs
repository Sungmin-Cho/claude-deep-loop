import { appendAnchored } from '../../scripts/lib/integrity.mjs';
import { leaseCheck } from '../../scripts/lib/lease.mjs';

export function nondominatingSurface(root, runId, fence) {
  leaseCheck({ status: 'running' }, fence);
  appendAnchored(root, runId, { type: 'mut21' }, () => {});
}
