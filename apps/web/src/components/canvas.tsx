'use client';
import * as Tabs from '@radix-ui/react-tabs';
import { BarChart3, History, Lightbulb, NotebookPen, Sparkles, Target } from 'lucide-react';
import { type ComponentType, type ReactNode, useState } from 'react';
import { useLive } from '../lib/live';
import { useAnalysis } from '../lib/market';
import { useInstruments } from '../lib/queries';
import { useSelection } from '../lib/sessions';
import { type CanvasTab, pickSetup, useUi } from '../lib/ui';
import { ChangesTab, EvidenceTab, PlanTab, SetupPicker, StatsTab } from './canvas-tabs';
import { Dock } from './dock';
import { GateDialog } from './gate-dialog';
import { PageHead, SkeletonList } from './kit';
import { NoteForm } from './views';

interface TabDef {
  key: CanvasTab;
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  subtitle: string;
  help: ReactNode;
}

/** The tabs of the right-hand panel: what each is called, and what it is for (shown by its "?" button). */
const TABS: TabDef[] = [
  {
    key: 'Assistant',
    label: 'Assistant',
    icon: Sparkles,
    title: 'Assistant',
    subtitle: 'Ask about the chart in plain words',
    help: (
      <>
        Ask questions about this market by typing or by clicking the microphone. The assistant
        explains what the analysis found: the trend, the key levels and any trade idea. It only uses
        the analysis' own facts, never makes up prices, and never trades for you.
      </>
    ),
  },
  {
    key: 'Plan',
    label: 'Setup',
    icon: Target,
    title: 'Setup',
    subtitle: 'The trade idea the analysis found',
    help: (
      <>
        A trade idea in plain terms: where price should come back to (the <b>entry zone</b>), where
        the idea is <b>wrong</b> (the stop) and where it may <b>go</b> (the targets). <b>Quality</b>{' '}
        shows how many of the rules the idea meets; A is the strongest. It is a scenario to study,
        not a prediction or advice.
      </>
    ),
  },
  {
    key: 'Evidence',
    label: 'Why',
    icon: Lightbulb,
    title: 'Why',
    subtitle: 'The reasons behind the idea',
    help: (
      <>
        The reasons for the current idea: which zones and levels it is built on, the latest breaks
        of structure, and ideas the analysis looked at but <b>rejected</b>, each with the reason.
      </>
    ),
  },
  {
    key: 'Changes',
    label: 'Changes',
    icon: History,
    title: 'Changes',
    subtitle: 'What just changed on the chart',
    help: (
      <>
        A running log of what changed: new structure breaks, liquidity taken, zones that formed.{' '}
        <b>New</b> marks what happened on the latest candle.
      </>
    ),
  },
  {
    key: 'Stats',
    label: 'Stats',
    icon: BarChart3,
    title: 'Stats',
    subtitle: 'How often similar ideas worked',
    help: (
      <>
        How often ideas like this one worked in the past. A percentage is only shown when there are
        at least <b>30</b> past cases, because fewer would be misleading. Past results are not a
        forecast.
      </>
    ),
  },
  {
    key: 'Journal',
    label: 'Notes',
    icon: NotebookPen,
    title: 'Notes',
    subtitle: 'Write down your thinking',
    help: (
      <>
        Write a note about this idea or the market. Notes are saved to your <b>Journal</b> (left
        menu) with tags so you can find them later. Never paste seed phrases or keys; they are
        refused.
      </>
    ),
  },
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
  const current = TABS.find((t) => t.key === ui.tab) ?? (TABS[0] as TabDef);
  const assistant = TABS[0] as TabDef;
  const showFooter = ui.tab === 'Plan' || ui.tab === 'Evidence';
  const body = (key: CanvasTab) => {
    if (analysis.isPending && sel.instrumentId) return <SkeletonList rows={5} />;
    switch (key) {
      case 'Plan':
        return <PlanTab setup={setup} />;
      case 'Evidence':
        return <EvidenceTab setup={setup} analysis={a} />;
      case 'Changes':
        return <ChangesTab analysis={a} />;
      case 'Stats':
        return <StatsTab setup={setup} />;
      case 'Journal':
        return <NoteForm compact {...(setup ? { setupId: setup.id } : {})} />;
      default:
        return null;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-s1">
      <Tabs.Root
        value={ui.tab}
        onValueChange={(v) => ui.setTab(v as CanvasTab)}
        className="@container flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List
          aria-label="Panel"
          className="scroll-thin flex gap-1 overflow-x-auto border-b border-line px-2.5 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t.key}
              value={t.key}
              title={`${t.label}: ${t.subtitle}`}
              aria-label={t.label}
              className="group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-ctl px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-s3 hover:text-fg data-[state=active]:brand-soft data-[state=active]:text-accent-text data-[state=active]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_28%,transparent)]"
            >
              <t.icon className="size-[15px]" aria-hidden />
              {/* On a narrow panel only the open tab shows its name; the others keep their icon and a tooltip. */}
              <span className={ui.tab === t.key ? '' : 'hidden @[28rem]:inline'}>{t.label}</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content
          value="Assistant"
          forceMount
          className="min-h-0 flex-1 flex-col data-[state=active]:flex data-[state=inactive]:hidden"
        >
          <div className="px-4 pt-3">
            <PageHead
              id="Assistant"
              icon={assistant.icon}
              title={assistant.title}
              subtitle={assistant.subtitle}
              help={assistant.help}
            />
          </div>
          <Dock />
        </Tabs.Content>

        {ui.tab !== 'Assistant' && (
          <Tabs.Content
            value={current.key}
            className="scroll-thin min-h-0 flex-1 overflow-auto px-4 py-3"
          >
            <PageHead
              id={current.key}
              icon={current.icon}
              title={current.title}
              subtitle={current.subtitle}
              help={current.help}
            />
            {!sel.instrumentId ? (
              <p className="text-muted">Pick a market to see its analysis.</p>
            ) : (
              <div key={current.key} className="rise">
                {(current.key === 'Plan' || current.key === 'Evidence') && (
                  <SetupPicker setups={liveSetups} current={setup} />
                )}
                {body(current.key)}
              </div>
            )}
          </Tabs.Content>
        )}
      </Tabs.Root>

      {showFooter && (
        <footer className="flex items-center justify-between gap-3 border-t border-line bg-s1/95 p-3 backdrop-blur">
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
              className="btn-ghost px-3 py-1.5 text-muted"
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
              className="btn-primary px-3.5 py-1.5"
            >
              Log trade
            </button>
          </div>
        </footer>
      )}
      {open && setup?.plan && (
        <GateDialog setup={setup} precision={precision} onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
