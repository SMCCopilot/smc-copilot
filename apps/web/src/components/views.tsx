'use client';
import {
  ArrowLeftRight,
  Bell,
  BellRing,
  BookOpen,
  Brain,
  CheckCheck,
  ClipboardCheck,
  Eye,
  Lightbulb,
  NotebookPen,
  ScanSearch,
  Target,
  XCircle,
} from 'lucide-react';
import { type ComponentType, type ReactNode, useMemo, useState } from 'react';
import { ApiError } from '../lib/errors';
import { formatPrice } from '../lib/overlays';
import { useInstruments } from '../lib/queries';
import {
  type JournalEntry,
  notificationText,
  type TradeRow,
  useAddNote,
  useCloseTrade,
  useJournal,
  useJournalSummary,
  useNotifications,
  useReadAll,
  useTrades,
} from '../lib/records';
import { percent } from '../lib/wording';
import { EmptyState, FilterChips, PageTitle, Pill, SkeletonList, Stat } from './kit';

/** A full-width page: a scrolling area with a centred column, so wide screens never stretch the content thin. */
const Page = ({ children }: { children: ReactNode }) => (
  <main id="main" tabIndex={-1} className="scroll-thin min-h-0 flex-1 overflow-auto">
    <div className="mx-auto w-full max-w-5xl px-4 py-5 sm:px-6">{children}</div>
  </main>
);

const when = (iso: string) => new Date(iso).toLocaleString();

/** "5 min ago", "yesterday": quicker to read than a full date; the full date is in the tooltip. */
function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 172_800) return 'yesterday';
  if (s < 604_800) return `${Math.floor(s / 86_400)} days ago`;
  return new Date(iso).toLocaleDateString();
}

