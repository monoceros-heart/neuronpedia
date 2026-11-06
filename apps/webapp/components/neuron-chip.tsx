'use client';

import {
  depth,
  depthArc,
  fetchFeatureLabel,
  formatId,
  layerOf,
  MODEL_LAYERS,
  modelColor,
  neuronKey,
  NEURONS_SET,
  neuronUrl,
  ParsedLabels,
  setOf,
  sourceId,
} from '@/lib/neuron-chip/neuron-chip';
import Link from 'next/link';
import { useEffect, useState } from 'react';

type Props = {
  model: string;
  /** The layer number; with `set` it names the source, as `<layer>-<set>`. */
  layer?: string | number;
  neuron: string | number;
  /** The source set, such as `neuronpersonas`. Defaults to the raw `neurons` set. */
  set?: string;
  /** An explicit source id, instead of `layer` and `set`. */
  source?: string;
  /** A label to show as is, with no lookup. */
  label?: string;
  /** Labels already loaded, such as a page's labels file; checked before the per-neuron API. */
  labels?: ParsedLabels;
  /** Another instance to link to and read labels from; defaults to this one. */
  host?: string;
  /** The model's layer count, for the depth ring; known models need none. */
  layers?: number;
  className?: string;
};

/**
 * ( L16.N1744 | Wind Whisperer ): a neuron's id and label as a link to its page. The ring around
 * the dot shows how deep the layer sits in the model, and its colour which model it is.
 * `public/np-neuron.js` is the same chip for static pages.
 */
export default function NeuronChip({
  model,
  layer,
  neuron,
  set,
  source,
  label,
  labels,
  host,
  layers,
  className,
}: Props) {
  const src = sourceId({ layer, set, source });
  const index = String(neuron);
  const preset = label ?? labels?.neurons[neuronKey(model, src, index)]?.label;
  const [fetched, setFetched] = useState<{ key: string; label: string | null } | null>(null);
  const key = `${host ?? ''}|${neuronKey(model, src, index)}`;

  useEffect(() => {
    if (preset !== undefined) return undefined;
    let live = true;
    fetchFeatureLabel(host ?? '', model, src, index)
      .then((l) => live && setFetched({ key, label: l }))
      .catch(() => live && setFetched({ key, label: null }));
    return () => {
      live = false;
    };
  }, [preset, host, model, src, index, key]);

  const shown = preset ?? (fetched?.key === key ? fetched.label : undefined);
  const state = shown === undefined ? 'loading' : shown === null ? 'none' : 'ok';
  const layerNum = layerOf(src);
  const total = layers ?? labels?.models[model.toLowerCase()]?.layers ?? MODEL_LAYERS[model.toLowerCase()];
  const arc = depthArc(depth(layerNum, total));
  const color = modelColor(model);
  const setName = setOf(src);
  const id = formatId(src, index);
  const href = neuronUrl(host ?? '', model, src, index);
  const title = `${model} · layer ${layerNum ?? src}${total ? ` of ${total}` : ''} · neuron ${index}${
    setName !== NEURONS_SET ? ` · ${setName}` : ''
  }${state === 'ok' ? `\n${shown}` : ''}`;

  const body = (
    <>
      <svg viewBox="0 0 16 16" aria-hidden="true" className="h-[1.05em] w-[1.05em] flex-none">
        <circle cx={8} cy={8} r={6} fill="none" className="stroke-slate-200" strokeWidth={2.4} />
        {arc && <path d={arc} fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" />}
        <circle cx={8} cy={8} r={2.6} fill={color} />
      </svg>
      <span className="font-mono text-[0.95em] font-semibold" style={{ color }}>
        {id}
      </span>
      {setName !== NEURONS_SET && (
        <span className="rounded border border-slate-300 px-1 text-[0.78em] text-slate-500">{setName}</span>
      )}
      <span className="text-slate-300" aria-hidden="true">
        |
      </span>
      <span
        className={`max-w-[22em] overflow-hidden text-ellipsis pr-[0.1em] ${
          state === 'ok' ? '' : state === 'none' ? 'italic text-slate-400' : 'text-slate-400'
        }`}
      >
        {state === 'ok' ? shown : state === 'none' ? 'no label' : '…'}
      </span>
    </>
  );
  const chipClass = `inline-flex max-w-full items-center gap-[0.4em] whitespace-nowrap rounded-full border border-slate-300 bg-slate-50 py-[0.1em] pl-[0.35em] pr-[0.6em] align-baseline text-[0.88em] leading-normal text-slate-900 no-underline transition-colors hover:border-slate-500 ${
    className ?? ''
  }`;
  const aria = `${id}${state === 'ok' ? `, ${shown}` : ''}, ${model}`;

  return host ? (
    <a href={href} title={title} aria-label={aria} className={chipClass} target="_blank" rel="noopener">
      {body}
    </a>
  ) : (
    <Link href={href} title={title} aria-label={aria} className={chipClass} prefetch={false}>
      {body}
    </Link>
  );
}
