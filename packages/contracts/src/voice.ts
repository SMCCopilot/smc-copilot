import { z } from 'zod';

/** Speech engine that produced a transcript. Server engines are reserved for Tier 2 (A02 section 6.3). */
export const STT_ENGINE_TAGS = [
  'whisper-web',
  'moonshine-web',
  'parakeet-server',
  'whispercpp-server',
  'typed',
] as const;
export const SttEngineTagSchema = z.enum(STT_ENGINE_TAGS);
export type SttEngineTag = z.infer<typeof SttEngineTagSchema>;

export const InputModeSchema = z.enum(['text', 'voice']);
export type InputMode = z.infer<typeof InputModeSchema>;

/**
 * Actions a spoken command may never perform (invariant 1). Enforced here for the router,
 * and in the database for gate confirmation (`gate_decisions.confirmed_via = 'UI_TAP'`).
 */
export const VOICE_FORBIDDEN_ACTIONS = [
  'confirm_gate',
  'confirm_trade',
  'log_trade',
  'change_risk',
  'delete_data',
  'delete_account',
  'pay',
] as const;
export type VoiceForbiddenAction = (typeof VOICE_FORBIDDEN_ACTIONS)[number];

// ---- configuration the browser needs to run speech recognition on the device --------------------------------------

/** One file of a speech model. The browser refuses a file whose SHA-256 differs (A02 section 6.3). */
export const VoiceModelFileSchema = z.strictObject({
  id: z.string().min(1).max(80),
  url: z.url().max(400),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});

export const VoiceEngineConfigSchema = z.strictObject({
  tag: SttEngineTagSchema,
  label: z.string().max(60),
  /** READY: pinned and usable. UNPINNED: files listed but not hash-pinned yet, so the browser must not use it. */
  status: z.enum(['READY', 'UNPINNED', 'OFF']),
  backend: z.enum(['webgpu', 'wasm']),
  files: z.array(VoiceModelFileSchema).max(20),
});

export const VoiceConfigSchema = z.strictObject({
  /** Audio never leaves the device; this is stated in the contract so a client can show it. */
  audioLeavesDevice: z.literal(false),
  maxUtteranceMs: z.number().int().positive(),
  minConfidence: z.number().min(0).max(1),
  languages: z.array(z.string().max(8)).max(10),
  glossaryVersion: z.string(),
  engines: z.array(VoiceEngineConfigSchema).max(6),
  vad: z.strictObject({
    status: z.enum(['READY', 'UNPINNED', 'OFF']),
    files: z.array(VoiceModelFileSchema).max(4),
  }),
});
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/** Metadata about one utterance, reported by the browser. No audio and no transcript text (A02 section 6). */
export const VoiceEventBodySchema = z.strictObject({
  sessionId: z.uuid().optional(),
  engine: SttEngineTagSchema,
  outcome: z.enum(['OK', 'LOW_CONFIDENCE', 'NO_SPEECH', 'ERROR']),
  durationMs: z.number().int().min(0).max(120_000).optional(),
  latencyMs: z.number().int().min(0).max(120_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  language: z.string().max(8).optional(),
  errorCode: z.string().max(40).optional(),
});
