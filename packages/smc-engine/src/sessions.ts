// UTC calendar helpers and session context (A04 section 9). Fixed UTC windows, no DST, no Date/Intl.
import type { SessionDef, StrategyConfig } from '@smc/contracts';

export const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export const dayStartOf = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

/** Monday 00:00 UTC of the week containing t (epoch day 0 was a Thursday). */
export const weekStartOf = (t: number): number => {
  const days = Math.floor(t / DAY_MS);
  return (days - ((days + 3) % 7)) * DAY_MS;
};

/** First day of the UTC month containing t (days-to-civil algorithm, integer arithmetic only). */
export const monthStartOf = (t: number): number => {
  const days = Math.floor(t / DAY_MS);
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const dayOfMonth = doy - Math.floor((153 * mp + 2) / 5) + 1;
  return (days - (dayOfMonth - 1)) * DAY_MS;
};

/** Saturday or Sunday in UTC. */
export const isWeekend = (t: number): boolean => {
  const dow = (Math.floor(t / DAY_MS) + 4) % 7; // 0 = Sunday
  return dow === 0 || dow === 6;
};

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

const within = (minute: number, start: number, end: number): boolean =>
  start < end ? minute >= start && minute < end : minute >= start || minute < end;

export const minuteOfDay = (t: number): number => Math.floor((t - dayStartOf(t)) / MIN_MS);

export const inSession = (t: number, s: SessionDef): boolean =>
  within(minuteOfDay(t), minutes(s.start), minutes(s.end));

/** Open time of the session instance that contains t (the previous day's start for a wrapped window). */
export function sessionInstanceStart(t: number, s: SessionDef): number {
  const start = minutes(s.start);
  const day = dayStartOf(t);
  return minuteOfDay(t) >= start ? day + start * MIN_MS : day - DAY_MS + start * MIN_MS;
}

export interface SessionContext {
  active: string[];
  killzones: string[];
  inKillzone: boolean;
  weekend: boolean;
  /** Minutes since each active session opened. */
  minutesSinceOpen: Record<string, number>;
}

export function sessionContext(t: number, cfg: StrategyConfig): SessionContext {
  const active: string[] = [];
  const killzones: string[] = [];
  const minutesSinceOpen: Record<string, number> = {};
  for (const s of cfg.sessions) {
    if (!inSession(t, s)) continue;
    active.push(s.id);
    minutesSinceOpen[s.id] = Math.floor((t - sessionInstanceStart(t, s)) / MIN_MS);
    if (s.killzone && within(minuteOfDay(t), minutes(s.killzone.start), minutes(s.killzone.end))) {
      killzones.push(s.id);
    }
  }
  return {
    active,
    killzones,
    inKillzone: killzones.length > 0,
    weekend: isWeekend(t),
    minutesSinceOpen,
  };
}
