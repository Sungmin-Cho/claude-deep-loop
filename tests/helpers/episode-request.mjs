import { newEpisode as createEpisode } from '../../scripts/lib/episode.mjs';

export { abandonEpisode, recordEpisode } from '../../scripts/lib/episode.mjs';

let nextEpisodeRequest = 0;

export function newEpisode(root, runId, input = {}) {
  nextEpisodeRequest += 1;
  return createEpisode(root, runId, {
    ...input,
    task: input.task ?? `Execute test episode ${nextEpisodeRequest} without prior conversation context.`,
    requestId: input.requestId ?? `test-episode-${nextEpisodeRequest}`,
  });
}
