'use client';
import { TIMEFRAMES } from '@smc/contracts';
import {
  Bell,
  BookOpen,
  CandlestickChart,
  ChevronsRight,
  Layers,
  LogOut,
  Menu,
  Moon,
  PanelRight,
  Plus,
  Settings,
  Sun,
  Wallet,
  X,
} from 'lucide-react';
import { type PointerEvent, useCallback, useEffect, useState } from 'react';
import { signOut, useMe } from '../lib/auth';
import { useChat } from '../lib/chat';
import { ApiError } from '../lib/errors';
import { shortAddress } from '../lib/gate';
import { useLive, useLiveSession } from '../lib/live';
import { useFeedStatus, useInstruments } from '../lib/queries';
import { useNotifications } from '../lib/records';
import {
  useAdoptLiveSession,
  useCreateSession,
  useEndSession,
  useSelection,
  useSessions,
} from '../lib/sessions';
import { useTheme } from '../lib/theme';
import { useUi } from '../lib/ui';
import { Canvas } from './canvas';
import { ChartPanel } from './chart-panel';
import { Dock } from './dock';
import { SettingsView } from './settings';
import { InstrumentsView, JournalView, NotificationsView, TradesView } from './views';

const NAV = [
  { label: 'Session room', icon: CandlestickChart, view: 'room' },
  { label: 'Instruments', icon: Layers, view: 'instruments' },
  { label: 'Journal', icon: BookOpen, view: 'journal' },
  { label: 'Trades', icon: ChevronsRight, view: 'trades' },
  { label: 'Settings', icon: Settings, view: 'settings' },
] as const;

const DISCLAIMER =
  'Educational analysis, not financial advice. Scenarios are not predictions. You make every decision.';

