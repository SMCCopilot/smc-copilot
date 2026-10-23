import type { CandleType, DeepPartial, Styles } from 'klinecharts';
import { type Palette, withAlpha } from './overlay-style';

const FONT = 'Inter, system-ui, sans-serif';

/** Everything the chart library draws, taken from the app's own colour tokens so light and dark both match. */
export function klineStyles(
  p: Palette,
  border: string,
  type: CandleType = 'candle_solid',
): DeepPartial<Styles> {
  const grid = withAlpha(border || '#888888', 0.3);
  const tick = { show: true, color: p.muted, family: FONT, size: 11, weight: 400 };
  const axis = {
    show: true,
    size: 'auto' as const,
    axisLine: { show: true, color: border },
    tickLine: { show: true, length: 4, size: 1, color: border },
    tickText: { ...tick, marginStart: 4, marginEnd: 4 },
  };
  const label = {
    show: true,
    style: 'fill' as const,
    color: p.text,
    size: 11,
    family: FONT,
    weight: 500,
    borderSize: 0,
    paddingLeft: 6,
    paddingRight: 6,
    paddingTop: 3,
    paddingBottom: 3,
    borderRadius: 3,
    backgroundColor: p.surface,
  };
  return {
    grid: {
      show: true,
      horizontal: { show: true, size: 1, color: grid, style: 'solid' },
      vertical: { show: false, size: 1, color: grid, style: 'solid' },
    },
    candle: {
      type,
      bar: {
        compareRule: 'current_open',
        upColor: p.bull,
        downColor: p.bear,
        noChangeColor: p.muted,
        upBorderColor: p.bull,
        downBorderColor: p.bear,
        noChangeBorderColor: p.muted,
        upWickColor: p.bull,
        downWickColor: p.bear,
        noChangeWickColor: p.muted,
      },
      area: {
        lineSize: 2,
        lineColor: p.accent,
        smooth: false,
        backgroundColor: [
          { offset: 0, color: withAlpha(p.accent, 0.25) },
          { offset: 1, color: withAlpha(p.accent, 0) },
        ],
      },
      priceMark: {
        show: true,
        // The high and low labels on the visible candles are clutter beside our own levels.
        high: { show: false },
        low: { show: false },
        last: {
          show: true,
          compareRule: 'current_open',
          upColor: p.bull,
          downColor: p.bear,
          noChangeColor: p.muted,
          line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1 },
          text: {
            show: true,
            style: 'fill',
            size: 11,
            weight: 600,
            family: FONT,
            color: '#FFFFFF',
            borderRadius: 3,
            paddingLeft: 6,
            paddingRight: 6,
            paddingTop: 3,
            paddingBottom: 3,
          },
          // The countdown to the candle's close sits under the live price, as on a trading terminal.
          extendTexts: [
            {
              show: true,
              position: 'below_price',
              updateInterval: 1000,
              style: 'fill',
              size: 10,
              weight: 500,
              family: FONT,
              color: '#FFFFFF',
              borderRadius: 3,
              paddingLeft: 6,
              paddingRight: 6,
              paddingTop: 2,
              paddingBottom: 2,
            },
          ],
        },
      },
      tooltip: {
        showRule: 'always',
        showType: 'standard',
        title: {
          show: true,
          template: '{ticker}',
          color: p.text,
          size: 12,
          weight: 600,
          family: FONT,
        },
        legend: { color: p.muted, size: 11, family: FONT, weight: 400 },
      },
    },
    indicator: {
      lastValueMark: { show: false },
      tooltip: {
        showRule: 'always',
        showType: 'standard',
        title: {
          show: true,
          showName: true,
          showParams: true,
          color: p.muted,
          size: 11,
          family: FONT,
        },
        legend: { color: p.muted, size: 11, family: FONT },
      },
      lines: [
        { style: 'solid', smooth: false, size: 1.2, dashedValue: [2, 2], color: '#F59E0B' },
        { style: 'solid', smooth: false, size: 1.2, dashedValue: [2, 2], color: '#38BDF8' },
        { style: 'solid', smooth: false, size: 1.2, dashedValue: [2, 2], color: '#A78BFA' },
        { style: 'solid', smooth: false, size: 1.2, dashedValue: [2, 2], color: '#F472B6' },
        { style: 'solid', smooth: false, size: 1.2, dashedValue: [2, 2], color: '#34D399' },
      ],
    },
    xAxis: axis,
    yAxis: axis,
    separator: {
      size: 1,
      color: border,
      fill: true,
      activeBackgroundColor: withAlpha(p.accent, 0.2),
    },
    crosshair: {
      show: true,
      horizontal: {
        show: true,
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: p.muted },
        text: { ...label, backgroundColor: p.surface, borderColor: border, borderSize: 1 },
      },
      vertical: {
        show: true,
        line: { show: true, style: 'dashed', dashedValue: [4, 4], size: 1, color: p.muted },
        text: { ...label, backgroundColor: p.surface, borderColor: border, borderSize: 1 },
      },
    },
    overlay: {
      point: {
        color: p.accent,
        borderColor: p.surface,
        borderSize: 1,
        radius: 4,
        activeColor: p.accent,
        activeBorderColor: p.surface,
        activeBorderSize: 2,
        activeRadius: 5,
      },
      line: { style: 'solid', smooth: false, size: 1.5, color: p.accent, dashedValue: [4, 4] },
      rect: {
        style: 'stroke_fill',
        color: withAlpha(p.accent, 0.14),
        borderColor: p.accent,
        borderSize: 1,
        borderStyle: 'solid',
        borderDashedValue: [4, 4],
        borderRadius: 0,
      },
      polygon: {
        style: 'stroke_fill',
        color: withAlpha(p.accent, 0.14),
        borderColor: p.accent,
        borderSize: 1,
        borderStyle: 'solid',
        borderDashedValue: [4, 4],
      },
      text: {
        ...label,
        style: 'stroke_fill',
        color: p.text,
        backgroundColor: p.surface,
        borderColor: p.accent,
        borderSize: 1,
      },
    },
  };
}
