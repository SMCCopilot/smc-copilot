import { describe, expect, it } from 'vitest';
import { createFrameBatcher, createSeqFilter } from './seq';

describe('sequence filter', () => {
  it('accepts increasing sequence numbers and drops duplicates and old ones', () => {
    const f = createSeqFilter();
    expect([1, 2, 2, 3, 1, 5, 4].map((n) => f.accept(n))).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(f.last()).toBe(5);
  });
  it('resumes from a saved sequence number', () => {
    const f = createSeqFilter(10);
    expect(f.accept(10)).toBe(false);
    expect(f.accept(11)).toBe(true);
  });
  it('rejects non-integers', () => {
    expect(createSeqFilter().accept(Number.NaN)).toBe(false);
  });
});

describe('frame batcher', () => {
  it('runs one flush per frame with unique keys', () => {
    const frames: (() => void)[] = [];
    const out: string[][] = [];
    const push = createFrameBatcher(
      (cb) => frames.push(cb),
      (items) => out.push(items),
    );
    push('a');
    push('b');
    push('a');
    expect(frames).toHaveLength(1);
    frames[0]?.();
    expect(out).toEqual([['a', 'b']]);
    push('c');
    expect(frames).toHaveLength(2);
  });
});
