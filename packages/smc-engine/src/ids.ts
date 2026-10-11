import { sha1 } from './sha1.js';

/** Short stable id (<= 32 chars) that facts, plans and events use to reference a level, zone, setup or event. */
export const shortId = (prefix: string, source: string): string =>
  `${prefix}${sha1(source).slice(0, 10)}`;

/** Locale-independent string order (localeCompare depends on the host ICU data). */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const round = (x: number, places: number): number => {
  const k = 10 ** places;
  return Math.round(x * k) / k;
};
export const round2 = (x: number): number => round(x, 2);
export const round3 = (x: number): number => round(x, 3);
