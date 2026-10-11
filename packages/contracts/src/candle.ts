import { z } from 'zod';
import { TimeframeSchema } from './timeframe.js';

const price = z.number().finite().positive();

/** A validated candle. Only `closed` candles feed the engine (A03 section 1). `openTime` is epoch ms UTC of the OPEN. */
export const CandleSchema = z
  .strictObject({
    instrumentId: z.string().min(1),
    tf: TimeframeSchema,
    openTime: z.number().int().nonnegative(),
    o: price,
    h: price,
    l: price,
    c: price,
    v: z.number().finite().nonnegative(),
    closed: z.boolean(),
    providerId: z.string().min(1),
    /** Quality flags (CANDLE_FLAGS). Optional: absent means clean. */
    flags: z.number().int().nonnegative().optional(),
  })
  .refine((k) => k.l <= Math.min(k.o, k.c) && k.h >= Math.max(k.o, k.c), {
    message: 'OHLC is inconsistent (low <= open,close <= high is required)',
  });
export type Candle = z.infer<typeof CandleSchema>;

/** Candle quality flags (bitmask stored in `candles.flags`, A03 section 5.2). */
export const CANDLE_FLAGS = {
  SPIKE_SUSPECT: 1,
  CROSSCHECK_DIVERGENCE: 2,
  FLAT: 4,
  GAP_PRICE: 8,
  BACKFILLED: 16,
} as const;
