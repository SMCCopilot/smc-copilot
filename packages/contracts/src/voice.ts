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