export function NoteForm({ setupId, compact }: { setupId?: string; compact?: boolean }) {
  const add = useAddNote();
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState('');
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const list = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (!notes.trim()) return;
    add.mutate(
      { notes: notes.trim(), tags: list, ...(setupId ? { setupId } : {}) },
      {
        onSuccess: () => {
          setNotes('');
          setTags('');
        },
      },
    );
  }
  const k = compact ? 'c' : 'p';
  return (
    <form onSubmit={submit} className="surface-card p-4">
      <label htmlFor={`note-${k}`} className="text-sm font-semibold">
        Quick note
      </label>
      <p className="text-xs text-muted">What did you see, and what are you waiting for?</p>
      <textarea
        id={`note-${k}`}
        value={notes}
        maxLength={4000}
        rows={compact ? 4 : 5}
        placeholder="For example: waited for the sweep of the equal lows before looking for a buy."
        onChange={(e) => setNotes(e.target.value)}
        className="field mt-2 resize-y"
      />
      <label htmlFor={`tags-${k}`} className="mt-3 block text-xs font-medium text-muted">
        Tags, separated by commas
      </label>
      <input
        id={`tags-${k}`}
        value={tags}
        placeholder="patience, sweep"
        onChange={(e) => setTags(e.target.value)}
        className="field mt-1"
      />
      {add.error && (
        <p role="alert" className="mt-2 text-warn-text">
          {add.error instanceof ApiError ? add.error.message : 'Could not save the note.'}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted">Never paste seed phrases or keys. They are refused.</p>
        <button
          type="submit"
          disabled={add.isPending || !notes.trim()}
          className="btn-primary shrink-0 px-4 py-2"
        >
          {add.isPending ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </form>
  );
}

const KIND: Record<
  string,
  {
    label: string;
    icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    group: string;
  }
> = {
  SETUP_SHOWN: { label: 'Idea shown', icon: Lightbulb, group: 'Ideas' },
  SETUP_REJECTED: { label: 'Idea rejected', icon: XCircle, group: 'Ideas' },
  GATE: { label: 'Confirmation', icon: ClipboardCheck, group: 'Trades' },
  TRADE: { label: 'Trade', icon: Target, group: 'Trades' },
  NOTE: { label: 'Note', icon: NotebookPen, group: 'Notes' },
  AI_REVIEW: { label: 'AI review', icon: Brain, group: 'Ideas' },
  EXPLAIN: { label: 'Chart explained', icon: ScanSearch, group: 'Ideas' },
};
const GROUPS = ['All', 'Notes', 'Trades', 'Ideas'] as const;

function Entry({ e }: { e: JournalEntry }) {
  const k = KIND[e.kind] ?? { label: e.kind, icon: Eye, group: 'Ideas' };
  const Icon = k.icon;
  return (
    <li className="surface-card rise flex gap-3 p-3.5">
      <span className="brand-soft grid size-9 shrink-0 place-items-center rounded-full text-accent-text">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center justify-between gap-2 text-xs">
          <span className="font-semibold text-fg">{k.label}</span>
          <time dateTime={e.createdAt} title={when(e.createdAt)} className="text-muted">
            {ago(e.createdAt)}
          </time>
        </p>
        {e.notes && <p className="mt-1 whitespace-pre-wrap">{e.notes}</p>}
        {e.tags.length > 0 && (
          <p className="mt-2 flex flex-wrap gap-1.5">
            {e.tags.map((t) => (
              <Pill key={t} tone="accent">
                #{t}
              </Pill>
            ))}
          </p>
        )}
      </div>
    </li>
  );
}

export function JournalView() {
  const j = useJournal();
  const s = useJournalSummary();
  const [group, setGroup] = useState<(typeof GROUPS)[number]>('All');
  const items = useMemo(
    () =>
      (j.data ?? []).filter((e) => group === 'All' || (KIND[e.kind]?.group ?? 'Ideas') === group),
    [j.data, group],
  );
  return (
    <Page>
      <PageTitle
        id="journal"
        icon={BookOpen}
        title="Journal"
        subtitle="Your notes, the ideas you were shown and the trades you logged"
        help={
          <>
            Everything you do here is recorded in one timeline: notes you write, trade ideas the
            analysis showed or rejected, charts you had explained and trades you logged. Reviewing
            it is how traders spot their own habits. Only you can see it.
          </>
        }
      />
      <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Closed trades" value={s.data?.closedTrades ?? '–'} />
        <Stat label="Open trades" value={s.data?.openTrades ?? '–'} />
        <Stat label="Ideas shown" value={s.data?.setupsShown ?? '–'} />
        <Stat
          label="Win rate"
          value={s.data ? (s.data.winRate === null ? '–' : percent(s.data.winRate)) : '–'}
          hint={
            s.data && s.data.winRate === null
              ? 'Shown once there are enough closed trades'
              : 'Of your closed trades'
          }
        />
      </dl>
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-label="Timeline" className="order-2 min-w-0 lg:order-1">
          <FilterChips
            label="Filter the timeline"
            options={GROUPS}
            value={group}
            onChange={setGroup}
          />
          {j.isPending ? (
            <SkeletonList rows={4} />
          ) : items.length ? (
            <ul className="space-y-2.5">
              {items.map((e) => (
                <Entry key={e.id} e={e} />
              ))}
            </ul>
          ) : (
            <EmptyState icon={BookOpen} title="Nothing here yet">
              Notes you write, ideas you are shown and trades you log will appear here as a
              timeline.
            </EmptyState>
          )}
        </section>
        <div className="order-1 lg:order-2">
          <div className="lg:sticky lg:top-0">
            <NoteForm />
          </div>
        </div>
      </div>
    </Page>
  );
}

function CloseForm({ id, onDone }: { id: string; onDone: () => void }) {
  const close = useCloseTrade();
  const [px, setPx] = useState('');
  const [reason, setReason] = useState<'TP' | 'SL' | 'MANUAL'>('MANUAL');
  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-3 rounded-ctl border border-line bg-s2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(px);
        if (Number.isFinite(n) && n > 0)
          close.mutate({ id, exitPrice: n, reason }, { onSuccess: onDone });
      }}
    >
      <label className="text-xs font-medium text-muted">
        Exit price
        <input
          value={px}
          inputMode="decimal"
          onChange={(e) => setPx(e.target.value)}
          className="field num mt-1 block w-36 text-fg"
        />
      </label>
      <label className="text-xs font-medium text-muted">
        Reason
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as typeof reason)}
          className="field mt-1 block text-fg"
        >
          <option value="MANUAL">Closed by hand</option>
          <option value="TP">Target hit</option>
          <option value="SL">Stop hit</option>
        </select>
      </label>
      <button type="submit" disabled={close.isPending} className="btn-primary px-4 py-2">
        Close trade
      </button>
      <button type="button" onClick={onDone} className="btn-ghost px-3 py-2">
        Cancel
      </button>
      {close.error && (
        <p role="alert" className="w-full text-warn-text">
          {close.error instanceof ApiError ? close.error.message : 'Could not close the trade.'}
        </p>
      )}
    </form>
  );
}

