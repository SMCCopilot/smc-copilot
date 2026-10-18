'use client';
import { useState } from 'react';
import { ApiError } from '../lib/errors';
import { formatPrice } from '../lib/overlays';
import { useInstruments } from '../lib/queries';
import {
  notificationText,
  useAddNote,
  useCloseTrade,
  useJournal,
  useJournalSummary,
  useNotifications,
  useReadAll,
  useTrades,
} from '../lib/records';
import { useSelection } from '../lib/sessions';
import { useUi } from '../lib/ui';
import { percent } from '../lib/wording';

const Page = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto p-4">
    <h1 className="mb-3 text-lg font-semibold">{title}</h1>
    {children}
  </main>
);
const Muted = ({ children }: { children: React.ReactNode }) => (
  <p className="text-muted">{children}</p>
);
const when = (iso: string) => new Date(iso).toLocaleString();

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
  return (
    <form onSubmit={submit} className="rounded-card border border-line bg-s2 p-3">
      <label htmlFor={`note-${compact ? 'c' : 'p'}`} className="text-xs text-muted">
        Quick note
      </label>
      <textarea
        id={`note-${compact ? 'c' : 'p'}`}
        value={notes}
        maxLength={4000}
        rows={compact ? 3 : 4}
        onChange={(e) => setNotes(e.target.value)}
        className="mt-1 w-full resize-y rounded-ctl border border-line bg-s3 px-2 py-1.5"
      />
      <label htmlFor={`tags-${compact ? 'c' : 'p'}`} className="mt-2 block text-xs text-muted">
        Tags, separated by commas
      </label>
      <input
        id={`tags-${compact ? 'c' : 'p'}`}
        value={tags}
        onChange={(e) => setTags(e.target.value)}
        className="mt-1 w-full rounded-ctl border border-line bg-s3 px-2 py-1.5"
      />
      {add.error && (
        <p role="alert" className="mt-2 text-warn-text">
          {add.error instanceof ApiError ? add.error.message : 'Could not save the note.'}
        </p>
      )}
      <button
        type="submit"
        disabled={add.isPending || !notes.trim()}
        className="mt-2 rounded-ctl bg-accent-strong px-3 py-1.5 font-medium text-white disabled:opacity-50"
      >
        {add.isPending ? 'Saving…' : 'Save note'}
      </button>
      <p className="mt-2 text-xs text-muted">Never paste seed phrases or keys. They are refused.</p>
    </form>
  );
}

const KIND: Record<string, string> = {
  SETUP_SHOWN: 'Scenario shown',
  SETUP_REJECTED: 'Scenario rejected',
  GATE: 'Confirmation',
  TRADE: 'Trade',
  NOTE: 'Note',
  AI_REVIEW: 'AI review',
  EXPLAIN: 'Chart explained',
};

