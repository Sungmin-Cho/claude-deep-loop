import { dispatchReview as productionDispatchReview } from '../../scripts/lib/review.mjs';

export * from '../../scripts/lib/review.mjs';

let nextReviewRequest = 0;

export function dispatchReview(root, runId, input = {}) {
  nextReviewRequest += 1;
  return productionDispatchReview(root, runId, {
    ...input,
    requestId: input.requestId ?? `test-review-${nextReviewRequest}`,
  });
}
