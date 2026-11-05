/**
 * Whether the webapp runs in local mode: the admin panel and the dataset-import routes need no
 * sign-in, and the navbar links to local pages for adding models and SAEs.
 *
 * `NEXT_PUBLIC_LOCAL_MODE=true|false` decides it when set. Otherwise it falls back to the original
 * rule, which is a public URL of exactly `http://localhost:3000`. The flag exists because that rule
 * ties two separate things together: an instance browsed at a LAN or tailnet address either lost
 * local mode, or kept it only by building every link and sign-in redirect for `localhost`.
 *
 * A Vercel production or preview build is never in local mode, whatever the flag says: Next also
 * reads `.env.local` and project env vars at build time, so a stray `true` would otherwise ship an
 * unauthenticated admin panel. Vercel sets `NEXT_PUBLIC_VERCEL_ENV` on every build it runs.
 */
export function isLocalMode(
  localModeFlag: string | undefined,
  publicUrl: string | undefined,
  vercelEnv?: string,
): boolean {
  if (vercelEnv === 'production' || vercelEnv === 'preview') return false;
  const flag = (localModeFlag ?? '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(flag)) return true;
  if (['false', '0', 'no'].includes(flag)) return false;
  return publicUrl === 'http://localhost:3000';
}
