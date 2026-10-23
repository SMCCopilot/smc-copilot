'use client';
import * as Tabs from '@radix-ui/react-tabs';
import { useState } from 'react';
import { useLive } from '../lib/live';
import { useAnalysis } from '../lib/market';
import { useInstruments } from '../lib/queries';
import { useSelection } from '../lib/sessions';
import { type CanvasTab, pickSetup, useUi } from '../lib/ui';
import { ChangesTab, EvidenceTab, PlanTab, SetupPicker, StatsTab } from './canvas-tabs';
import { Dock } from './dock';
import { GateDialog } from './gate-dialog';
import { NoteForm } from './views';

/** The tabs of the right-hand panel: what each is called on screen, and what it is for. */
const TABS: { key: CanvasTab; label: string; hint: string }[] = [
  {
    key: 'Assistant',
    label: 'Assistant',
    hint: 'Ask questions about the chart, by typing or by voice',
  },
  {
    key: 'Plan',
    label: 'Setup',
    hint: 'The trade idea the analysis found: where to enter, where it is wrong, where to aim',
  },
  {
    key: 'Evidence',
    label: 'Why',
    hint: 'The reasons behind the idea, and ideas that were rejected',
  },
  { key: 'Changes', label: 'Changes', hint: 'What changed on the chart recently' },
  { key: 'Stats', label: 'Stats', hint: 'How often similar ideas worked in the past' },
  { key: 'Journal', label: 'Notes', hint: 'Write a note about this idea' },
];

export function Canvas() {
  const sel = useSelection();
  const ui = useUi();
  const live = useLive((s) => s.state);
  const inst = useInstruments(false);
  const analysis = useAnalysis(sel.instrumentId, sel.tf);
  const a = analysis.data;
  const liveSetups = (a?.setups ?? []).filter(
    (s) => !ui.dismissed.includes(s.id) && (s.state === 'ARMED' || s.state === 'TRIGGERED'),
  );
  const setup = pickSetup(a, ui.setupId, ui.dismissed);
  const [open, setOpen] = useState(false);
  const precision = inst.data?.items.find((i) => i.id === sel.instrumentId)?.pricePrecision ?? 2;
  const canLog = Boolean(setup?.plan) && live !== 'STALE' && live !== 'ENDED';

  return (
    <div className="flex h-full min-h-0 flex-col bg-s1">
      <Tabs.Root
        value={ui.tab}
        onValueChange={(v) => ui.setTab(v as CanvasTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List
          aria-label="Canvas"
          className="flex gap-1 overflow-x-auto border-b border-line px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t.key}
              value={t.key}
              title={t.hint}
              className="shrink-0 whitespace-nowrap rounded-t-md px-2 py-2 text-[13px] text-muted data-[state=active]:accent-soft data-[state=active]:text-accent-text"
            >
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content
          value="Assistant"
          forceMount
          className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden"
        >
          <Dock />
        </Tabs.Content>
        <div
          className={`min-h-0 flex-1 overflow-auto p-4 ${ui.tab === 'Assistant' ? 'hidden' : ''}`}
        >
          {!sel.instrumentId ? (
            <p className="text-muted">Pick an instrument to see its analysis.</p>
          ) : (
            <>
              <SetupPicker setups={liveSetups} current={setup} />
              <Tabs.Content value="Plan">
                <PlanTab setup={setup} />
              </Tabs.Content>
              <Tabs.Content value="Evidence">
                <EvidenceTab setup={setup} analysis={a} />
              </Tabs.Content>
              <Tabs.Content value="Changes">
                <ChangesTab analysis={a} />
              </Tabs.Content>
              <Tabs.Content value="Stats">
                <StatsTab setup={setup} />
              </Tabs.Content>
              <Tabs.Content value="Journal">
                <NoteForm compact {...(setup ? { setupId: setup.id } : {})} />
              </Tabs.Content>
            </>
          )}
        </div>
      </Tabs.Root>
      <footer
        className={`items-center justify-between gap-3 border-t border-line p-3 ${ui.tab === 'Plan' || ui.tab === 'Evidence' ? 'flex' : 'hidden'}`}
      >
        <p className="text-xs text-muted">
          {setup
            ? 'Rules check: all hard filters passed. This is not a prediction.'
            : 'Rules check: no scenario selected.'}
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={!setup}
            onClick={() => setup && ui.dismiss(setup.id)}
            className="rounded-ctl border border-line px-3 py-1.5 text-muted hover:bg-s3 disabled:opacity-60"
          >
            Dismiss
          </button>
          <button
            type="button"
            disabled={!canLog}
            title={
              canLog ? undefined : live === 'STALE' ? 'The data feed is stale' : 'No plan to log'
            }
            onClick={() => setOpen(true)}
            className="rounded-ctl bg-accent-strong px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            Log trade
          </button>
        </div>
      </footer>
      {open && setup?.plan && (
        <GateDialog setup={setup} precision={precision} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
