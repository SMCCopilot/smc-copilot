import { z } from 'zod';

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
export const TimeframeSchema = z.enum(TIMEFRAMES);
export type Timeframe = z.infer<typeof TimeframeSchema>;

export const TIMEFRAME_MS: Readonly<Record<Timeframe, number>> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** Timeframes derived from the 1m base by aggregation (A03 section 5.3). */
export const DERIVED_TIMEFRAMES = [
  '5m',
  '15m',
  '1h',
  '4h',
  '1d',
] as const satisfies readonly Timeframe[];
