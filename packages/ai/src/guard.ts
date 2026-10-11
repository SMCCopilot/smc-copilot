import { createHash } from 'node:crypto';
import type { MarketFacts } from '@smc/contracts';

/**
 * Output checks shared by every text job (A05 section 6.1): reference integrity, the number scan and placeholder
 * substitution. A model never writes a price; it writes `{{L:id}}`, and only this module turns that into a number.
 */

export const PLACEHOLDER_RE = /\{\{([LZV]):([A-Za-z0-9_.-]{1,32})\}\}/g;

export interface RefSpace {
  /** Price levels by id. */
  levels: ReadonlyMap<string, number>;
  /** Zones by id: [bottom, top]. */
  zones: ReadonlyMap<string, readonly [number, number]>;
  /** Levels read from an image (approximate mode), by id. */
  visual: ReadonlyMap<string, number>;
  /** Every id the model may name in a reference field. */
  known: ReadonlySet<string>;
  precision: number;
}

export function refSpaceOf(facts: MarketFacts, precision: number): RefSpace {
  const levels = new Map(facts.levels.map((l) => [l.id, l.price] as const));
  const zones = new Map(facts.zones.map((z) => [z.id, [z.bottom, z.top] as const] as const));
  const known = new Set<string>([
    ...levels.keys(),
    ...zones.keys(),
    ...facts.setups.map((s) => s.id),
  ]);
  if (facts.htfBias.lastBreak) known.add(facts.htfBias.lastBreak.id);
  return { levels, zones, visual: new Map(), known, precision };
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** The cache key for a narrative: same facts, same wording, for every user. */
export const factsHash = (facts: MarketFacts): string =>
  createHash('sha256').update(stableStringify(facts)).digest('hex');

export function formatPrice(p: number, precision: number): string {
  const [int = '', frac] = p.toFixed(Math.max(0, Math.min(10, precision))).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

export function placeholdersIn(text: string): { kind: 'L' | 'Z' | 'V'; id: string }[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => ({
    kind: m[1] as 'L' | 'Z' | 'V',
    id: m[2] as string,
  }));
}

/** Errors for every placeholder or reference id that does not exist in the facts. */
export function checkRefs(
  texts: readonly string[],
  refIds: readonly string[],
  space: RefSpace,
): string[] {
  const errors: string[] = [];
  for (const t of texts) {
    for (const p of placeholdersIn(t)) {
      const ok =
        p.kind === 'L'
          ? space.levels.has(p.id)
          : p.kind === 'Z'
            ? space.zones.has(p.id)
            : space.visual.has(p.id);
      if (!ok) errors.push(`unknown reference {{${p.kind}:${p.id}}}`);
    }
    const stripped = t.replace(PLACEHOLDER_RE, '');
    if (stripped.includes('{{') || stripped.includes('}}')) errors.push('malformed placeholder');
  }
  for (const id of refIds)
    if (!space.known.has(id) && !space.visual.has(id)) errors.push(`unknown id ${id}`);
  return errors;
}

/** Fibonacci and OTE constants are concepts, not prices. */
const ALLOWED_DECIMALS = new Set([
  '0.236',
  '0.382',
  '0.5',
  '0.62',
  '0.618',
  '0.705',
  '0.786',
  '0.79',
]);

/** Price-like literals outside placeholders. The model may not write a number a user could mistake for a level. */
export function scanNumbers(text: string): string[] {
  const t = text.replace(PLACEHOLDER_RE, ' ');
  const bad: string[] = [];
  const add = (re: RegExp, keep?: (m: string) => boolean) => {
    for (const m of t.matchAll(re)) if (!keep || !keep(m[0])) bad.push(m[0].trim().slice(0, 24));
  };
  add(/\$\s?\d[\d,.]*/g);
  add(/\b\d+(?:\.\d+)?\s?[kK]\b/g);
  add(/\d{1,3}(?:,\d{3})+(?:\.\d+)?/g);
  add(/\b\d+\.\d{2,}\b(?!\s?%)/g, (m) => ALLOWED_DECIMALS.has(m));
  add(/\b\d{4,}\b/g);
  return [...new Set(bad)];
}

/** Replaces placeholders with numbers formatted to the instrument's precision. Unknown ones are left for the caller to reject. */
export function substitute(text: string, space: RefSpace): string {
  return text.replace(PLACEHOLDER_RE, (whole, kind: string, id: string) => {
    if (kind === 'L') {
      const p = space.levels.get(id);
      return p === undefined ? whole : formatPrice(p, space.precision);
    }
    if (kind === 'Z') {
      const z = space.zones.get(id);
      return z === undefined
        ? whole
        : `${formatPrice(z[0], space.precision)} to ${formatPrice(z[1], space.precision)}`;
    }
    const v = space.visual.get(id);
    return v === undefined
      ? whole
      : `about ${formatPrice(v, space.precision)} (read from the image, approximate)`;
  });
}
