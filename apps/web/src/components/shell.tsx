'use client';
import { TIMEFRAMES } from '@smc/contracts';
import {
  Bell,
  BookOpen,
  CandlestickChart,
  ChevronsRight,
  Layers,
  Menu,
  Moon,
  PanelRight,
  Plus,
  Settings,
  Sun,
  Wallet,
  X,
} from 'lucide-react';
import { type PointerEvent, useCallback, useState } from 'react';
import { ApiError } from '@/lib/errors';
import { useFeedStatus, useInstruments } from '@/lib/queries';
import { useTheme } from '@/lib/theme';
import { Canvas } from './canvas';

const NAV = [
  { label: 'Session room', icon: CandlestickChart },
  { label: 'Instruments', icon: Layers },
  { label: 'Journal', icon: BookOpen },
  { label: 'Trades', icon: ChevronsRight },
  { label: 'Settings', icon: Settings },
] as const;

const DISCLAIMER =
  'Educational analysis, not financial advice. Scenarios are not predictions. You make every decision.';

function FeedChip() {
  const { data, isError, isPending } = useFeedStatus();
  let label = 'CONNECTING';
  let tone = 'text-muted';
  if (isError) {
    label = 'NO API';
    tone = 'text-warn';
  } else if (data) {
    if (data.ingest === 'DISABLED') {
      label = 'INGEST OFF';
      tone = 'text-warn';
    } else if (data.feeds.stale > 0) {
      label = 'STALE';
      tone = 'text-warn';
    } else {
      label = 'LIVE';
      tone = 'text-fg';
    }
  }
  return (
    <span
      role="status"
      aria-label={`Feed status ${label}`}
      className={`rounded-full border border-line bg-s2 px-2.5 py-1 text-xs font-medium ${tone}`}
    >
      <span aria-hidden className="mr-1.5">
        {isPending ? '…' : '●'}
      </span>
      {label}
    </span>
  );
}

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 p-3">
      <div className="flex items-center gap-2 px-1 font-semibold">
        <span
          className="grid size-8 place-items-center rounded-ctl bg-accent text-white"
          aria-hidden
        >
          S
        </span>
        SMC Copilot
      </div>
      <button
        type="button"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-ctl border border-line bg-s2 px-3 py-2 hover:bg-s3"
      >
        <Plus className="size-4" aria-hidden /> New session
      </button>
      <ul className="flex flex-col gap-0.5">
        {NAV.map(({ label, icon: Icon }, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={onNavigate}
              aria-current={i === 0 ? 'page' : undefined}
              className={`flex w-full items-center gap-2 rounded-ctl px-3 py-2 text-left hover:bg-s3 ${i === 0 ? 'accent-soft text-accent' : ''}`}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          </li>
        ))}
      </ul>
      <div>
        <h2 className="px-3 pb-1 text-xs uppercase tracking-wide text-muted">Recent sessions</h2>
        <p className="px-3 text-muted">None yet.</p>
      </div>
      <div className="mt-auto flex flex-col gap-2">
        <div className="rounded-card border border-line bg-s2 p-3">
          <div className="flex justify-between text-xs">
            <span>AI budget today</span>
            <span className="num text-muted">after sign-in</span>
          </div>
          <div
            className="mt-2 h-1.5 rounded-full bg-s3"
            role="progressbar"
            aria-label="AI budget used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={0}
          />
        </div>
        <div className="flex items-center gap-2 rounded-ctl px-2 py-1.5 text-muted">
          <Wallet className="size-4" aria-hidden /> Not connected
        </div>
      </div>
    </nav>
  );
}

function Header({ onMenu, onCanvas }: { onMenu: () => void; onCanvas: () => void }) {
  const [theme, toggleTheme] = useTheme();
  const inst = useInstruments();
  const btn = 'grid size-9 place-items-center rounded-ctl border border-line bg-s2 hover:bg-s3';
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-s1 px-3 py-2">
      <button type="button" aria-label="Open menu" onClick={onMenu} className={`${btn} lg:hidden`}>
        <Menu className="size-4" aria-hidden />
      </button>
      <label className="sr-only" htmlFor="instrument">
        Instrument
      </label>
      <select
        id="instrument"
        disabled={!inst.data?.items.length}
        className="num rounded-ctl border border-line bg-s3 px-2 py-1.5"
      >
        {inst.data?.items.length ? (
          inst.data.items.map((i) => (
            <option key={i.id} value={i.canonical}>
              {i.canonical}
            </option>
          ))
        ) : (
          <option>No instrument</option>
        )}
      </select>
      <label className="sr-only" htmlFor="timeframe">
        Timeframe
      </label>
      <select
        id="timeframe"
        defaultValue="15m"
        className="rounded-ctl border border-line bg-s3 px-2 py-1.5"
      >
        {TIMEFRAMES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <FeedChip />
      <span className="num text-xs text-muted" title="Session timer">
        00:00:00
      </span>
      <div className="ml-auto flex gap-2">
        <button type="button" aria-label="Notifications" className={btn}>
          <Bell className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          onClick={toggleTheme}
          className={btn}
        >
          {theme === 'dark' ? (
            <Sun className="size-4" aria-hidden />
          ) : (
            <Moon className="size-4" aria-hidden />
          )}
        </button>
        <button
          type="button"
          aria-label="Open plan panel"
          onClick={onCanvas}
          className={`${btn} lg:hidden`}
        >
          <PanelRight className="size-4" aria-hidden />
        </button>
      </div>
    </header>
  );
}

