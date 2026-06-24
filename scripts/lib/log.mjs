const COLORS = { info: '', warn: '\x1b[33m', error: '\x1b[31m', reset: '\x1b[0m' };
let useColor = !process.env.NO_COLOR;
export function setColor(on) { useColor = on; }
function emit(level, msg) {
  const c = useColor ? COLORS[level] : '';
  const r = useColor ? COLORS.reset : '';
  process.stderr.write(`${c}[deep-loop:${level}]${r} ${msg}\n`);
}
export const info = (m) => emit('info', m);
export const warn = (m) => emit('warn', m);
export const error = (m) => emit('error', m);
export const json = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