export function JournalView() {
  const j = useJournal();
  const s = useJournalSummary();
  return (
    <Page title="Journal">
      {s.data && (
        <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Closed trades', s.data.closedTrades],
            ['Open trades', s.data.openTrades],
            ['Scenarios shown', s.data.setupsShown],
            ['Win rate', s.data.winRate === null ? 'Not enough history' : percent(s.data.winRate)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-card border border-line bg-s2 p-3">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="num mt-1">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mb-4 max-w-xl">
        <NoteForm />
      </div>
      {j.isPending ? (
        <Muted>Loading…</Muted>
      ) : j.data?.length ? (
        <ul className="space-y-2">
          {j.data.map((e) => (
            <li key={e.id} className="rounded-card border border-line bg-s2 p-3">
              <p className="flex justify-between gap-2 text-xs text-muted">
                <span>{KIND[e.kind] ?? e.kind}</span>
                <time dateTime={e.createdAt}>{when(e.createdAt)}</time>
              </p>
              {e.notes && <p className="mt-1 whitespace-pre-wrap">{e.notes}</p>}
              {e.tags.length > 0 && (
                <p className="mt-1 text-xs text-muted">{e.tags.map((t) => `#${t}`).join(' ')}</p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <Muted>
          Nothing here yet. Scenarios you are shown, trades you log and your notes appear here.
        </Muted>
      )}
    </Page>
  );
}

function CloseForm({ id, onDone }: { id: string; onDone: () => void }) {
  const close = useCloseTrade();
  const [px, setPx] = useState('');
  const [reason, setReason] = useState<'TP' | 'SL' | 'MANUAL'>('MANUAL');
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(px);
        if (Number.isFinite(n) && n > 0)
          close.mutate({ id, exitPrice: n, reason }, { onSuccess: onDone });
      }}
    >
      <label className="text-xs text-muted">
        Exit price
        <input
          value={px}
          inputMode="decimal"
          onChange={(e) => setPx(e.target.value)}
          className="num mt-1 block w-32 rounded-ctl border border-line bg-s3 px-2 py-1.5 text-fg"
        />
      </label>
      <label className="text-xs text-muted">
        Reason
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value as typeof reason)}
          className="mt-1 block rounded-ctl border border-line bg-s3 px-2 py-1.5 text-fg"
        >
          <option value="MANUAL">Manual</option>
          <option value="TP">Target hit</option>
          <option value="SL">Stop hit</option>
        </select>
      </label>
      <button
        type="submit"
        disabled={close.isPending}
        className="rounded-ctl bg-accent-strong px-3 py-1.5 text-white disabled:opacity-50"
      >
        Close trade
      </button>
      {close.error && (
        <p role="alert" className="w-full text-warn-text">
          {close.error instanceof ApiError ? close.error.message : 'Could not close the trade.'}
        </p>
      )}
    </form>
  );
}

export function TradesView() {
  const t = useTrades();
  const s = useJournalSummary();
  const inst = useInstruments(false);
  const [closing, setClosing] = useState<string | null>(null);
  const name = (id: string) => inst.data?.items.find((i) => i.id === id)?.canonical ?? 'Instrument';
  // Prices are stored as the plan computed them (many decimals); show them at the market's own precision.
  const price = (id: string, v: number | null) =>
    v === null
      ? '–'
      : formatPrice(v, inst.data?.items.find((i) => i.id === id)?.pricePrecision ?? 2);
  return (
    <Page title="Trades">
      <p className="mb-3 text-muted">
        A record of trades you chose to log. Nothing here places or changes an order anywhere.
      </p>
      {s.data && (
        <p className="mb-3">
          Realised R, net of fees:{' '}
          <strong className="num">
            {s.data.totalR === null ? 'none measured yet' : `${s.data.totalR.toFixed(2)}R`}
          </strong>
          <span className="text-muted"> · {s.data.closedTrades} closed</span>
        </p>
      )}
      {t.isPending ? (
        <Muted>Loading…</Muted>
      ) : t.data?.length ? (
        <ul className="space-y-2">
          {t.data.map((r) => (
            <li key={r.id} className="rounded-card border border-line bg-s2 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="num font-medium">{name(r.instrumentId)}</span>
                <span className="text-xs text-muted">
                  {r.direction === 'LONG' ? 'Long' : 'Short'} ·{' '}
                  {r.status === 'OPEN' ? 'open' : 'closed'}
                </span>
              </div>
              <dl className="num mt-1 grid grid-cols-2 gap-x-4 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted">Entry</dt>
                  <dd>{price(r.instrumentId, r.entryPrice)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Stop</dt>
                  <dd>{price(r.instrumentId, r.stopPrice)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Exit</dt>
                  <dd>{price(r.instrumentId, r.exitPrice)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Net R</dt>
                  <dd>{r.realizedR === null ? '–' : `${r.realizedR.toFixed(2)}R`}</dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-muted">
                Opened {when(r.openedAt)}
                {r.closedAt ? ` · closed ${when(r.closedAt)}` : ''}
              </p>
              {r.status === 'OPEN' &&
                (closing === r.id ? (
                  <CloseForm id={r.id} onDone={() => setClosing(null)} />
                ) : (
                  <button
                    type="button"
                    onClick={() => setClosing(r.id)}
                    className="mt-2 rounded-ctl border border-line px-3 py-1 hover:bg-s3"
                  >
                    Record the exit
                  </button>
                ))}
            </li>
          ))}
        </ul>
      ) : (
        <Muted>No trades logged yet.</Muted>
      )}
    </Page>
  );
}

export function NotificationsView() {
  const n = useNotifications();
  const readAll = useReadAll();
  const unread = n.data?.filter((x) => !x.read).length ?? 0;
  return (
    <Page title="Notifications">
      <button
        type="button"
        disabled={unread === 0 || readAll.isPending}
        onClick={() => readAll.mutate()}
        className="mb-3 rounded-ctl border border-line px-3 py-1.5 hover:bg-s3 disabled:opacity-50"
      >
        Mark all as read
      </button>
      {n.isPending ? (
        <Muted>Loading…</Muted>
      ) : n.data?.length ? (
        <ul className="space-y-2">
          {n.data.map((x) => (
            <li
              key={x.id}
              className={`rounded-card border border-line p-3 ${x.read ? 'bg-s1 text-muted' : 'bg-s2'}`}
            >
              <p>{notificationText(x)}</p>
              <time className="text-xs text-muted" dateTime={x.createdAt}>
                {when(x.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>No notifications.</Muted>
      )}
    </Page>
  );
}

export function InstrumentsView() {
  const inst = useInstruments();
  const sel = useSelection();
  const setView = useUi((s) => s.setView);
  return (
    <Page title="Instruments">
      <p className="mb-3 text-muted">
        Pick the market to study. “Analysis only” means raw prices are not shown for that venue;
        levels and zones still are, and you can share your own chart to explain.
      </p>
      {inst.isPending ? (
        <Muted>Loading…</Muted>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {inst.data?.items.map((i) => (
            <li key={i.id}>
              <button
                type="button"
                disabled={sel.sessionId !== null}
                aria-pressed={sel.instrumentId === i.id}
                onClick={() => {
                  sel.set({ instrumentId: i.id });
                  setView('room');
                }}
                className={`flex w-full items-center justify-between gap-2 rounded-card border border-line px-3 py-2.5 text-left hover:bg-s3 disabled:opacity-60 ${sel.instrumentId === i.id ? 'accent-soft' : 'bg-s2'}`}
              >
                <span className="num">{i.canonical}</span>
                <span className="text-xs text-muted">
                  {i.rawDataAllowed ? 'Full data' : 'Analysis only'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {sel.sessionId && (
        <p className="mt-3 text-xs text-muted">End the current session to change the instrument.</p>
      )}
    </Page>
  );
}
