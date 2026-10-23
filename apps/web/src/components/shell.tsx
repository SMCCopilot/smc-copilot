'use client';
import {
  Bell,
  BookOpen,
  CandlestickChart,
  ChevronsRight,
  LogOut,
  Menu,
  Moon,
  PanelRight,
  Settings,
  Sun,
  Wallet,
  X,
} from 'lucide-react';
import { type PointerEvent, useCallback, useState, useSyncExternalStore } from 'react';
import { signOut, useMe } from '../lib/auth';
import { shortAddress } from '../lib/gate';
import { useLive, useLiveSession } from '../lib/live';
import { useFeedStatus } from '../lib/queries';
import { useNotifications } from '../lib/records';
import { useAutoRoom, useSpeechPrefetch } from '../lib/room';
import { useAdoptLiveSession, useSelection, useSessions } from '../lib/sessions';
import { useTheme } from '../lib/theme';
import { useUi } from '../lib/ui';

import { BudgetMeter } from './budget-meter';
import { Canvas } from './canvas';
import { ChartPanel } from './chart-panel';
import { SettingsView } from './settings';
import { JournalView, NotificationsView, TradesView } from './views';

const NAV = [
  { label: 'Chart', icon: CandlestickChart, view: 'room' },
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
  let label = 'Connecting…';
  let tone = 'text-muted';
  if (inSession) {
    const words: Record<string, string> = {
      CONNECTING: 'Connecting…',
      LIVE: 'Live',
      RESYNCING: 'Reconnecting…',
      STALE: 'Waiting for new data',
      TAKEN: 'Open in another tab',
      ENDED: 'Session ended',
    };
    label = words[live] ?? live;
    tone = live === 'LIVE' ? 'text-fg' : live === 'ENDED' ? 'text-muted' : 'text-warn-text';
  } else if (isError) {
    label = 'Cannot reach the server';
    tone = 'text-warn-text';
  } else if (data) {
    if (data.ingest === 'DISABLED') {
      label = 'No live analysis feed';
      tone = 'text-warn-text';
    } else if (data.feeds.stale > 0) {
      label = 'Waiting for new data';
      tone = 'text-warn-text';
    } else {
      label = 'Live';
      tone = 'text-fg';
    }
  }
  return (
    <span
      role="status"
      aria-label={`Connection: ${label}`}
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
  const me = useMe(true);
  const current = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const wallet = me.data?.wallets.find((w) => w.primary) ?? me.data?.wallets[0];
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

function TopBar({
  onMenu,
  onPanel,
  panelOpen,
}: {
  onMenu: () => void;
  onPanel: () => void;
  panelOpen: boolean;
}) {
  const [theme, toggleTheme] = useTheme();
  const notes = useNotifications();
  const me = useMe(true);
  const current = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const unread = notes.data?.filter((n) => !n.read).length ?? 0;
  const wallet = me.data?.wallets.find((w) => w.primary) ?? me.data?.wallets[0];
  const btn =
    'grid size-9 place-items-center rounded-ctl border border-line bg-s2 hover:bg-s3 aria-pressed:accent-soft aria-pressed:text-accent-text';
  return (
    <header className="flex items-center gap-2 border-b border-line bg-s1 px-3 py-1.5">
      <button type="button" aria-label="Open menu" onClick={onMenu} className={`${btn} lg:hidden`}>
        <Menu className="size-4" aria-hidden />
      </button>
      <div className="flex items-center gap-2 font-semibold">
        <span
          className="grid size-7 place-items-center rounded-ctl bg-accent-strong text-white"
          aria-hidden
        >
          S
        </span>
        <span className="hidden sm:inline">SMC Copilot</span>
      </div>
      <nav aria-label="Main" className="ml-3 hidden gap-0.5 lg:flex">
        {NAV.map(({ label, icon: Icon, view }) => (
          <button
            key={label}
            type="button"
            onClick={() => setView(view)}
            aria-current={current === view ? 'page' : undefined}
            className={`flex items-center gap-1.5 rounded-ctl px-3 py-1.5 hover:bg-s3 ${current === view ? 'accent-soft text-accent-text' : 'text-muted'}`}
          >
            <Icon className="size-4" aria-hidden /> {label}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <FeedChip />
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
        {current === 'room' && (
          <button
            type="button"
            aria-label={panelOpen ? 'Hide the assistant panel' : 'Show the assistant panel'}
            title={panelOpen ? 'Hide the assistant panel' : 'Show the assistant panel'}
            aria-pressed={panelOpen}
            onClick={onPanel}
            className={btn}
          >
            <PanelRight className="size-4" aria-hidden />
          </button>
        )}
        <div className="hidden items-center gap-1 border-l border-line pl-2 md:flex">
          <Wallet className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="num text-xs text-muted" title={wallet?.address}>
            {wallet ? shortAddress(wallet.address) : 'No wallet'}
          </span>
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => signOut()}
            className="rounded-ctl p-1.5 text-muted hover:bg-s3"
          >
            <LogOut className="size-4" aria-hidden />
          </button>
        </div>
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
  return (
    <main id="main" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col">
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
    </main>
  );
}

/** True on a wide screen (where the assistant sits beside the chart), false on a phone or small tablet. */
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia('(min-width: 1024px)');
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => window.matchMedia('(min-width: 1024px)').matches,
    () => true,
  );
}

export function Shell() {
  useLiveSession(useSelection((s) => s.sessionId));
  // Picks up the account's live session after a reload or in another tab, whichever screen is showing.
  useAdoptLiveSession(useSessions(true));
  useAutoRoom();
  useSpeechPrefetch();
  const [menu, setMenu] = useState(false);
  const view = useUi((s) => s.view);
  const drawer = useUi((s) => s.drawer);
  const setDrawer = useUi((s) => s.setDrawer);
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(380);
  const wide = useWide();
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
  // On a wide screen the button hides or shows the side panel; on a phone it opens the panel from the bottom.
  const togglePanel = () => {
    if (wide) setOpen((o) => !o);
    else setDrawer(!drawer);
  };

  return (
    <div className="flex h-dvh flex-col">
      <TopBar onMenu={() => setMenu(true)} onPanel={togglePanel} panelOpen={wide ? open : drawer} />
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
      <div className="flex min-h-0 flex-1">
        <Centre />
        {view === 'room' && open && (
          <aside
            style={{ width }}
            className="relative hidden shrink-0 border-l border-line lg:block"
            aria-label="Assistant panel"
          >
            {/* biome-ignore lint/a11y/useSemanticElements: draggable splitter, an <hr> cannot take pointer events sensibly */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panel"
              onPointerDown={drag}
              className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
            />
            <Canvas />
          </aside>
        )}
      </div>
      {drawer && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 flex h-[80dvh] flex-col rounded-t-card border-t border-line bg-s1 shadow-lg lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Assistant panel"
        >
          <div className="flex items-center justify-between border-b border-line bg-s1 px-3 py-1.5">
            <span className="text-sm font-medium">Assistant and trade idea</span>
            <button
              type="button"
              aria-label="Close the assistant panel"
              onClick={() => setDrawer(false)}
              className="rounded-ctl p-1.5 text-muted hover:bg-s3"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <Canvas />
          </div>
        </div>
      )}
      <p className="border-t border-line bg-s1 px-3 py-0.5 text-center text-[11px] text-muted">
        {DISCLAIMER}
      </p>
    </div>
  );
}
