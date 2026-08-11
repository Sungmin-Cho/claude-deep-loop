export function evalChildEnv(parentEnv = process.env) {
  const env = { ...parentEnv };
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  return env;
}