function Centre() {
  const inst = useInstruments();
  let note = 'The chart arrives in F2.';
  if (inst.error instanceof ApiError) {
    note =
      inst.error.code === 'AUTH_REQUIRED'
        ? 'Sign in to load instruments (F1).'
        : inst.error.message;
  } else if (inst.isError) {
    note = 'The API is not reachable.';
  }
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <section
        aria-label="Chart"
        className="grid min-h-0 flex-[6] place-items-center border-b border-line p-4 text-center text-muted"
      >
        <div>
          <CandlestickChart className="mx-auto mb-2 size-8" aria-hidden />
          <p>{note}</p>
        </div>
      </section>
      <section aria-label="Conversation" className="flex min-h-0 flex-[4] flex-col p-3">
        <div className="min-h-0 flex-1 overflow-auto text-muted">
          Narrative updates and chat appear here (F3).
        </div>
        <form onSubmit={(e) => e.preventDefault()} className="mt-2 flex gap-2">
          <label className="sr-only" htmlFor="chat">
            Message
          </label>
          <input
            id="chat"
            disabled
            placeholder="Ask about the current scenario"
            className="min-w-0 flex-1 rounded-ctl border border-line bg-s3 px-3 py-2 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled
            className="rounded-ctl bg-accent px-3 py-2 text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      </section>
    </main>
  );
}

export function Shell() {
  const [menu, setMenu] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(380);
  const drag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) =>
      setWidth(Math.min(560, Math.max(320, window.innerWidth - m.clientX)));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }, []);

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-[232px] shrink-0 border-r border-line bg-s1 lg:block">
          <Nav />
        </aside>
        {menu && (
          <div
            className="fixed inset-0 z-30 flex lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
          >
            <div className="w-[260px] border-r border-line bg-s1">
              <Nav onNavigate={() => setMenu(false)} />
            </div>
            <button
              type="button"
              aria-label="Close menu"
              className="flex-1 bg-black/50"
              onClick={() => setMenu(false)}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <Header onMenu={() => setMenu(true)} onCanvas={() => setDrawer(true)} />
          <Centre />
        </div>
        {open ? (
          <aside
            style={{ width }}
            className="relative hidden shrink-0 border-l border-line lg:block"
            aria-label="Plan panel"
          >
            {/* biome-ignore lint/a11y/useSemanticElements: draggable splitter, an <hr> cannot take pointer events sensibly */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panel"
              onPointerDown={drag}
              className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
            />
            <button
              type="button"
              aria-label="Collapse panel"
              onClick={() => setOpen(false)}
              className="absolute right-2 top-2 z-10 rounded-ctl p-1 text-muted hover:bg-s3"
            >
              <X className="size-4" aria-hidden />
            </button>
            <Canvas />
          </aside>
        ) : (
          <button
            type="button"
            aria-label="Expand panel"
            onClick={() => setOpen(true)}
            className="hidden w-9 shrink-0 place-items-center border-l border-line bg-s1 text-muted hover:bg-s3 lg:grid"
          >
            <PanelRight className="size-4" aria-hidden />
          </button>
        )}
      </div>
      {drawer && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 h-[75dvh] rounded-t-card border-t border-line shadow-lg lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Plan panel"
        >
          <button
            type="button"
            aria-label="Close plan panel"
            onClick={() => setDrawer(false)}
            className="absolute right-2 top-2 z-10 rounded-ctl p-1 text-muted hover:bg-s3"
          >
            <X className="size-4" aria-hidden />
          </button>
          <Canvas />
        </div>
      )}
      <p className="border-t border-line bg-s1 px-3 py-1 text-center text-xs text-muted">
        {DISCLAIMER}
      </p>
    </div>
  );
}
