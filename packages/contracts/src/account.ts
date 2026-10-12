import { z } from 'zod';

/** Account, wallets, gates and admin operations (A07 sections 3 and 9). Zod is the source of truth for every body. */

export const WalletChainSchema = z.enum(['evm', 'solana']);
export type WalletChain = z.infer<typeof WalletChainSchema>;

export const WalletDtoSchema = z.strictObject({
  id: z.uuid(),
  chain: WalletChainSchema,
  /** EIP-55 checksum form for EVM, base58 as-is for Solana. */
  address: z.string(),
  primary: z.boolean(),
  linkedAt: z.string(),
});
export type WalletDto = z.infer<typeof WalletDtoSchema>;

export const MeResponseSchema = z.strictObject({
  user: z.strictObject({
    id: z.uuid(),
    displayName: z.string().nullable(),
    locale: z.string(),
    timezone: z.string(),
    createdAt: z.string(),
  }),
  wallets: z.array(WalletDtoSchema),
  email: z.strictObject({ address: z.string(), verified: z.boolean() }).nullable(),
  workspace: z.strictObject({ id: z.uuid(), plan: z.enum(['free', 'pro', 'team']) }),
  entitlements: z.strictObject({
    limits: z.record(z.string(), z.number()),
    features: z.record(z.string(), z.boolean()),
  }),
  invite: z.strictObject({ required: z.boolean(), redeemed: z.boolean() }),
  disclaimer: z.strictObject({
    required: z.boolean(),
    currentVersion: z.string(),
    acceptedVersion: z.string().nullable(),
  }),
  ageConfirmed: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const PatchMeSchema = z
  .strictObject({
    displayName: z.string().trim().min(1).max(40).nullable().optional(),
    locale: z
      .string()
      .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/)
      .optional(),
    timezone: z.string().min(1).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });

export const InviteBodySchema = z.strictObject({ code: z.string().trim().min(3).max(64) });
export const DisclaimerBodySchema = z.strictObject({ version: z.string().min(1).max(32) });
export const AgeBodySchema = z.strictObject({ confirmed: z.literal(true) });

// ---- admin

const kv = z.record(z.string().min(1).max(64), z.number().finite());

export const InviteCreateSchema = z.strictObject({
  /** Omit to have a random code generated. */
  code: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{4,40}$/)
    .optional(),
  note: z.string().max(200).optional(),
  maxUses: z.number().int().min(1).max(10_000).default(1),
  expiresAt: z.iso.datetime().optional(),
  /** Merged into the redeemer's entitlements.limits. */
  grants: kv.optional(),
});

export const BlocklistEntrySchema = z.strictObject({
  chain: WalletChainSchema,
  address: z.string().min(10).max(64),
  note: z.string().max(200).optional(),
  action: z.enum(['ADD', 'REMOVE']).default('ADD'),
});

export const BlocklistImportSchema = z.strictObject({
  source: z.string().min(1).max(40),
  entries: z
    .array(z.strictObject({ chain: WalletChainSchema, address: z.string().min(10).max(64) }))
    .min(1)
    .max(50_000),
});

export const EntitlementsPatchSchema = z
  .strictObject({
    limits: kv.optional(),
    features: z.record(z.string().min(1).max(64), z.boolean()).optional(),
  })
  .refine((v) => v.limits !== undefined || v.features !== undefined, {
    message: 'limits or features is required',
  });

export const BlockUserSchema = z.strictObject({
  blocked: z.boolean(),
  reason: z.string().max(200).optional(),
});

export const FlagBodySchema = z.strictObject({
  enabled: z.boolean(),
  rolloutPct: z.number().int().min(0).max(100).optional(),
});

export const KILL_SWITCH_SCOPES = [
  'AI',
  'EXPLAIN',
  'IMAGE_READ',
  'VOICE_SERVER',
  'CHAT',
  'SIGNUP',
  'ALL_SESSIONS',
] as const;
export const KillSwitchSchema = z.strictObject({
  scope: z.enum(KILL_SWITCH_SCOPES),
  active: z.boolean(),
});
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];

export const StrategyVersionCreateSchema = z.strictObject({
  name: z.string().min(1).max(40).default('smc-core'),
  /** A strategy config as in `strategy_versions.config` (no id; the database assigns it). */
  config: z.record(z.string(), z.unknown()),
  notes: z.string().max(500).optional(),
});

/** Deleting an account is deliberate: the exact phrase must be sent, together with a fresh wallet signature. */
export const DELETE_CONFIRMATION = 'DELETE MY ACCOUNT';
export const DeleteMeSchema = z.strictObject({ confirm: z.literal(DELETE_CONFIRMATION) });
