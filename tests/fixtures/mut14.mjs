function implementation(...args) { return args; }
export function forwardingWrapper(...args) { return implementation(...args); }
