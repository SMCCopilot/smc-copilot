import { describe, expect, it } from 'vitest';
import { ManagedConnection, type ManagedConnectionOptions } from '../src/managed-connection.js';
import type { FeedStatus } from '../src/provider.js';
import { FakeScheduler, FakeSocket } from './fakes.js';

function setup(over: Partial<ManagedConnectionOptions> = {}, random = 1) {
  const clock = new FakeScheduler(random);
  const sockets: FakeSocket[] = [];
  const messages: string[] = [];
  const statuses: string[] = [];
  const conn = new ManagedConnection({
    url: 'wss://venue.example/stream',
    factory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    scheduler: clock,
    onMessage: (t) => messages.push(t),
    onStatus: (s: FeedStatus, d?: string) => statuses.push(d ? `${s}:${d}` : s),
    backoff: { baseMs: 1000, maxMs: 8000 },
    ...over,
  });
  return { clock, sockets, messages, statuses, conn };
}

describe('ManagedConnection', () => {
  it('connects, reports CONNECTED and delivers frames', () => {
    const { conn, sockets, messages, statuses } = setup();
    conn.start();
    sockets[0]?.open();
    sockets[0]?.message('a');
    expect(statuses).toEqual(['CONNECTED']);
    expect(messages).toEqual(['a']);
    expect(conn.connected).toBe(true);
  });

  it('sends the subscribe message on every (re)connect', () => {
    const { conn, sockets, clock } = setup({ onOpen: (send) => send('SUBSCRIBE') });
    conn.start();
    sockets[0]?.open();
    sockets[0]?.emit('close', { code: 1006 });
    clock.advance(1000);
    sockets[1]?.open();
    expect(sockets[0]?.sent).toEqual(['SUBSCRIBE']);
    expect(sockets[1]?.sent).toEqual(['SUBSCRIBE']);
  });

  it('reconnects with capped exponential backoff and reports RECONNECTED', () => {
    const { conn, sockets, clock, statuses } = setup();
    conn.start();
    sockets[0]?.open();
    sockets[0]?.message('x');
    sockets[0]?.emit('close', { code: 1006 });
    expect(statuses).toContain('DISCONNECTED:closed (1006)');
    expect(statuses).toContain('RECONNECTING:in 1000 ms');

    clock.advance(999);
    expect(sockets).toHaveLength(1);
    clock.advance(1);
    expect(sockets).toHaveLength(2);

    // Connect fails twice without ever delivering a frame: 2000 then 4000.
    sockets[1]?.emit('error', { message: 'refused' });
    expect(statuses.at(-1)).toBe('RECONNECTING:in 2000 ms');
    clock.advance(2000);
    sockets[2]?.emit('error', { message: 'refused' });
    expect(statuses.at(-1)).toBe('RECONNECTING:in 4000 ms');
    clock.advance(4000);
    sockets[3]?.emit('error', {});
    clock.advance(8000);
    sockets[4]?.emit('error', {});
    expect(statuses.at(-1)).toBe('RECONNECTING:in 8000 ms'); // capped at maxMs

    clock.advance(8000);
    sockets[5]?.open();
    sockets[5]?.message('back');
    expect(statuses).toContain('RECONNECTED');
  });

  it('applies jitter within [50%, 100%] of the backoff ceiling', () => {
    const { conn, sockets, statuses } = setup({}, 0);
    conn.start();
    sockets[0]?.open();
    sockets[0]?.emit('close', {});
    expect(statuses.at(-1)).toBe('RECONNECTING:in 500 ms');
  });

  it('resets the backoff only after a frame arrives, not merely after open', () => {
    const { conn, sockets, clock, statuses } = setup();
    conn.start();
    sockets[0]?.open();
    sockets[0]?.emit('close', {});
    clock.advance(1000);
    sockets[1]?.open(); // accepted, then dropped before any data
    sockets[1]?.emit('close', {});
    expect(statuses.at(-1)).toBe('RECONNECTING:in 2000 ms');
    clock.advance(2000);
    sockets[2]?.open();
    sockets[2]?.message('data');
    sockets[2]?.emit('close', {});
    expect(statuses.at(-1)).toBe('RECONNECTING:in 1000 ms');
  });

  it('reconnects a silent socket (half-open connection)', () => {
    const { conn, sockets, clock, statuses } = setup({ silenceTimeoutMs: 30_000 });
    conn.start();
    sockets[0]?.open();
    sockets[0]?.message('x');
    clock.advance(29_999);
    expect(statuses).not.toContain('DISCONNECTED:silent');
    clock.advance(1);
    expect(statuses).toContain('DISCONNECTED:silent');
    expect(sockets[0]?.closedWith).toBe(1000);
  });

  it('keeps a socket alive that keeps talking', () => {
    const { conn, sockets, clock, statuses } = setup({ silenceTimeoutMs: 30_000 });
    conn.start();
    sockets[0]?.open();
    for (let i = 0; i < 10; i++) {
      clock.advance(20_000);
      sockets[0]?.message('tick');
    }
    expect(statuses).toEqual(['CONNECTED']);
  });

  it('sends keep-alive pings on schedule and stops after close', () => {
    const { conn, sockets, clock } = setup({ ping: { everyMs: 20_000, payload: 'ping' } });
    conn.start();
    sockets[0]?.open();
    clock.advance(60_000);
    expect(sockets[0]?.sent).toEqual(['ping', 'ping', 'ping']);
    conn.close();
    clock.advance(60_000);
    expect(sockets[0]?.sent).toHaveLength(3);
  });

  it('classifies repeated connect failures (for example a geo-block) after three attempts', async () => {
    const seen: string[] = [];
    const { conn, sockets, clock } = setup({
      classifyFailure: async () => 'GEO_BLOCKED',
      onStatus: (s) => seen.push(s),
    });
    conn.start();
    for (let i = 0; i < 3; i++) {
      sockets.at(-1)?.emit('error', {});
      clock.advance(10_000);
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toContain('GEO_BLOCKED');
  });

  it('close() stops everything and never reconnects', () => {
    const { conn, sockets, clock } = setup({ rotateAfterMs: 1000 });
    conn.start();
    sockets[0]?.open();
    conn.close();
    sockets[0]?.emit('close', {});
    clock.advance(120_000);
    expect(sockets).toHaveLength(1);
    expect(clock.pendingTimers).toBe(0);
  });

  describe('rotation (venue connection lifetime)', () => {
    it('opens a replacement, switches only once it delivers, then closes the old socket', () => {
      const { conn, sockets, clock, messages, statuses } = setup({ rotateAfterMs: 100_000 });
      conn.start();
      sockets[0]?.open();
      sockets[0]?.message('old-1');
      clock.advance(100_000);
      expect(sockets).toHaveLength(2);
      expect(sockets[0]?.closedWith).toBeNull(); // old stays up until the new one proves itself

      sockets[1]?.open();
      sockets[0]?.message('old-2'); // still receiving during overlap: no gap
      sockets[1]?.message('new-1');
      expect(sockets[0]?.closedWith).toBe(1000);
      expect(messages).toEqual(['old-1', 'old-2', 'new-1']);
      expect(statuses).toEqual(['CONNECTED', 'ROTATED']);
      expect(conn.connected).toBe(true);

      // The retired socket closing is not a disconnect.
      sockets[0]?.emit('close', { code: 1000 });
      expect(statuses).toEqual(['CONNECTED', 'ROTATED']);

      // And the cycle continues from the new socket.
      clock.advance(100_000);
      expect(sockets).toHaveLength(3);
    });

    it('abandons a replacement that stays silent and keeps the old connection', () => {
      const { conn, sockets, clock, statuses } = setup({
        rotateAfterMs: 100_000,
        rotationConfirmMs: 30_000,
      });
      conn.start();
      sockets[0]?.open();
      sockets[0]?.message('a');
      clock.advance(100_000);
      sockets[1]?.open(); // never sends a frame
      clock.advance(30_000);
      expect(sockets[1]?.closedWith).toBe(1000);
      expect(sockets[0]?.closedWith).toBeNull();
      expect(statuses).toEqual(['CONNECTED']);
      clock.advance(60_000);
      expect(sockets).toHaveLength(3); // retried
    });

    it('survives the old socket dying while the replacement is still warming up', () => {
      const { conn, sockets, clock, statuses } = setup({ rotateAfterMs: 100_000 });
      conn.start();
      sockets[0]?.open();
      sockets[0]?.message('a');
      clock.advance(100_000);
      sockets[0]?.emit('close', { code: 1006 });
      expect(statuses).toContain('DISCONNECTED:closed (1006)');
      sockets[1]?.open();
      sockets[1]?.message('b');
      expect(conn.connected).toBe(true);
    });
  });
});
