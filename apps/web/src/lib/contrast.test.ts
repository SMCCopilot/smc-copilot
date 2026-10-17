import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8');

function tokens(block: RegExp): Record<string, string> {
  const m = block.exec(css)?.[1] ?? '';
  return Object.fromEntries(
    [...m.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)].map((x) => [x[1], x[2]]),
  );
}
const light = tokens(/:root\s*\{([^}]*)\}/);
const dark = tokens(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/);

const lum = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return ((x as number) + 0.05) / ((y as number) + 0.05);
};

const themes = { light, dark };
const surfaces = ['bg', 'surface-1', 'surface-2', 'surface-3'];
const texts = ['text', 'text-muted', 'accent-text', 'bull-text', 'bear-text', 'warn-text'];

describe('text contrast (at least 4.5:1)', () => {
  for (const [name, t] of Object.entries(themes)) {
    for (const fg of texts) {
      for (const bg of surfaces) {
        it(`${name}: ${fg} on ${bg}`, () => {
          const f = t[fg];
          expect(f, `${fg} is defined`).toBeTruthy();
          expect(ratio(f as string, t[bg] as string)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    it(`${name}: grade chip text on its background`, () => {
      expect(ratio(t.grade as string, t['grade-bg'] as string)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: white text on the accent and danger buttons`, () => {
      expect(ratio('#ffffff', t['accent-strong'] as string)).toBeGreaterThanOrEqual(4.5);
      expect(ratio('#ffffff', t['bear-strong'] as string)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
