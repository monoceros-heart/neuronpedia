/**
 * Set up a local Neuronpedia database from the command line: API keys, models with their raw
 * neurons, and source-set settings.
 *
 * Talks to Postgres directly, like scripts/compute-host.ts, so it works before the webapp is
 * running and needs no sign-in. The Makefile wraps each command (`make user-key`, `make model-add`,
 * `make source-set-update`, `make explanations-import`); `make help` lists them.
 *
 *   ts-node scripts/local-admin.ts user-key --name local --admin
 *   ts-node scripts/local-admin.ts model-add --id qwen3-8b --layers 36 --neurons-per-layer 12288
 *   ts-node scripts/local-admin.ts source-set-update --model qwen3-8b --set neurons \
 *     --dashboards-url http://127.0.0.1:3001/v2/qwen3-8b
 */
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import {
  assertLocalDatabase,
  boolArg,
  CliArgs,
  parseArgs,
  requireArg,
  requirePositiveInt,
} from '../lib/local-admin/cli-args';
import { importExplanations, parseImportFile } from '../lib/local-admin/import-explanations';
import {
  addModelWithNeurons,
  defaultKeyPath,
  ensureUserKey,
  NEURONS_SET_NAME,
  parseVisibility,
  updateSourceSet,
  writeSecretFile,
} from '../lib/local-admin/local-admin';

const USAGE = `
Usage: local-admin <command> [options]

  user-key              create a user if needed and write its API key to a file (never printed)
    --name <username>       defaults to "local"
    [--admin]               make the user an admin (needed for /api/admin/* routes)
    [--rotate]              replace an existing key
    [--out <path>]          defaults to ~/.config/neuronpedia/<username>.key, written mode 600

  model-add             create or update a model and its "neurons" source set, one source per layer
    --id <modelId>
    --layers <n>
    --neurons-per-layer <n>
    [--hf-repo <org/name>]  [--display-name <name>]  [--owner <org>]
    [--dashboards-url <url>]    base URL of the set's dashboard files
    [--inference]               the set's layers take live inference (needs a registered host)
    [--visibility PUBLIC|UNLISTED|PRIVATE]   defaults to PUBLIC
    [--creator <username>]      defaults to the seeded "bot" user

  source-set-update     change an existing source set
    --model <modelId>  [--set <name>]   set defaults to "neurons"
    [--dashboards-url <url|none>]  [--inference true|false]  [--visibility ...]

  explanations-import   load explanations and their scores from a JSONL file (format in
                        lib/local-admin/import-explanations.ts)
    --file <path>  [--author <username>]   author defaults to "bot"

  --remote  allow writing to a database that is not on this machine
`;

const LOCAL_ONLY_REASON = 'This tool sets up local development databases.';

const prisma = new PrismaClient();

const optional = (args: CliArgs, key: string) => {
  const value = args.get(key);
  return value === undefined || value === 'true' ? undefined : value;
};

async function userKey(args: CliArgs) {
  assertLocalDatabase(args, LOCAL_ONLY_REASON);
  const username = optional(args, 'name') ?? 'local';
  const result = await ensureUserKey(prisma, {
    username,
    admin: boolArg(args, 'admin'),
    rotate: boolArg(args, 'rotate'),
  });
  const out = optional(args, 'out') ?? defaultKeyPath(result.username);
  writeSecretFile(out, result.key);
  console.log(
    `${result.createdUser ? 'Created' : 'Found'} user "${result.username}"${result.admin ? ' (admin)' : ''}; ` +
      `${result.createdKey ? 'new' : 'existing'} API key written to ${out}`,
  );
  console.log(`Use it with: curl -H "x-api-key: $(cat ${out})" ...`);
}

async function modelAdd(args: CliArgs) {
  assertLocalDatabase(args, LOCAL_ONLY_REASON);
  const dashboardsUrl = optional(args, 'dashboards-url');
  const model = await addModelWithNeurons(prisma, {
    id: requireArg(args, 'id', USAGE),
    layers: requirePositiveInt(args, 'layers', USAGE),
    neuronsPerLayer: requirePositiveInt(args, 'neurons-per-layer', USAGE),
    displayName: optional(args, 'display-name'),
    owner: optional(args, 'owner'),
    hfRepoId: optional(args, 'hf-repo'),
    creatorName: optional(args, 'creator'),
    visibility: optional(args, 'visibility') ? parseVisibility(optional(args, 'visibility') as string) : undefined,
    dashboardsUrl: dashboardsUrl === 'none' ? '' : dashboardsUrl?.replace(/\/+$/, ''),
    inference: boolArg(args, 'inference'),
  });
  console.log(
    `Model ${model.id}: ${model.layers} layers x ${model.neuronsPerLayer} neurons, ` +
      `source set "${NEURONS_SET_NAME}" with sources 0..${model.layers - 1}`,
  );
}

async function sourceSetUpdate(args: CliArgs) {
  assertLocalDatabase(args, LOCAL_ONLY_REASON);
  const rawUrl = optional(args, 'dashboards-url');
  const dashboardsUrl = rawUrl === undefined ? undefined : rawUrl === 'none' ? null : rawUrl.replace(/\/+$/, '');
  const visibility = optional(args, 'visibility');
  const set = await updateSourceSet(prisma, {
    modelId: requireArg(args, 'model', USAGE),
    setName: optional(args, 'set') ?? NEURONS_SET_NAME,
    dashboardsUrl,
    inference: boolArg(args, 'inference'),
    visibility: visibility ? parseVisibility(visibility) : undefined,
  });
  console.log(
    `${set.modelId}/${set.name}: dashboards ${set.externalDashboardsUrl ?? '(none)'}, ` +
      `inference ${set.allowInferenceSearch ? 'on' : 'off'}, ${set.visibility}`,
  );
}

async function explanationsImport(args: CliArgs) {
  assertLocalDatabase(args, LOCAL_ONLY_REASON);
  const file = requireArg(args, 'file', USAGE);
  const lines = parseImportFile(fs.readFileSync(file, 'utf8'));
  const result = await importExplanations(prisma, lines, { authorName: optional(args, 'author') ?? 'bot' });
  console.log(
    `${file}: ${lines.length} lines; ${result.explanationsCreated} explanations created, ` +
      `${result.explanationsUpdated} updated, ${result.scoresWritten} scores written, ` +
      `${result.neuronsCreated} neuron rows created`,
  );
}

const COMMANDS: Record<string, (args: CliArgs) => Promise<void>> = {
  'user-key': userKey,
  'model-add': modelAdd,
  'source-set-update': sourceSetUpdate,
  'explanations-import': explanationsImport,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  await run(parseArgs(rest));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e instanceof Error ? e.message : e);
    await prisma.$disconnect();
    process.exit(1);
  });
