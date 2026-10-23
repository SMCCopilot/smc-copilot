'use client';
import {
  ArrowLeftRight,
  Bell,
  BookOpen,
  CandlestickChart,
  ChevronsLeft,
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
import {
  type ComponentType,
  type PointerEvent,
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { signOut, useMe } from '../lib/auth';
import { shortAddress } from '../lib/gate';
import { useLive, useLiveSession } from '../lib/live';
import { useCohorts, useEngineEvents, useRejected } from '../lib/market';
import { useFeedStatus } from '../lib/queries';
import { useJournal, useJournalSummary, useNotifications, useTrades } from '../lib/records';
import { useAutoRoom, useSpeechPrefetch } from '../lib/room';
import { useAdoptLiveSession, useSelection, useSessions } from '../lib/sessions';
import { useTheme } from '../lib/theme';
import { useUi, type View } from '../lib/ui';
import { BudgetMeter } from './budget-meter';
import { Canvas } from './canvas';
import { Popover } from './chart-menus';
import { ChartPanel } from './chart-panel';
import { SettingsView } from './settings';
import { JournalView, NotificationsView, TradesView } from './views';

interface NavItem {
  label: string;
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  view: View;
}
const NAV: NavItem[] = [
  { label: 'Chart', icon: CandlestickChart, view: 'room' },
  { label: 'Journal', icon: BookOpen, view: 'journal' },
  { label: 'Trades', icon: ArrowLeftRight, view: 'trades' },
  { label: 'Settings', icon: Settings, view: 'settings' },
];
const TITLES: Record<View, string> = {
  room: 'Chart',
  journal: 'Journal',
  trades: 'Trades',
  notifications: 'Notifications',
  settings: 'Settings',
};

const DISCLAIMER =
  'Educational analysis, not financial advice. Scenarios are not predictions. You make every decision.';

/** What the status chip says, how it is coloured, and a plain explanation for people who click it. */
function useFeedState(): { label: string; tone: 'ok' | 'warn' | 'idle'; why: string } {
  const { data, isError } = useFeedStatus();
  const live = useLive((s) => s.state);
  if (live !== 'IDLE') {
    switch (live) {
      case 'LIVE':
        return {
          label: 'Live',
          tone: 'ok',
          why: 'The analysis is connected and updating as each candle closes.',
        };
      case 'CONNECTING':
        return {
          label: 'Connecting…',
          tone: 'idle',
          why: 'Opening the live connection to the analysis.',
        };
      case 'RESYNCING':
        return {
          label: 'Reconnecting…',
          tone: 'warn',
          why: 'The connection dropped and is coming back. Nothing is lost; the analysis catches up on its own.',
        };
      case 'STALE':
        return {
          label: 'Waiting for new data',
          tone: 'warn',
          why: 'The analysis has not received a new candle from the market feed for a while, so trade ideas and zones wait for the next one. The prices on the chart come straight from Binance and keep moving. If this stays for more than a few minutes, the server’s market feed is paused or the exchange is quiet.',
        };
      case 'TAKEN':
        return {
          label: 'Open in another tab',
          tone: 'warn',
          why: 'Another tab or device is controlling this session. Use “Take over here” to move it to this one.',
        };
      case 'ENDED':
        return {
          label: 'Session ended',
          tone: 'idle',
          why: 'The analysis session was ended. A new one starts when you change the market.',
        };
      default:
        return { label: live, tone: 'idle', why: '' };
    }
  }
  if (isError)
    return {
      label: 'Cannot reach the server',
      tone: 'warn',
      why: 'The app cannot reach its server right now. Check your connection; it keeps retrying.',
    };
  if (data?.ingest === 'DISABLED')
    return {
      label: 'No live analysis feed',
      tone: 'warn',
      why: 'The server is not collecting market data at the moment, so the analysis cannot update. The chart prices still come straight from Binance.',
    };
  if (data && data.feeds.stale > 0)
    return {
      label: 'Waiting for new data',
      tone: 'warn',
      why: 'One or more market feeds have not sent a new candle recently. The analysis updates again as soon as they do.',
    };
  if (data) return { label: 'Live', tone: 'ok', why: 'The market feeds are healthy.' };
  return { label: 'Connecting…', tone: 'idle', why: 'Checking the connection.' };
}

function FeedChip() {
  const f = useFeedState();
  const dot = f.tone === 'ok' ? 'bg-bull' : f.tone === 'warn' ? 'bg-warn' : 'bg-muted';
  return (
    <Popover
      label="Connection status"
      name={`Connection: ${f.label}`}
      button={
        <>
          <span className={`relative flex size-2`} aria-hidden>
            {f.tone === 'ok' && (
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-bull opacity-60" />
            )}
            <span className={`relative inline-flex size-2 rounded-full ${dot}`} />
          </span>
          <span
            className={`hidden font-medium sm:inline ${f.tone === 'warn' ? 'text-warn-text' : ''}`}
          >
            {f.label}
          </span>
        </>
      }
      width="w-80"
    >
      <p className="font-medium text-fg">{f.label}</p>
      <p className="mt-1 text-muted">{f.why}</p>
    </Popover>
  );
}

const SIDE_KEY = 'smc-sidebar';

function Sidebar({
  expanded,
  onToggle,
  onNavigate,
  forceExpanded = false,
}: {
  expanded: boolean;
  onToggle?: () => void;
  onNavigate?: () => void;
  forceExpanded?: boolean;
}) {
  const me = useMe(true);
  const current = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const wide = forceExpanded || expanded;
  const wallet = me.data?.wallets.find((w) => w.primary) ?? me.data?.wallets[0];
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-2.5">
      <div className="mb-3 flex items-center gap-2.5 px-1.5 pt-1">
        <span
          className="brand-bg grid size-9 shrink-0 place-items-center rounded-xl text-[15px] font-bold text-white shadow-[0_8px_20px_-8px_rgb(79_91_255/0.9)]"
          aria-hidden
        >
          S
        </span>
        {wide && (
          <span className="leading-tight">
            <span className="block text-[15px] font-semibold">SMC Copilot</span>
            <span className="block text-[11px] text-muted">Market analysis</span>
          </span>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {NAV.map(({ label, icon: Icon, view }) => {
          const active = current === view;
          return (
            <li key={label}>
              <button
                type="button"
                title={wide ? undefined : label}
                onClick={() => {
                  setView(view);
                  onNavigate?.();
                }}
                aria-current={active ? 'page' : undefined}
                className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left font-medium transition-colors ${active ? 'brand-soft text-accent-text' : 'text-muted hover:bg-s3 hover:text-fg'} ${wide ? '' : 'justify-center px-0'}`}
              >
                {active && (
                  <span
                    className="brand-bg absolute left-0 top-2 h-[calc(100%-1rem)] w-[3px] rounded-r-full"
                    aria-hidden
                  />
                )}
                <Icon className="size-[18px] shrink-0" aria-hidden />
                <span className={wide ? '' : 'sr-only'}>{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-col gap-2">
        {wide && <BudgetMeter />}
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={expanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
            title={expanded ? 'Collapse the sidebar' : 'Expand the sidebar'}
            className={`flex items-center gap-3 rounded-xl px-3 py-2 text-muted transition-colors hover:bg-s3 hover:text-fg ${wide ? '' : 'justify-center px-0'}`}
          >
            {expanded ? (
              <ChevronsLeft className="size-[18px]" aria-hidden />
            ) : (
              <ChevronsRight className="size-[18px]" aria-hidden />
            )}
            {wide && <span>Collapse</span>}
          </button>
        )}
        <div
          className={`flex items-center gap-2 rounded-xl border border-line bg-s2 p-2 ${wide ? '' : 'flex-col'}`}
        >
          <Wallet className="size-4 shrink-0 text-muted" aria-hidden />
          {wide && (
            <span className="num min-w-0 flex-1 truncate text-xs" title={wallet?.address}>
              {wallet ? shortAddress(wallet.address) : 'No wallet'}
            </span>
          )}
          <button
            type="button"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => signOut()}
            className="rounded-ctl p-1 text-muted hover:bg-s3 hover:text-fg"
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
  const current = useUi((s) => s.view);
  const setView = useUi((s) => s.setView);
  const unread = notes.data?.filter((n) => !n.read).length ?? 0;
  const btn =
    'relative grid size-9 place-items-center rounded-xl border border-line bg-s2 text-muted transition-colors hover:bg-s3 hover:text-fg aria-pressed:accent-soft aria-pressed:text-accent-text';
  return (
    <header className="flex items-center gap-2 border-b border-line bg-s1/80 px-3 py-1.5 backdrop-blur">
      <button type="button" aria-label="Open menu" onClick={onMenu} className={`${btn} lg:hidden`}>
        <Menu className="size-4" aria-hidden />
      </button>
      <h1
        className={`text-[15px] font-semibold tracking-tight ${current === 'room' ? '' : 'sr-only'}`}
      >
        {TITLES[current]}
      </h1>
      <div className="ml-auto flex items-center gap-2">
        <FeedChip />
        <button
          type="button"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
          onClick={() => setView('notifications')}
          className={btn}
        >
          <Bell className="size-4" aria-hidden />
          {unread > 0 && (
            <span
              className="brand-bg absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-s1"
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
          className="flex items-center gap-3 border-b border-line bg-warn/10 px-3 py-2 text-warn-text"
        >
          Another tab or device is controlling this session.
          <button
            type="button"
            onClick={() => live.set({ takeover: live.takeover + 1 })}
            className="btn-ghost px-2.5 py-1 text-fg"
          >
            Take over here
          </button>
        </p>
      )}
      {live.error && (
        <p role="alert" className="border-b border-line bg-warn/10 px-3 py-2 text-warn-text">
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

/**
 * Loads what the other tabs and pages will need while the chart is already on screen, so opening Changes, Stats,
 * Journal or Trades shows data at once instead of a wait. Mounted a moment after the page, so it never competes
 * with the chart's own requests.
 */
function Prefetch() {
  const sel = useSelection();
  useEngineEvents(sel.instrumentId, sel.tf);
  useRejected(sel.instrumentId);
  useCohorts();
  useJournal();
  useJournalSummary();
  useTrades();
  return null;
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
  const [width, setWidth] = useState(400);
  const [side, setSide] = useState(false);
  const wide = useWide();
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWarm(true), 1200);
    return () => clearTimeout(t);
  }, []);
  // The sidebar starts slim so the chart keeps the room; the choice is remembered.
  useEffect(() => {
    try {
      setSide(localStorage.getItem(SIDE_KEY) === 'open');
    } catch {}
  }, []);
  const toggleSide = () => {
    setSide((s) => {
      try {
        localStorage.setItem(SIDE_KEY, s ? 'closed' : 'open');
      } catch {}
      return !s;
    });
  };
  const drag = useCallback((e: PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) =>
      setWidth(Math.min(620, Math.max(340, window.innerWidth - m.clientX)));
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
      {warm && <Prefetch />}
      <div className="flex min-h-0 flex-1">
        <aside
          className={`hidden shrink-0 border-r border-line bg-s1 transition-[width] duration-200 lg:block ${side ? 'w-56' : 'w-[68px]'}`}
        >
          <Sidebar expanded={side} onToggle={toggleSide} />
        </aside>
        {menu && (
          <div
            className="fixed inset-0 z-30 flex lg:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
          >
            <div className="w-[264px] border-r border-line bg-s1 shadow-pop">
              <Sidebar expanded forceExpanded onNavigate={() => setMenu(false)} />
            </div>
            <button
              type="button"
              aria-label="Close menu"
              className="flex-1 bg-black/55 backdrop-blur-[2px]"
              onClick={() => setMenu(false)}
            />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            onMenu={() => setMenu(true)}
            onPanel={togglePanel}
            panelOpen={wide ? open : drawer}
          />
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
                  className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent/30"
                />
                <Canvas />
              </aside>
            )}
          </div>
        </div>
      </div>
      {drawer && (
        <div
          className="fixed inset-x-0 bottom-0 z-30 flex h-[82dvh] flex-col rounded-t-3xl border-t border-line bg-s1 shadow-pop lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Assistant panel"
        >
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
          <div className="flex items-center justify-between px-4 py-1.5">
            <span className="text-sm font-semibold">Assistant and trade idea</span>
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
