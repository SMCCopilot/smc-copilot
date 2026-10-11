import { z } from 'zod';
import { CanonicalInstrumentSchema } from './instrument.js';
import { OcrContextSchema } from './ocr.js';
import { TimeframeSchema } from './timeframe.js';
import { InputModeSchema, SttEngineTagSchema } from './voice.js';

export const WARNING_CODES = [
  'FEED_STALE',
  'FEED_MISMATCH',
  'AI_DEGRADED',
  'CAPTURE_LOST',
  'LOW_OCR_CONFIDENCE',
  'APPROX_MODE',
  'RATE_LIMITED',
  'BUDGET_SOFT_LIMIT',
  'VENUE_CHANGED',
  'STT_UNAVAILABLE',
  'STALE_IMAGE',
  'MIC_PERMISSION_DENIED',
] as const;
export const WarningCodeSchema = z.enum(WARNING_CODES);
export type WarningCode = z.infer<typeof WarningCodeSchema>;

/** Every server event carries a per-session monotonic `seq` and a correlation id (A02 section 4). */
export const serverEnvelope = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({
    seq: z.number().int().nonnegative(),
    type: z.literal(type),
    at: z.number().int().nonnegative(),
    correlationId: z.string().min(1),
    payload,
  });

export const SERVER_EVENT_TYPES = [
  'session.state',
  'context.updated',
  'price.tick',
  'candle.update',
  'analysis.update',
  'setup.event',
  'narrative.chunk',
  'narrative.done',
  'explain.stage',
  'explain.chunk',
  'explain.done',
  'chat.chunk',
  'chat.done',
  'chat.retract',
  'voice.partial',
  'voice.final',
  'frame.result',
  'warning',
  'budget.update',
  'position.event',
  'gate.state',
  'notification',
  'engine.revision',
  'feed.status',
  'error',
] as const;
export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

export const WarningEventSchema = serverEnvelope(
  'warning',
  z.strictObject({ code: WarningCodeSchema, detail: z.string().max(500).optional() }),
);

// ---- Client -> server -------------------------------------------------------------------------------------

const uuid = z.uuid();
const clientId = z.string().min(1).max(64);

export const ExplainRequestSchema = z.strictObject({
  mode: z.enum(['SHARE', 'UPLOAD']),
  ocr: OcrContextSchema.optional(),
  instrumentHint: CanonicalInstrumentSchema.optional(),
  tfHint: TimeframeSchema.optional(),
  question: z.string().max(500).optional(),
  lang: z.string().max(16).optional(),
  imageMeta: z
    .strictObject({
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
      width: z.number().int().positive().max(2400),
      height: z.number().int().positive().max(2400),
    })
    .optional(),
});

/**
 * The complete set of client events and their payloads. There is deliberately no event that confirms a gate,
 * logs a trade, changes risk, deletes data or pays: those are REST calls confirmed by a UI tap (B04 section 3,
 * invariant 1). The exact-set test in the contracts package fails if an event is added without a decision.
 */
export const ClientEventSchemas = {
  'session.start': z.strictObject({
    sessionId: uuid,
    instrumentId: CanonicalInstrumentSchema.optional(),
    tf: TimeframeSchema.optional(),
    lastSeq: z.number().int().nonnegative().optional(),
  }),
  'session.pause': z.strictObject({}),
  'session.end': z.strictObject({}),
  'context.set': z.strictObject({
    instrumentId: CanonicalInstrumentSchema,
    tf: TimeframeSchema,
    source: z.literal('manual'),
  }),
  'context.hint': OcrContextSchema,
  'explain.request': ExplainRequestSchema,
  'explain.cancel': z.strictObject({ explainId: uuid }),
  'chat.send': z.strictObject({
    clientMsgId: clientId,
    text: z.string().min(1).max(2000),
    inputMode: InputModeSchema,
    sttConfidence: z.number().min(0).max(1).optional(),
    sttEngine: SttEngineTagSchema.optional(),
  }),
  'chat.cancel': z.strictObject({ messageId: clientId }),
  'voice.command': z.strictObject({
    utteranceId: clientId,
    text: z.string().min(1).max(500),
    sttConfidence: z.number().min(0).max(1),
    sttEngine: SttEngineTagSchema,
  }),
  'analysis.request': z.strictObject({
    scope: z.enum(['now', 'htf', 'setup']),
    setupId: clientId.optional(),
  }),
  'setup.watch': z.strictObject({ setupId: clientId, watch: z.boolean() }),
} as const;

export type ClientEventType = keyof typeof ClientEventSchemas;
export const CLIENT_EVENT_TYPES = Object.keys(ClientEventSchemas) as ClientEventType[];

/**
 * Events that exist in the protocol but are not served in the MVP (B04 section 3). A client that sends one
 * receives `STT_UNAVAILABLE` (voice audio, Tier 2 speech-to-text) or `FORBIDDEN`-style rejection, never silence.
 */
export const RESERVED_CLIENT_EVENTS = [
  'voice.begin',
  'voice.audio',
  'voice.end',
  'frame.submit',
] as const;
