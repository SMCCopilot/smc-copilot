import { z } from 'zod';

/**
 * Text-only context read on the user's device (A02 section 3.2). No pixels are ever part of this payload.
 * The server treats every string as untrusted and re-derives symbol, venue, timeframe and price itself.
 */
export const OCR_TEXT_KINDS = [
  'SYMBOL',
  'TIMEFRAME',
  'VENUE',
  'LAST_PRICE',
  'AXIS_LABEL',
  'OHLC_LEGEND',
  'OTHER',
] as const;

const MAX_TEXTS = 64;
const coord = z.number().finite().min(-100_000).max(100_000);
const MAX_TEXT_LENGTH = 120;

export const OcrContextSchema = z.strictObject({
  capturedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  roi: z.strictObject({
    w: z.number().positive().max(20_000),
    h: z.number().positive().max(20_000),
  }),
  texts: z
    .array(
      z.strictObject({
        kind: z.enum(OCR_TEXT_KINDS),
        text: z.string().max(MAX_TEXT_LENGTH),
        conf: z.number().min(0).max(1),
        box: z.tuple([coord, coord, coord, coord]),
      }),
    )
    .max(MAX_TEXTS),
  derived: z
    .strictObject({
      symbolText: z.string().max(MAX_TEXT_LENGTH).optional(),
      tfText: z.string().max(MAX_TEXT_LENGTH).optional(),
      venueText: z.string().max(MAX_TEXT_LENGTH).optional(),
      isPerp: z.boolean().optional(),
      lastPrice: z.number().finite().positive().max(1e12).optional(),
      axisPrices: z.array(z.number().finite().min(-1e12).max(1e12)).max(MAX_TEXTS).optional(),
      platform: z.enum(['TRADINGVIEW', 'OTHER', 'UNKNOWN']).optional(),
    })
    .optional(),
  engine: z.strictObject({
    name: z.enum(['paddleocr-web', 'tesseract-js']),
    version: z.string().max(32),
    backend: z.enum(['webgpu', 'wasm']),
    ms: z.number().nonnegative().max(600_000),
  }),
});
export type OcrContext = z.infer<typeof OcrContextSchema>;
