'use server';

import { getUserById, makeAuthedUserFromSessionOrReturnNull } from '@/lib/db/user';
import { IS_LOCALHOST } from '@/lib/env';
import { getS3ModelsToSources } from '@/lib/utils/s3';

/**
 * The importable datasets, as model id -> source ids, for the admin pages. A server action rather
 * than a browser call to the bucket, because the bucket may need credentials (Cloudflare R2
 * always does), which must stay on the server. Same access rule as the import routes.
 */
export async function listImportableDatasets(): Promise<Record<string, string[]>> {
  if (!IS_LOCALHOST) {
    const sessionUser = await makeAuthedUserFromSessionOrReturnNull();
    const user = sessionUser ? await getUserById(sessionUser.id) : null;
    if (!user?.admin) {
      throw new Error('Only available on localhost or to admin users');
    }
  }
  return getS3ModelsToSources();
}
