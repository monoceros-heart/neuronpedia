import NeuronChip from '@/components/neuron-chip';

/** Shown when the page is opened with no `neurons` parameter: the Qwen3-8B "god neurons". */
const DEFAULT_NEURONS = 'qwen3-8b/9/3757,qwen3-8b/18/7807,qwen3-8b/8/1931';

type ChipRef = { modelId: string; source: string; index: string };

/** `model/source/index,...` into refs; malformed entries are dropped. */
function parseNeuronsParam(param: string): ChipRef[] {
  return param
    .split(',')
    .map((s) => s.trim().split('/'))
    .filter((p) => p.length === 3 && p.every(Boolean) && /^\d+$/.test(p[2]))
    .slice(0, 200)
    .map(([modelId, source, index]) => ({ modelId: modelId.toLowerCase(), source: source.toLowerCase(), index }));
}

/**
 * A row of neuron chips, `/neuron-chip?neurons=qwen3-8b/18-neuronpersonas/7807,...`, and how to use
 * them elsewhere. Each chip asks the per-neuron API for its label, which applies the viewer's
 * access to the source set.
 */
export default async function Page(props: { searchParams?: Promise<{ neurons?: string }> }) {
  const searchParams = await props.searchParams;
  const refs = parseNeuronsParam(searchParams?.neurons || DEFAULT_NEURONS);

  return (
    <div className="w-full max-w-screen-md px-3 pb-10 pt-6 text-sm text-slate-700">
      <h1 className="mb-1 text-xl font-medium text-slate-800">Neuron chips</h1>
      <p className="mb-5 text-slate-500">
        A neuron&apos;s id and its top explanation, linking to its page. The ring shows how deep the layer sits in the
        model; its colour, which model.
      </p>
      <div className="mb-8 flex flex-col items-start gap-2">
        {refs.map((r) => (
          <NeuronChip
            key={`${r.modelId}/${r.source}/${r.index}`}
            model={r.modelId}
            source={r.source}
            neuron={r.index}
          />
        ))}
      </div>
      <h2 className="mb-1 font-medium text-slate-800">In this webapp</h2>
      <pre className="mb-5 overflow-x-auto rounded bg-slate-100 p-3 text-xs">
        {`import NeuronChip from '@/components/neuron-chip';

<NeuronChip model="qwen3-8b" layer={18} neuron={7807} set="neuronpersonas" />`}
      </pre>
      <h2 className="mb-1 font-medium text-slate-800">In any other page</h2>
      <pre className="overflow-x-auto rounded bg-slate-100 p-3 text-xs">
        {`<script src="/np-neuron.js"></script>   <!-- or a copy of it -->
<np-neuron model="qwen3-8b" layer="18" neuron="7807" set="neuronpersonas"></np-neuron>`}
      </pre>
      <p className="mt-2 text-slate-500">Details: docs/NEURON_CHIP.md in the repository.</p>
    </div>
  );
}
