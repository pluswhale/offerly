/** Required env var — throws at startup/use time if missing. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Optional env var with a default. */
export function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
