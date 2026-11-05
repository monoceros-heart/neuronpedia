import { describe, expect, it } from 'vitest';
import { assertLocalDatabase, boolArg, listArg, parseArgs, requireArg, requirePositiveInt } from './cli-args';

describe('parseArgs', () => {
  it('reads values and bare flags', () => {
    const args = parseArgs(['--name', 'local', '--admin', '--out', '/tmp/k']);
    expect(args.get('name')).toBe('local');
    expect(args.get('admin')).toBe('true');
    expect(args.get('out')).toBe('/tmp/k');
  });

  it('reads comma lists', () => {
    expect(listArg(parseArgs(['--sources', 'a, b,,c']), 'sources')).toEqual(['a', 'b', 'c']);
  });
});

describe('typed options', () => {
  it('requires a value, not a bare flag', () => {
    expect(() => requireArg(parseArgs(['--id']), 'id')).toThrow('Missing --id');
  });

  it('accepts only positive integers', () => {
    expect(requirePositiveInt(parseArgs(['--layers', '28']), 'layers')).toBe(28);
    expect(() => requirePositiveInt(parseArgs(['--layers', '0']), 'layers')).toThrow('positive integer');
    expect(() => requirePositiveInt(parseArgs(['--layers', '2.5']), 'layers')).toThrow('positive integer');
  });

  it('reads booleans from flags and words', () => {
    expect(boolArg(parseArgs(['--inference']), 'inference')).toBe(true);
    expect(boolArg(parseArgs(['--inference', '0']), 'inference')).toBe(false);
    expect(boolArg(parseArgs([]), 'inference')).toBeUndefined();
    expect(() => boolArg(parseArgs(['--inference', 'maybe']), 'inference')).toThrow('true or false');
  });
});

describe('assertLocalDatabase', () => {
  const env = (url: string) => ({ POSTGRES_URL_NON_POOLING: url });

  it('allows a database on this machine', () => {
    expect(() => assertLocalDatabase(new Map(), 'why', env('postgres://u:p@localhost:5432/postgres'))).not.toThrow();
    expect(() => assertLocalDatabase(new Map(), 'why', env('postgres://u:p@127.0.0.1:5433/x'))).not.toThrow();
  });

  it('refuses any other host unless --remote is passed', () => {
    const remote = env('postgres://u:p@db.example.com:5432/prod');
    expect(() => assertLocalDatabase(new Map(), 'Local only.', remote)).toThrow(/db\.example\.com.*Local only\./);
    expect(() => assertLocalDatabase(parseArgs(['--remote']), 'Local only.', remote)).not.toThrow();
  });

  it('refuses when either connection string points elsewhere', () => {
    const mixed = {
      POSTGRES_URL_NON_POOLING: 'postgres://u:p@localhost:5432/postgres',
      POSTGRES_PRISMA_URL: 'postgres://u:p@db.example.com:5432/prod?pgbouncer=true',
    };
    expect(() => assertLocalDatabase(new Map(), 'why', mixed)).toThrow(/db\.example\.com/);
  });

  it('refuses an unreadable connection string', () => {
    expect(() => assertLocalDatabase(new Map(), 'why', env(''))).toThrow('an unrecognised host');
  });
});