function FeedChip() {
  const { data, isError, isPending } = useFeedStatus();
  const live = useLive((s) => s.state);
  const inSession = live !== 'IDLE';
  let label = 'CONNECTING';
  let tone = 'text-muted';
  if (inSession) {
    label = live === 'ENDED' ? 'ENDED' : live === 'TAKEN' ? 'PAUSED' : live;
    tone = live === 'LIVE' ? 'text-fg' : live === 'ENDED' ? 'text-muted' : 'text-warn-text';
  } else if (isError) {
    label = 'NO API';
    tone = 'text-warn-text';
  } else if (data) {
    if (data.ingest === 'DISABLED') {
      label = 'INGEST OFF';
      tone = 'text-warn-text';
    } else if (data.feeds.stale > 0) {
      label = 'STALE';
      tone = 'text-warn-text';
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

function useSessionTimer(startedAt: string | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return '00:00:00';
  const sec = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

function BudgetMeter() {
  const b = useChat((s) => s.budget);
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

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe(true);
  const sessions = useSessions(true);
  useAdoptLiveSession(sessions);
  const inst = useInstruments();
  const create = useCreateSession();
  const sel = useSelection();
  const current = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const wallet = me.data?.wallets.find((w) => w.primary) ?? me.data?.wallets[0];
  const nameOf = (id: string | null) =>
    inst.data?.items.find((i) => i.id === id)?.canonical ?? 'Session';
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-4 overflow-auto p-3">
      <div className="flex items-center gap-2 px-1 font-semibold">
        <span
          className="grid size-8 place-items-center rounded-ctl bg-accent-strong text-white"
          aria-hidden
        >
          S
        </span>
        SMC Copilot
      </div>
      <button
        type="button"
        disabled={!sel.instrumentId || create.isPending || sel.sessionId !== null}
        title={
          sel.sessionId
            ? 'End the current session first'
            : sel.instrumentId
              ? undefined
              : 'Pick an instrument first'
        }
        onClick={() => {
          create.mutate();
          onNavigate?.();
        }}
        className="flex items-center gap-2 rounded-ctl border border-line bg-s2 px-3 py-2 hover:bg-s3 disabled:opacity-60"
      >
        <Plus className="size-4" aria-hidden /> New session
      </button>
      {create.error && (
        <p role="alert" className="px-1 text-xs text-warn-text">
          {create.error instanceof ApiError ? create.error.message : 'Could not start a session.'}
        </p>
      )}
      <ul className="flex flex-col gap-0.5">
        {NAV.map(({ label, icon: Icon, view }) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => {
                setView(view);
                onNavigate?.();
              }}
              aria-current={current === view ? 'page' : undefined}
              className={`flex w-full items-center gap-2 rounded-ctl px-3 py-2 text-left hover:bg-s3 ${current === view ? 'accent-soft text-accent-text' : ''}`}
            >
              <Icon className="size-4" aria-hidden /> {label}
            </button>
          </li>
        ))}
      </ul>
      <div>
        <h2 className="px-3 pb-1 text-xs uppercase tracking-wide text-muted">Recent sessions</h2>
        {sessions.data?.length ? (
          <ul className="flex flex-col gap-0.5">
            {sessions.data.map((s) => {
              const live = s.state !== 'ENDED';
              const current = s.id === sel.sessionId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    disabled={!live}
                    aria-current={current ? 'true' : undefined}
                    title={live ? 'Resume this session' : 'Ended'}
                    onClick={() => {
                      sel.set({
                        sessionId: s.id,
                        startedAt: s.startedAt,
                        instrumentId: s.instrumentId,
                        tf: s.tf ?? sel.tf,
                      });
                      onNavigate?.();
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-ctl px-3 py-1.5 text-left hover:bg-s3 disabled:text-muted ${current ? 'accent-soft text-accent-text' : ''}`}
                  >
                    <span className="num truncate">{nameOf(s.instrumentId)}</span>
                    <span className="text-xs text-muted">{live ? s.tf : 'ended'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 text-muted">{sessions.isPending ? 'Loading…' : 'None yet.'}</p>
        )}
      </div>
      <div className="mt-auto flex flex-col gap-2">
        <BudgetMeter />
        <div className="flex items-center gap-2 rounded-ctl px-2 py-1.5">
          <Wallet className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="num min-w-0 flex-1 truncate" title={wallet?.address}>
            {wallet ? shortAddress(wallet.address) : 'No wallet'}
          </span>
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => signOut()}
            className="rounded-ctl p-1 text-muted hover:bg-s3"
          >
            <LogOut className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </nav>
  );
}

function Header({ onMenu, onCanvas }: { onMenu: () => void; onCanvas: () => void }) {
  const [theme, toggleTheme] = useTheme();
  const inst = useInstruments();
  const sel = useSelection();
  const end = useEndSession();
  const timer = useSessionTimer(sel.startedAt);
  const notes = useNotifications();
  const setView = useUi((s) => s.setView);
  const unread = notes.data?.filter((n) => !n.read).length ?? 0;
  const locked = sel.sessionId !== null;
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
        value={sel.instrumentId ?? ''}
        disabled={!inst.data?.items.length || locked}
        onChange={(e) => sel.set({ instrumentId: e.target.value || null })}
        className="num rounded-ctl border border-line bg-s3 px-2 py-1.5"
      >
        <option value="">{inst.data?.items.length ? 'Pick an instrument' : 'No instrument'}</option>
        {inst.data?.items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.canonical}
            {i.rawDataAllowed ? '' : ' · analysis only'}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="timeframe">
        Timeframe
      </label>
      <select
        id="timeframe"
        value={sel.tf}
        disabled={locked}
        onChange={(e) => sel.set({ tf: e.target.value as typeof sel.tf })}
        className="rounded-ctl border border-line bg-s3 px-2 py-1.5"
      >
        {TIMEFRAMES.map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <FeedChip />
      <span className="num text-xs text-muted" title="Session timer">
        {timer}
      </span>
      {locked && (
        <button
          type="button"
          disabled={end.isPending}
          onClick={() => end.mutate()}
          className="rounded-ctl border border-line bg-s2 px-2.5 py-1.5 text-xs hover:bg-s3"
        >
          End session
        </button>
      )}
      <div className="ml-auto flex gap-2">
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          onClick={() => setView('notifications')}
          className={`${btn} relative`}
        >
          <Bell className="size-4" aria-hidden />
          {unread > 0 && (
            <span
              className="absolute -right-1 -top-1 size-2.5 rounded-full bg-accent-strong"
              aria-hidden
            />
          )}
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
  const live = useLive();
  const view = useUi((s) => s.view);
  if (view === 'journal') return <JournalView />;
  if (view === 'trades') return <TradesView />;
  if (view === 'notifications') return <NotificationsView />;
  if (view === 'settings') return <SettingsView />;
  if (view === 'instruments') return <InstrumentsView />;
  return (
    <main id="main" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
      {live.state === 'TAKEN' && (
        <p
          role="alert"
          className="flex items-center gap-3 border-b border-line bg-s2 px-3 py-2 text-warn-text"
        >
          Another tab or device is controlling this session.
          <button
            type="button"
            onClick={() => live.set({ takeover: live.takeover + 1 })}
            className="rounded-ctl border border-line px-2 py-1 text-fg hover:bg-s3"
          >
            Take over here
          </button>
        </p>
      )}
      {live.error && (
        <p role="alert" className="border-b border-line bg-s2 px-3 py-2 text-warn-text">
          {live.error}
        </p>
      )}
      <ChartPanel />
      <Dock />
    </main>
  );
}

export function Shell() {
  useLiveSession(useSelection((s) => s.sessionId));
  const [menu, setMenu] = useState(false);
  const drawer = useUi((s) => s.drawer);
  const setDrawer = useUi((s) => s.setDrawer);
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
