'use client';
import type { SttEngineTag } from '@smc/contracts';
import { addUserMessage, say } from './chat';
import { emitEvent } from './live';

export interface SttInfo {
  confidence: number;
  engine: SttEngineTag;
}

/** Chat and voice questions travel over the socket as text. They can never confirm or log anything. */
export function sendChat(text: string, via: 'text' | 'voice', stt?: SttInfo): boolean {
  const clientMsgId = crypto.randomUUID().replaceAll('-', '').slice(0, 32);
  const ok = emitEvent('chat.send', {
    clientMsgId,
    text,
    inputMode: via,
    ...(stt ? { sttConfidence: stt.confidence, sttEngine: stt.engine } : {}),
  });
  if (!ok) {
    say('The live connection is not open yet. Try again in a moment.');
    return false;
  }
  addUserMessage(text, via);
  return true;
}

/** A spoken command (or a refused request) goes to the voice router so it is understood or recorded. */
export function sendVoiceCommand(text: string, stt: SttInfo): boolean {
  const ok = emitEvent('voice.command', {
    utteranceId: crypto.randomUUID().replaceAll('-', '').slice(0, 32),
    text: text.slice(0, 500),
    sttConfidence: stt.confidence,
    sttEngine: stt.engine,
  });
  if (!ok) say('The live connection is not open yet. Try again in a moment.');
  else addUserMessage(text, 'voice');
  return ok;
}
