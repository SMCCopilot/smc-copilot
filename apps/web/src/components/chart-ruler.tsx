'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { lineStyle, OB_VIOLET, type Palette, readPalette, zoneStyle } from '../lib/overlay-style';
import {
  focusOverlays,
  formatPrice,
  type Overlay,
  overlayPrices,
  type StructureMark,
  stackLabels,
} from '../lib/overlays';

/**
 * Overlay-only mode for instruments whose raw prices may not reach the browser: levels, zones and structure
 * labels on a plain price ruler. No candles, ticks or series are ever requested or drawn here.
 */
export default function ChartRuler({
  overlays,
  marks,
  precision,
}: {
  overlays: Overlay[];
  marks: StructureMark[] | null;
  precision: number;
}) {
  const [pal, setPal] = useState<Palette | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  });
  useEffect(() => {
    setPal(readPalette());
    const mo = new MutationObserver(() => setPal(readPalette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  const { shown, hidden } = useMemo(() => focusOverlays(overlays), [overlays]);
  const prices = overlayPrices(shown);
  if (!pal || prices.length === 0) {
    return <p className="grid size-full place-items-center text-muted">No levels to show yet.</p>;
  }
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const pad = (hi - lo || Math.abs(hi) * 0.01 || 1) * 0.08;
  const min = lo - pad;
  const max = hi + pad;
  const pct = (p: number) => ((max - p) / (max - min)) * 100;
  const ticks = Array.from({ length: 6 }, (_, i) => min + ((max - min) * i) / 5);
  const recent = (marks ?? []).filter((m) => m.kind === 'BREAK').slice(-4);

  // One label per overlay, kept apart: a label is about 18 px tall.
  const gap = height > 0 ? (18 / height) * 100 : 4;
  const anchors = shown.map((o) => pct(o.kind === 'zone' ? o.top : o.price));
  const placed = stackLabels(anchors, gap);

  return (
    <div className="flex size-full flex-col">
      {recent.length > 0 && (
        <p className="border-b border-line px-3 py-1 text-xs text-muted">
          Structure: {recent.map((m) => `${m.label} (${m.scale})`).join(' · ')}
        </p>
      )}
      {hidden > 0 && (
        <p className="border-b border-line px-3 py-1 text-xs text-muted">
          Showing the {shown.length} levels nearest the price; {hidden} more are not drawn. Turn
          layers off to see others.
        </p>
      )}
      <div ref={box} className="relative min-h-0 flex-1">
        <div className="absolute inset-y-0 left-0 w-16 border-r border-line" aria-hidden>
          {ticks.map((t) => (
            <span
              key={t}
              className="num absolute right-1 -translate-y-1/2 text-xs text-muted"
              style={{ top: `${pct(t)}%` }}
            >
              {formatPrice(t, precision)}
            </span>
          ))}
        </div>
        <div className="absolute inset-y-0 left-16 right-0 overflow-hidden">
          {shown.map((o) => {
            if (o.kind === 'zone') {
              const st = zoneStyle(o.tone, pal);
              return (
                <div
                  key={`${o.layer}-${o.id}`}
                  className="absolute inset-x-0"
                  style={{
                    top: `${pct(o.top)}%`,
                    height: `max(2px, ${pct(o.bottom) - pct(o.top)}%)`,
                    background: st.fill,
                    border: st.stroke
                      ? `1px ${o.tone === 'ob' ? 'solid' : 'dashed'} ${st.stroke}`
                      : undefined,
                    color: o.tone === 'ob' ? OB_VIOLET : undefined,
                  }}
                />
              );
            }
            const st = lineStyle(o.tone, pal, o.up);
            return (
              <div
                key={`${o.layer}-${o.id}`}
                className="absolute inset-x-0"
                style={{
                  top: `${pct(o.price)}%`,
                  borderTop: `${st.width}px ${st.dash.length === 0 ? 'solid' : st.dash[0] && st.dash[0] <= 2 ? 'dotted' : 'dashed'} ${st.color}`,
                }}
              />
            );
          })}
          {shown.map((o, i) => {
            const zone = o.kind === 'zone';
            const st = zone ? zoneStyle(o.tone, pal) : lineStyle(o.tone, pal, o.up);
            const price = zone
              ? `${formatPrice(o.bottom, precision)}–${formatPrice(o.top, precision)}`
              : formatPrice(o.price, precision);
            return (
              <span
                key={`label-${o.layer}-${o.id}`}
                className="absolute right-2 -translate-y-1/2 whitespace-nowrap rounded bg-s1/80 px-1 text-xs"
                style={{
                  top: `${placed[i]}%`,
                  color: zone ? undefined : (st as { color: string }).color,
                }}
              >
                {st.glyph} {o.label} <span className="num text-muted">{price}</span>
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}
