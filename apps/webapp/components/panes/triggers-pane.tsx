import ActivationItem from '@/components/activation-item';
import { useGlobalContext } from '@/components/provider/global-provider';
import { Button } from '@/components/shadcn/button';
import type { NeuronTrigger } from '@/lib/db/trigger';
import {
  STRONG_SHARE,
  TRIGGER_DATA_SOURCE,
  TRIGGER_MAX_MEANING_LENGTH,
  TRIGGER_MAX_TEXT_LENGTH,
} from '@/lib/utils/raw-neurons';
import { NeuronWithPartialRelations } from '@/prisma/generated/zod';
import * as Tooltip from '@radix-ui/react-tooltip';
import { HelpCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { LoadingSpinner } from '../svg/loading-spinner';

function ShareBadge({ share, label }: { share: number; label: string }) {
  const strong = share >= STRONG_SHARE;
  return (
    <span
      className={`whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${
        strong ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
      }`}
      title={`${label}: ${(share * 100).toFixed(0)}% of this neuron's strongest corpus example`}
    >
      {label} {(share * 100).toFixed(0)}%
    </span>
  );
}

// Texts people wrote to drive this neuron, each with their proposed meaning, plus a form to add one.
// The server runs every text through the model, so each card is a real measurement, scored against
// the strongest example the dataset scan found.
export default function TriggersPane({ currentNeuron }: { currentNeuron: NeuronWithPartialRelations | undefined }) {
  const { user, setSignInModalOpen, showToastServerError } = useGlobalContext();
  const [triggers, setTriggers] = useState<NeuronTrigger[]>([]);
  const [text, setText] = useState('');
  const [meaning, setMeaning] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const canTest = !!currentNeuron?.source?.inferenceEnabled;

  const key = currentNeuron
    ? { modelId: currentNeuron.modelId, source: currentNeuron.layer, index: currentNeuron.index }
    : undefined;

  const load = useCallback(async () => {
    if (!key) return;
    const response = await fetch('/api/trigger/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(key),
    });
    if (response.ok) {
      setTriggers((await response.json()).triggers);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentNeuron?.modelId, currentNeuron?.layer, currentNeuron?.index]);

  useEffect(() => {
    load();
  }, [load]);

  async function share() {
    if (!user) {
      setSignInModalOpen(true);
      return;
    }
    setIsSharing(true);
    const response = await fetch('/api/trigger/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...key, text, meaning }),
    });
    setIsSharing(false);
    if (!response.ok) {
      showToastServerError();
      return;
    }
    setText('');
    setMeaning('');
    await load();
  }

  if (!currentNeuron || (!canTest && triggers.length === 0)) {
    return null;
  }

  return (
    <div
      className="mt-2 flex flex-col overflow-hidden rounded-lg border bg-white px-3 pb-3 pt-2 text-xs shadow sm:mt-3"
      data-testid="triggers-pane"
    >
      <div className="mb-1.5 flex w-full flex-row items-center justify-center gap-x-1 text-[10px] font-normal uppercase text-slate-400">
        Shared Triggers
        <Tooltip.Provider delayDuration={0} skipDelayDuration={0}>
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button type="button" aria-label="About shared triggers">
                <HelpCircle className="h-2.5 w-2.5" />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content className="max-w-xs rounded bg-slate-500 px-3 py-2 text-xs text-white" sideOffset={5}>
                Texts people wrote to make this neuron fire, with what they think it means. Each percentage is the
                text&apos;s peak as a share of the strongest example in the dataset scan; {STRONG_SHARE * 100}% or more
                is a strong response.
                <Tooltip.Arrow className="fill-slate-500" />
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        </Tooltip.Provider>
      </div>

      {triggers.length === 0 && (
        <div className="py-2 text-center text-slate-400">No shared triggers yet. Be the first.</div>
      )}
      <div className="flex flex-col divide-y divide-slate-100">
        {triggers.map((trigger) => (
          <div key={trigger.id} className="flex flex-col gap-y-1 py-2" data-testid="trigger-card">
            <div className="flex flex-row items-start justify-between gap-x-2">
              <div className="text-[12px] font-medium text-slate-700">{trigger.meaning}</div>
              <div className="flex shrink-0 flex-row gap-x-1">
                <ShareBadge share={trigger.peakShare} label="+" />
                {trigger.troughShare > 0 && <ShareBadge share={trigger.troughShare} label="−" />}
              </div>
            </div>
            <ActivationItem
              activation={{
                tokens: trigger.tokens,
                values: trigger.values,
                maxValue: trigger.peak,
                minValue: trigger.trough,
                maxValueTokenIndex: trigger.values.indexOf(trigger.peak),
                dataSource: TRIGGER_DATA_SOURCE,
              }}
              tokensToDisplayAroundMaxActToken={TRIGGER_MAX_TEXT_LENGTH}
              overallMaxActivationValueInList={trigger.corpusMax}
              showLineBreaks={false}
              showCopy={false}
              overrideTextSize="text-[11px]"
            />
            <div className="text-[10px] text-slate-400">
              by {trigger.author} · peak {trigger.peak.toFixed(2)} (corpus max {trigger.corpusMax.toFixed(2)})
            </div>
          </div>
        ))}
      </div>

      {canTest && (
        <div className="mt-2 flex flex-col gap-y-1.5 border-t border-slate-100 pt-2">
          <textarea
            className="w-full resize-none rounded border border-slate-200 px-2 py-1.5 text-[12px] focus:border-sky-400 focus:outline-none focus:ring-0"
            rows={3}
            maxLength={TRIGGER_MAX_TEXT_LENGTH}
            placeholder="Text you think will make this neuron fire"
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Trigger text"
          />
          <input
            className="w-full rounded border border-slate-200 px-2 py-1.5 text-[12px] focus:border-sky-400 focus:outline-none focus:ring-0"
            maxLength={TRIGGER_MAX_MEANING_LENGTH}
            placeholder="What you think it means"
            value={meaning}
            onChange={(e) => setMeaning(e.target.value)}
            aria-label="Proposed meaning"
          />
          <Button
            size="sm"
            disabled={isSharing || !text.trim() || !meaning.trim()}
            onClick={share}
            className="self-end"
          >
            {isSharing ? <LoadingSpinner size={14} /> : user ? 'Run and share' : 'Sign in to share'}
          </Button>
        </div>
      )}
    </div>
  );
}
