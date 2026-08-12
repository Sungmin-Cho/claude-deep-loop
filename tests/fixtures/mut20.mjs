function durableWrite() { return 'write'; }
function noWrite() { return 'pure'; }
export let canonical = durableWrite;
export const alias = canonical;
canonical = noWrite;
