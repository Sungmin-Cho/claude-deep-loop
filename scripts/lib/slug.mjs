export function slugify(text, maxWords = 6) {
  const words = String(text)
    .normalize('NFKD').replace(/[^\x00-\x7F]/g, '')   // drop non-ascii
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.slice(0, maxWords).join('-');
}

function pad(n) { return String(n).padStart(2, '0'); }

export function runIdSlug(goal, now = new Date()) {
  const d = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
  const t = `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `${d}-${t}-${slugify(goal) || 'run'}`;
}
