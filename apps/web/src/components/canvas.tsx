'use client';
import * as Tabs from '@radix-ui/react-tabs';
import { Info } from 'lucide-react';

const TABS = ['Plan', 'Evidence', 'Changes', 'Stats', 'Journal'] as const;

const EMPTY: Record<(typeof TABS)[number], string> = {
  Plan: 'No setup selected. Entry, stop, targets and invalidation appear here when the analysis has a setup.',
  Evidence:
    'Structure events and the reasons behind a setup, including why a setup was rejected, appear here.',
  Changes: 'What changed since the last candle close appears here.',
  Stats: 'Not enough history. A base rate is shown only when the API reports at least 30 samples.',
  Journal: 'A quick note and tags for the current setup.',
};

export function Canvas() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-s1">
      <Tabs.Root defaultValue="Plan" className="flex min-h-0 flex-1 flex-col">
        <Tabs.List aria-label="Canvas" className="flex gap-1 border-b border-line px-3 pt-3 pr-10">
          {TABS.map((t) => (
            <Tabs.Trigger
              key={t}
              value={t}
              className="rounded-t-md px-3 py-2 text-muted data-[state=active]:accent-soft data-[state=active]:text-accent"
            >
              {t}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {TABS.map((t) => (
          <Tabs.Content key={t} value={t} className="min-h-0 flex-1 overflow-auto p-4">
            <p className="text-muted">{EMPTY[t]}</p>
            {t === 'Stats' && (
              <p className="mt-3 flex gap-2 rounded-card border border-line bg-s2 p-3">
                <Info className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                No proven edge yet. This notice will come from the API result once Stats is wired
                (F2).
              </p>
            )}
          </Tabs.Content>
        ))}
      </Tabs.Root>
      <footer className="flex items-center justify-between gap-3 border-t border-line p-3">
        <p className="text-xs text-muted">Rules check unavailable: no setup selected.</p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled
            className="rounded-ctl border border-line px-3 py-1.5 text-muted disabled:opacity-60"
          >
            Dismiss
          </button>
          <button
            type="button"
            disabled
            title="No plan to log"
            className="rounded-ctl bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            Log trade
          </button>
        </div>
      </footer>
    </div>
  );
}
