'use client';
import { useChat } from '../lib/chat';

/** Shown only when it matters: close to the daily AI limit or past it. */
export function BudgetMeter() {
  const b = useChat((s) => s.budget);
  // Shown only when it matters: close to the daily AI limit or past it.
  if (!b || (b.state !== 'SOFT' && b.state !== 'HARD')) return null;
  const pct = b && b.limitUsd > 0 ? Math.min(100, Math.round((b.spentUsd / b.limitUsd) * 100)) : 0;
  const warn = b?.state === 'SOFT' || b?.state === 'HARD';
  return (
    <div className="rounded-card border border-line bg-s2 p-3">
      <div className="flex justify-between text-xs">
        <span>AI budget today</span>
        <span className={`num ${warn ? 'text-warn-text' : 'text-muted'}`}>
          {b ? `${b.spentUsd.toFixed(2)} of ${b.limitUsd.toFixed(2)}` : 'no AI use yet'}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 rounded-full bg-s3"
        role="progressbar"
        aria-label="AI budget used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div
          className={`h-full rounded-full ${warn ? 'bg-warn' : 'bg-accent-strong'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {b?.state === 'HARD' && (
        <p className="mt-1 text-xs text-warn-text">Limit reached. Analysis still works.</p>
      )}
      {b?.state === 'SOFT' && (
        <p className="mt-1 text-xs text-warn-text">Close to today's limit.</p>
      )}
    </div>
  );
}
