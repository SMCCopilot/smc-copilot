import { z } from 'zod';

/**
 * Execution gate, trade log, notifications, journal and feedback bodies (A04 section 11, A07 sections 7 and 8).
 * The gate is REST only and confirmed by a UI tap; no realtime event and no voice command can confirm it.
 */

const price = z.number().finite().positive().max(1e12);

export const GateIssueSchema = z.strictObject({ planId: z.uuid() });
export const GateConfirmSchema = z.strictObject({
  token: z.string().min(16).max(200),
  /** The hash the user was shown. A confirmation for any other plan content is refused. */
  planHash: z.string().min(8).max(128),
});
export const GateDeclineSchema = z.strictObject({ reason: z.string().max(200).optional() });

export const TradeCreateSchema = z.strictObject({
  instrumentId: z.uuid(),
  direction: z.enum(['LONG', 'SHORT']),
  entryPrice: price,
  size: z.number().finite().positive().max(1e15).optional(),
  leverage: z.number().finite().min(1).max(1000).optional(),
  stopPrice: price.optional(),
  targets: z.array(price).max(4).optional(),
  /** A trade that follows a plan needs a confirmed, unused gate for exactly that plan. */
  planId: z.uuid().optional(),
  gateId: z.uuid().optional(),
  notes: z.string().max(2000).optional(),
});

export const TradePatchSchema = z.strictObject({
  stopPrice: price.nullable().optional(),
  targets: z.array(price).max(4).optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const TradeCloseSchema = z.strictObject({
  exitPrice: price,
  reason: z.enum(['TP', 'SL', 'MANUAL', 'LIQUIDATED', 'EXPIRED']).default('MANUAL'),
  fee: z.number().finite().nonnegative().optional(),
});

export const JournalNoteSchema = z.strictObject({
  notes: z.string().min(1).max(4000),
  tags: z.array(z.string().min(1).max(32)).max(12).default([]),
  setupId: z.uuid().optional(),
  tradeId: z.uuid().optional(),
});
export const JournalPatchSchema = z.strictObject({
  notes: z.string().min(1).max(4000).optional(),
  tags: z.array(z.string().min(1).max(32)).max(12).optional(),
});

export const FeedbackSchema = z.strictObject({
  targetType: z.enum(['narrative', 'chat_message', 'setup']),
  targetId: z.string().min(1).max(100),
  rating: z.union([z.literal(-1), z.literal(1)]).optional(),
  comment: z.string().max(1000).optional(),
});
