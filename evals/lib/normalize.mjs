export function normalize(value, { runId = '<RUN_ID>', root = '<ROOT>', repoRoot = '<REPO>' } = {}) {
  if (typeof value === 'string') return value.replaceAll(runId, '<RUN_ID>')
    .replaceAll(repoRoot, '<REPO>').replaceAll(root, '<ROOT>');
  if (Array.isArray(value)) return value.map(v => normalize(v, { runId, root, repoRoot }));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([k,v]) => [k, normalize(v, { runId, root, repoRoot })]));
  return value;
}
