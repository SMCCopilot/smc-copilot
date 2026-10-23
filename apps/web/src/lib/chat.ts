'use client';
import type { NarrativeResponse } from '@smc/contracts';
import { create } from 'zustand';

export interface ExplainContentView {
  headline: string;
  what_you_are_looking_at: string;
  structure: string;
  key_levels: { ref: string; why: string }[];
  liquidity: string;
  scenarios: { kind: 'PRIMARY' | 'ALTERNATE'; if_then: string }[];
  what_to_watch: string[];
  caveats: string[];
  user_markings_note: string | null;
}

export type Msg =
  | { kind: 'narrative'; id: string; at: number; n: NarrativeResponse }
  | { kind: 'user'; id: string; at: number; text: string; via: 'text' | 'voice' }
  | {
      kind: 'assistant';
      id: string;
      at: number;
      text: string;
      done: boolean;
      ai: boolean;
      clientMsgId: string;
    }
  | {
      kind: 'explain';
      id: string;
      at: number;
      stage: string;
      done: boolean;
      mode?: 'GROUNDED' | 'APPROXIMATE';
      content?: ExplainContentView;
      warnings: string[];
      ai: boolean;
    }
  | { kind: 'system'; id: string; at: number; text: string };

export interface BudgetView {
  spentUsd: number;
  limitUsd: number;
  state: 'OK' | 'SOFT' | 'HARD';
  resetsAt: string;
}

interface ChatStore {
  messages: Msg[];
  /** True from the moment a question is sent until the answer (or a refusal) arrives: drives the typing indicator. */
  waiting: boolean;
  setWaiting: (w: boolean) => void;
  budget: BudgetView | null;
  push: (m: Msg) => void;
  patch: (id: string, fn: (m: Msg) => Msg) => void;
  remove: (id: string) => void;
  reset: () => void;
  setBudget: (b: BudgetView) => void;
}

const MAX = 200;
export const useChat = create<ChatStore>((set) => ({
  messages: [],
  waiting: false,
  setWaiting: (waiting) => set({ waiting }),
  budget: null,
  push: (m) => set((s) => ({ messages: [...s.messages, m].slice(-MAX) })),
  patch: (id, fn) => set((s) => ({ messages: s.messages.map((m) => (m.id === id ? fn(m) : m)) })),
  remove: (id) => set((s) => ({ messages: s.messages.filter((m) => m.id !== id) })),
  reset: () => set({ messages: [], waiting: false }),
  setBudget: (budget) => set({ budget }),
}));

let n = 0;
const uid = (p: string) => `${p}-${Date.now()}-${++n}`;

export const say = (text: string) =>
  useChat.getState().push({ kind: 'system', id: uid('sys'), at: Date.now(), text });

export function addUserMessage(text: string, via: 'text' | 'voice'): string {
  const id = uid('me');
  useChat.getState().push({ kind: 'user', id, at: Date.now(), text, via });
  return id;
}

/** A new scenario card only when the facts changed; a model-written text replaces the template for the same facts. */
export function applyNarrative(nr: NarrativeResponse): void {
  const { messages, push, patch } = useChat.getState();
  const last = [...messages].reverse().find((m) => m.kind === 'narrative');
  if (last && last.kind === 'narrative' && last.n.factsHash === nr.factsHash) {
    if (last.n.source !== nr.source || last.n.generating !== nr.generating)
      patch(last.id, (m) => ({ ...m, n: nr }) as Msg);
    return;
  }
  push({ kind: 'narrative', id: uid('nar'), at: Date.now(), n: nr });
}

const msgIdFor = (clientMsgId: string) => `as-${clientMsgId}`;

export function applyChatEvent(type: string, p: Record<string, unknown>): boolean {
  const { messages, push, patch, remove, setBudget } = useChat.getState();
  switch (type) {
    case 'chat.chunk': {
      useChat.getState().setWaiting(false);
      const id = msgIdFor(String(p.clientMsgId));
      if (messages.some((m) => m.id === id)) {
        patch(id, (m) =>
          m.kind === 'assistant' ? { ...m, text: m.text + String(p.delta ?? '') } : m,
        );
      } else {
        push({
          kind: 'assistant',
          id,
          at: Date.now(),
          text: String(p.delta ?? ''),
          done: false,
          ai: false,
          clientMsgId: String(p.clientMsgId),
        });
      }
      return true;
    }
    case 'chat.done': {
      useChat.getState().setWaiting(false);
      const id = msgIdFor(String(p.clientMsgId));
      const done = {
        kind: 'assistant',
        id,
        at: Date.now(),
        text: String(p.text ?? ''),
        done: true,
        ai: p.aiGenerated === true,
        clientMsgId: String(p.clientMsgId),
      } as const;
      if (messages.some((m) => m.id === id)) patch(id, () => done);
      else push(done);
      return true;
    }
    case 'chat.retract': {
      useChat.getState().setWaiting(false);
      const id = msgIdFor(String(p.clientMsgId ?? ''));
      remove(id);
      say('A reply was withdrawn because it did not pass a safety check.');
      return true;
    }
    case 'budget.update':
      setBudget(p as unknown as BudgetView);
      return true;
    case 'explain.stage': {
      const id = currentExplainId();
      const stage = String(p.stage ?? '');
      if (!id) startExplain(stage);
      else patch(id, (m) => (m.kind === 'explain' ? { ...m, stage } : m));
      return true;
    }
    case 'explain.done': {
      const id = currentExplainId() ?? startExplain('writing');
      patch(id, (m) =>
        m.kind === 'explain'
          ? {
              ...m,
              done: true,
              stage: 'done',
              mode: p.mode as 'GROUNDED' | 'APPROXIMATE',
              content: p.content as ExplainContentView,
              warnings: (p.warnings as string[]) ?? [],
              ai: p.aiGenerated === true,
            }
          : m,
      );
      return true;
    }
    case 'explain.chunk':
      return true; // the finished, checked answer arrives in explain.done
    default:
      return false;
  }
}

export function currentExplainId(): string | null {
  const m = [...useChat.getState().messages].reverse().find((x) => x.kind === 'explain' && !x.done);
  return m ? m.id : null;
}

export function startExplain(stage = 'resolving'): string {
  const id = uid('ex');
  useChat
    .getState()
    .push({ kind: 'explain', id, at: Date.now(), stage, done: false, warnings: [], ai: false });
  return id;
}

export function failExplain(message: string): void {
  const id = currentExplainId();
  if (id) useChat.getState().remove(id);
  say(message);
}
