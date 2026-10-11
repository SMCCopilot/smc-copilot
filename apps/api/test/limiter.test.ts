import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/account/rate-limit.js';

describe('RateLimiter', () => {
  it('a short-window key never clears a long-window counter, even when the map is large', () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    expect(l.hit('day:u', 2, 86_400_000)).toBeNull();
    expect(l.hit('day:u', 2, 86_400_000)).toBeNull();
    // Fill the map past the sweep threshold with one-minute keys, then let a minute pass.
    for (let i = 0; i < 5200; i++) l.hit(`min:${i}`, 5, 60_000);
    t += 120_000;
    l.hit('min:new', 5, 60_000); // triggers a sweep
    expect(l.hit('day:u', 2, 86_400_000)).not.toBeNull(); // still at its limit
  });
});
