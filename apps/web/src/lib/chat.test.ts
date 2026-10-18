import type { NarrativeResponse } from '@smc/contracts';
import { forbiddenByVoice } from '@smc/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyChatEvent, applyNarrative, useChat } from './chat';
import { checkImage, MAX_IMAGE_BYTES } from './explain';
import { repoOf } from './speech-loader';

const nar = (hash: string, source: 'LLM' | 'TEMPLATE'): NarrativeResponse => ({
  instrumentId: 'i',
  asOf: 'now',
  source,
  aiGenerated: source === 'LLM',
  factsHash: hash,
  promptVersion: 'v1',
  generating: false,
  content: {
    headline: 'h',
    bias_summary: 'b',
    scenarios: [],
    risks_and_unknowns: [],
    history: [],
    refs_used: [],
  },
});

beforeEach(() => useChat.getState().reset());

describe('chat stream', () => {
  it('builds an assistant message from chunks and replaces it with the final text', () => {
    applyChatEvent('chat.chunk', { clientMsgId: 'c1', delta: 'Hel' });
    applyChatEvent('chat.chunk', { clientMsgId: 'c1', delta: 'lo' });
    expect(useChat.getState().messages).toHaveLength(1);
    applyChatEvent('chat.done', { clientMsgId: 'c1', text: 'Hello there', aiGenerated: true });
    const [m] = useChat.getState().messages;
    expect(m?.kind === 'assistant' && m.text).toBe('Hello there');
    expect(m?.kind === 'assistant' && m.ai).toBe(true);
  });
  it('removes a retracted reply and says why', () => {
    applyChatEvent('chat.done', { clientMsgId: 'c2', text: 'x', aiGenerated: false });
    applyChatEvent('chat.retract', { clientMsgId: 'c2' });
    const kinds = useChat.getState().messages.map((m) => m.kind);
    expect(kinds).toEqual(['system']);
  });
  it('keeps the budget the server reports', () => {
    applyChatEvent('budget.update', { spentUsd: 0.4, limitUsd: 1, state: 'OK', resetsAt: 'x' });
    expect(useChat.getState().budget?.limitUsd).toBe(1);
  });
});

describe('narrative cards', () => {
  it('adds a card only when the facts change and upgrades a template in place', () => {
    applyNarrative(nar('a', 'TEMPLATE'));
    applyNarrative(nar('a', 'TEMPLATE'));
    expect(useChat.getState().messages).toHaveLength(1);
    applyNarrative(nar('a', 'LLM'));
    expect(useChat.getState().messages).toHaveLength(1);
    const [m] = useChat.getState().messages;
    expect(m?.kind === 'narrative' && m.n.source).toBe('LLM');
    applyNarrative(nar('b', 'TEMPLATE'));
    expect(useChat.getState().messages).toHaveLength(2);
  });
});

describe('explain upload rules', () => {
  it('accepts only small png, jpeg and webp images', () => {
    expect(checkImage(new File(['x'], 'a.png', { type: 'image/png' }))).toBeNull();
    expect(checkImage(new File(['x'], 'a.gif', { type: 'image/gif' }))).toMatch(/PNG/);
    const big = new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'a.png', { type: 'image/png' });
    expect(checkImage(big)).toMatch(/too large/);
  });
});

describe('voice rules', () => {
  it('refuses to let voice confirm, log, change risk, delete or pay', () => {
    for (const phrase of ['confirm the trade', 'log the trade', 'delete my account']) {
      expect(forbiddenByVoice(phrase)).not.toBeNull();
    }
    expect(forbiddenByVoice('explain this chart')).toBeNull();
  });
  it('reads the pinned repo and revision from a model file address', () => {
    const rev = 'a'.repeat(40);
    expect(
      repoOf(`https://huggingface.co/onnx-community/whisper-tiny.en/resolve/${rev}/config.json`),
    ).toEqual({
      repo: 'onnx-community/whisper-tiny.en',
      revision: rev,
    });
    expect(repoOf('https://example.com/x')).toBeNull();
  });
});
