'use client';
import { useEffect, useState } from 'react';
import { lineStyle, OB_VIOLET, type Palette, readPalette, zoneStyle } from '@/lib/overlay-style';
import { formatPrice, type Overlay, overlayPrices, type StructureMark } from '@/lib/overlays';

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
  useEffect(() => {
    setPal(readPalette());
    const mo = new MutationObserver(() => setPal(readPalette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  const prices = overlayPrices(overlays);
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

  return (
    <div className="flex size-full flex-col">
      {recent.length > 0 && (
        <p className="border-b border-line px-3 py-1 text-xs text-muted">
          Structure: {recent.map((m) => `${m.label} (${m.scale})`).join(' · ')}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
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
          {overlays.map((o) => {
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
                >
                  <span className="absolute right-2 top-0 text-xs text-fg">
                    {st.glyph} {o.label}{' '}
                    <span className="num text-muted">
                      {formatPrice(o.bottom, precision)}–{formatPrice(o.top, precision)}
                    </span>
                  </span>
                </div>
              );
            }
            const st = lineStyle(o.tone, pal, o.up);
            return (
              <div
                key={`${o.layer}-${o.id}`}
                className="absolute inset-x-0"
                style={{ top: `${pct(o.price)}%` }}
              >
                <div
                  style={{
                    borderTop: `${st.width}px ${st.dash.length === 0 ? 'solid' : st.dash[0] && st.dash[0] <= 2 ? 'dotted' : 'dashed'} ${st.color}`,
                  }}
                />
                <span
                  className="absolute right-2 -translate-y-full text-xs"
                  style={{ color: st.color }}
                >
                  {st.glyph} {o.label}{' '}
                  <span className="num">{formatPrice(o.price, precision)}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
