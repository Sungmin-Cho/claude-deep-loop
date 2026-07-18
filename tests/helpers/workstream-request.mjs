import { newWorkstream as createWorkstream } from '../../scripts/lib/workspace.mjs';

export * from '../../scripts/lib/workspace.mjs';

let nextWorkstreamRequest = 0;

export function newWorkstream(root, runId, input = {}) {
  nextWorkstreamRequest += 1;
  return createWorkstream(root, runId, {
    ...input,
    requestId: input.requestId ?? `test-workstream-${nextWorkstreamRequest}`,
  });
}
