/**
 * Check neuron dashboard files (docs/NEURON_DASHBOARDS.md) the way the webapp reads them.
 *
 *   ts-node -r tsconfig-paths/register scripts/dashboards.ts check --url http://127.0.0.1:3001/v2/qwen3-8b
 *
 * `make dashboards-check` wraps it. Serving the files locally needs no code of ours:
 * `make dashboards-serve` runs http-server, which answers byte ranges and CORS as the reader needs.
 */
import { checkDashboards } from '@/lib/neuron-dashboards-local/check';
import { parseArgs, requireArg } from '../lib/local-admin/cli-args';

const USAGE = `
Usage: dashboards check [options]

  check   --url <base URL of one model, e.g. http://127.0.0.1:3001/v2/qwen3-8b>
          [--layers 0,17]  [--sample 3]  [--model <id>]
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === 'check') {
    const url = requireArg(args, 'url', USAGE);
    const layers = args.get('layers')?.split(',').map(Number);
    const report = await checkDashboards(url, {
      layers,
      sample: args.has('sample') ? Number(args.get('sample')) : undefined,
      modelId: args.get('model'),
    });
    console.log(`vocab: ${report.vocabSize} tokens`);
    report.layers.forEach((layer) => {
      console.log(
        `layer ${String(layer.layer).padStart(2)}: ${layer.neurons} neurons, checked ${layer.checked.join(', ')}` +
          (layer.topLogits.length > 0 ? `  top logits of ${layer.checked[0]}: ${JSON.stringify(layer.topLogits)}` : ''),
      );
    });
    if (report.problems.length > 0) {
      console.log(`\n${report.problems.length} problem(s):\n  ${report.problems.slice(0, 50).join('\n  ')}`);
      process.exitCode = 1;
    } else {
      console.log('\nOK: every checked neuron loads as the webapp would load it.');
    }
    return;
  }
  console.log(USAGE);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