const FILTERS = ['All', 'Open', 'Closed'] as const;

export function TradesView() {
  const t = useTrades();
  const s = useJournalSummary();
  const inst = useInstruments(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const name = (id: string) => inst.data?.items.find((i) => i.id === id)?.canonical ?? 'Market';
  // Prices are stored as the plan computed them (many decimals); show them at the market's own precision.
  const price = (id: string, v: number | null) =>
    v === null
      ? '–'
      : formatPrice(v, inst.data?.items.find((i) => i.id === id)?.pricePrecision ?? 2);
  const rows = (t.data ?? []).filter(
    (r) => filter === 'All' || (filter === 'Open' ? r.status === 'OPEN' : r.status === 'CLOSED'),
  );
  const totalR = s.data?.totalR ?? null;
  return (
    <Page>
      <PageTitle
        id="trades"
        icon={ArrowLeftRight}
        title="Trades"
        subtitle="Trades you chose to log. Nothing here places or changes an order."
        help={
          <>
            This is your own record. When you log a trade from the <b>Setup</b> tab it appears here.
            Come back when you leave the trade and record the exit price; the app works out how many{' '}
            <b>R</b> you made or lost, where <b>1R</b> is the amount you risked, after fees. It
            never trades for you.
          </>
        }
      />
      <dl className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Result so far"
          value={totalR === null ? '–' : `${totalR >= 0 ? '+' : ''}${totalR.toFixed(2)}R`}
          hint="Net of fees"
          {...(totalR === null
            ? {}
            : { tone: totalR >= 0 ? ('bull' as const) : ('bear' as const) })}
        />
        <Stat label="Closed" value={s.data?.closedTrades ?? '–'} />
        <Stat label="Open" value={s.data?.openTrades ?? '–'} />
        <Stat
          label="Win rate"
          value={s.data ? (s.data.winRate === null ? '–' : percent(s.data.winRate)) : '–'}
          hint={s.data && s.data.winRate === null ? 'Needs more closed trades' : undefined}
        />
      </dl>
      <FilterChips label="Filter trades" options={FILTERS} value={filter} onChange={setFilter} />
      {t.isPending ? (
        <SkeletonList rows={3} />
      ) : rows.length ? (
        <ul className="space-y-3">
          {rows.map((r) => (
            <TradeCard
              key={r.id}
              r={r}
              name={name(r.instrumentId)}
              price={(v) => price(r.instrumentId, v)}
              closing={closing === r.id}
              onClose={() => setClosing(r.id)}
              onDone={() => setClosing(null)}
            />
          ))}
        </ul>
      ) : (
        <EmptyState
          icon={ArrowLeftRight}
          title={t.data?.length ? 'No trades in this view' : 'No trades logged yet'}
        >
          {t.data?.length
            ? 'Try another filter.'
            : 'When you log a trade from the Setup tab on the chart, it will show up here.'}
        </EmptyState>
      )}
    </Page>
  );
}

function TradeCard({
  r,
  name,
  price,
  closing,
  onClose,
  onDone,
}: {
  r: TradeRow;
  name: string;
  price: (v: number | null) => string;
  closing: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const long = r.direction === 'LONG';
  const open = r.status === 'OPEN';
  const win = r.realizedR !== null && r.realizedR >= 0;
  return (
    <li className={`surface-card rise p-4 ${open ? 'border-l-[3px] border-l-accent' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="num text-[15px] font-semibold">{name}</span>
        <Pill tone={long ? 'bull' : 'bear'}>{long ? 'Long (buy)' : 'Short (sell)'}</Pill>
        <Pill tone={open ? 'accent' : undefined}>{open ? 'Open' : 'Closed'}</Pill>
        <span className="ml-auto text-right">
          {r.realizedR === null ? (
            <span className="text-xs text-muted">{open ? 'Running' : 'No result'}</span>
          ) : (
            <span
              className={`num text-xl font-semibold ${win ? 'text-bull-text' : 'text-bear-text'}`}
            >
              {r.realizedR >= 0 ? '+' : ''}
              {r.realizedR.toFixed(2)}R
            </span>
          )}
        </span>
      </div>
      <dl className="num mt-3 grid grid-cols-3 gap-3 rounded-ctl bg-s2 p-3 text-sm">
        <div>
          <dt className="text-xs text-muted">Entry</dt>
          <dd className="font-medium">{price(r.entryPrice)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Stop</dt>
          <dd className="font-medium">{price(r.stopPrice)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Exit</dt>
          <dd className="font-medium">{price(r.exitPrice)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-xs text-muted">
        Opened {when(r.openedAt)}
        {r.closedAt ? ` · closed ${when(r.closedAt)}` : ''}
      </p>
      {open &&
        (closing ? (
          <CloseForm id={r.id} onDone={onDone} />
        ) : (
          <button type="button" onClick={onClose} className="btn-ghost mt-3 px-3.5 py-1.5">
            Record the exit
          </button>
        ))}
    </li>
  );
}

export function NotificationsView() {
  const n = useNotifications();
  const readAll = useReadAll();
  const unread = n.data?.filter((x) => !x.read).length ?? 0;
  return (
    <Page>
      <PageTitle
        id="notifications"
        icon={Bell}
        title="Notifications"
        subtitle={unread > 0 ? `${unread} unread` : 'You are all caught up'}
        help={
          <>
            Alerts about things that matter to you: a trade idea appearing or changing, a session
            ending, or a limit being reached. Unread ones are highlighted.
          </>
        }
        actions={
          <button
            type="button"
            disabled={unread === 0 || readAll.isPending}
            onClick={() => readAll.mutate()}
            className="btn-ghost flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <CheckCheck className="size-3.5" aria-hidden /> Mark all as read
          </button>
        }
      />
      {n.isPending ? (
        <SkeletonList rows={3} />
      ) : n.data?.length ? (
        <ul className="space-y-2">
          {n.data.map((x) => (
            <li
              key={x.id}
              className={`surface-card flex items-start gap-3 p-3.5 ${x.read ? 'opacity-70' : ''}`}
            >
              <span
                className={`grid size-8 shrink-0 place-items-center rounded-full ${x.read ? 'bg-s3 text-muted' : 'brand-soft text-accent-text'}`}
              >
                <BellRing className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p>{notificationText(x)}</p>
                <time
                  className="text-xs text-muted"
                  dateTime={x.createdAt}
                  title={when(x.createdAt)}
                >
                  {ago(x.createdAt)}
                </time>
              </div>
              {!x.read && (
                <span className="brand-bg mt-2 size-2 shrink-0 rounded-full">
                  <span className="sr-only">Unread</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon={Bell} title="No notifications">
          Alerts about your trade ideas and sessions will show up here.
        </EmptyState>
      )}
    </Page>
  );
}
