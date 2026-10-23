'use client';
import { CircleHelp, Layers } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { LAYER_HINT, LAYER_LABEL, LAYER_WHY, LAYERS } from '../lib/overlays';
import { useUi } from '../lib/ui';

/** A button that opens a small panel under it; closes on Escape or a click anywhere else. */
export function Popover({
  label,
  name,
  button,
  children,
  align = 'right',
  width = 'w-80',
}: {
  /** Names the panel (and the button's tooltip). */
  label: string;
  /** The button's accessible name; leave it out when the button's own text says enough. */
  name?: string;
  button: ReactNode;
  /** Panel content; a function gets a `close` to call after an action. */
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'left' | 'right';
  width?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span ref={box} className="relative">
      <button
        type="button"
        {...(name ? { 'aria-label': name } : {})}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 items-center gap-1.5 rounded-xl border border-line bg-s2 px-3 text-xs font-medium transition-colors hover:bg-s3 aria-expanded:bg-s3"
      >
        {button}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={label}
          className={`absolute ${align === 'right' ? 'right-0' : 'left-0'} top-11 z-30 ${width} max-w-[calc(100vw-1.5rem)] rise surface-card p-4 text-xs shadow-pop`}
        >
          {typeof children === 'function' ? children(() => setOpen(false)) : children}
        </div>
      )}
    </span>
  );
}

/** What the chart can show, one switch each, every one explained in plain words. */
export function LayersMenu({ hidden }: { hidden: number }) {
  const ui = useUi();
  const on = LAYERS.filter((l) => ui.layers[l]).length;
  return (
    <Popover
      label="Choose what the chart shows"
      width="w-[22rem]"
      button={
        <>
          <Layers className="size-3.5" aria-hidden />
          <span>Layers</span>
          <span className="num rounded-full bg-s3 px-1.5 text-[11px] text-muted">{on}</span>
        </>
      }
    >
      <p className="font-medium text-fg">What the chart shows</p>
      <p className="mt-0.5 text-muted">
        These are the analysis marks drawn on top of the candles. Turn on only what you need.
      </p>
      <ul className="mt-2 space-y-2.5">
        {LAYERS.map((l) => (
          <li key={l}>
            <label className="flex cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={ui.layers[l]}
                onChange={() => ui.toggleLayer(l)}
              />
              <span>
                <span className="font-medium text-fg">{LAYER_LABEL[l]}</span>
                <span className="block text-muted">{LAYER_HINT[l]}</span>
                <span className="block text-fg/80">How it helps: {LAYER_WHY[l]}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <p className="mt-2 border-t border-line pt-2 text-muted">
          {hidden} more marks are hidden to keep the chart readable: only those nearest the price
          are drawn.
        </p>
      )}
    </Popover>
  );
}

/** A short guide for someone new: what the market name means and how to read the colours. */
export function GuideMenu() {
  return (
    <Popover
      label="How to read this chart"
      name="How to read this chart"
      width="w-[24rem]"
      button={<CircleHelp className="size-3.5" aria-hidden />}
    >
      <p className="font-medium text-fg">The market (top left)</p>
      <p className="mt-0.5 text-muted">
        “SOL/USDT Perp · Binance” is the coin pair SOL priced in USDT (a dollar-like coin), on the
        Binance exchange. <b className="text-fg">Perp</b> means a perpetual futures contract: a bet
        on the price that never expires and can use leverage. <b className="text-fg">Spot</b> means
        the coin itself. This app only studies prices. It never places trades.
      </p>
      <p className="mt-3 font-medium text-fg">Timeframe</p>
      <p className="mt-0.5 text-muted">
        How long one candle lasts. 15m means each candle covers 15 minutes. Use the higher ones (4h,
        1D) for the big picture and the lower ones to time an entry.
      </p>
      <p className="mt-3 font-medium text-fg">The marks on the chart</p>
      <ul className="mt-0.5 space-y-1 text-muted">
        <li>
          <b className="text-fg">Blue and purple boxes</b>: zones where price often reacts (fair
          value gaps and order blocks).
        </li>
        <li>
          <b className="text-fg">Dashed amber lines</b>: liquidity, where many stop orders sit.
        </li>
        <li>
          <b className="text-fg">BOS and CHoCH tags</b>: the trend continuing, or the first sign it
          may turn.
        </li>
        <li>
          <b className="text-fg">Green and red boxes</b>: the cheap (discount) and expensive
          (premium) halves of the current range.
        </li>
      </ul>
      <p className="mt-3 text-muted">
        Open <b className="text-fg">Layers</b> to switch any of these on or off, and the{' '}
        <b className="text-fg">Setup</b> tab on the right for the trade idea in plain words.
      </p>
    </Popover>
  );
}
