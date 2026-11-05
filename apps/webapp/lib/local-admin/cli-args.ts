/**
 * Argument parsing and the local-database guard shared by the command-line tools in `scripts/`
 * (`compute-host.ts`, `local-admin.ts`). Imported by relative path, since those run under ts-node,
 * which does not resolve the `@/` alias.
 */

export type CliArgs = Map<string, string>;

/** `--key value` pairs into a map; a flag with no value (`--admin`) is stored as `'true'`. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
      args.set(key, value);
      if (value !== 'true') i += 1;
    }
  }
  return args;
}

/** A comma-separated option as a list, empty entries dropped. */
export function listArg(args: CliArgs, key: string): string[] {
  return (args.get(key) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The option's value, or an error naming it and showing the usage. */
export function requireArg(args: CliArgs, key: string, usage = ''): string {
  const value = args.get(key);
  if (!value || value === 'true') {
    throw new Error(`Missing --${key}${usage ? `\n${usage}` : ''}`);
  }
  return value;
}

/** A positive integer option, or an error naming it. */
export function requirePositiveInt(args: CliArgs, key: string, usage = ''): number {
  const raw = requireArg(args, key, usage);
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${key} must be a positive integer, not "${raw}"`);
  }
  return value;
}

/** `--flag`, `--flag true|1|yes` read as true; `--flag false|0|no` as false; absent as undefined. */
export function boolArg(args: CliArgs, key: string): boolean | undefined {
  const raw = args.get(key);
  if (raw === undefined) return undefined;
  const value = raw.toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off', ''].includes(value)) return false;
  throw new Error(`--${key} must be true or false, not "${raw}"`);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

/**
 * The hostnames of every database the Prisma client may connect to: queries go through
 * POSTGRES_PRISMA_URL and migrations through POSTGRES_URL_NON_POOLING. '' marks one that can't be
 * read.
 */
export function databaseHosts(env: Record<string, string | undefined> = process.env): string[] {
  const urls = [env.POSTGRES_PRISMA_URL, env.POSTGRES_URL_NON_POOLING].filter((u): u is string => Boolean(u));
  return (urls.length > 0 ? urls : ['']).map((url) => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  });
}

/**
 * Refuse to write to anything but a database on this machine.
 *
 * Developing against the production database is normal here, so the dangerous mistake is running
 * a local tool with the wrong .env loaded and writing a laptop's test data into production.
 * Checking the connection string tests that directly. `--remote` is the deliberate override.
 */
export function assertLocalDatabase(
  args: CliArgs,
  what: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const host = databaseHosts(env).find((h) => !LOCAL_HOSTS.has(h));
  if (host === undefined || args.has('remote')) {
    return;
  }
  throw new Error(
    `Refusing to write to "${host || 'an unrecognised host'}", which is not a local database. ` +
      `${what} Pass --remote if you truly mean this database.`,
  );
}
