'use client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { ArrowUp, Check, Copy, Mic, ScanSearch, Sparkles, Square } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Msg, useChat } from '../lib/chat';
import { useLive } from '../lib/live';
import { useAnalysis } from '../lib/market';
import { sendChat, sendVoiceCommand } from '../lib/send';
import { useSelection } from '../lib/sessions';
import { pickSetup, useUi } from '../lib/ui';
import { MAX_VOICE_TEXT, useTranscript, useVoice } from '../lib/voice';
import { directionLabel } from '../lib/wording';
import { BudgetMeter } from './budget-meter';
import { GradeChip } from './canvas-tabs';
import { ExplainDialog } from './explain-dialog';
import { Pill } from './kit';

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const AiTag = () => (
  <span title="Written by an AI model from the engine's facts">
    <Pill>AI-written</Pill>
  </span>
);

function Avatar() {
  return (
    <span
      className="brand-bg grid size-7 shrink-0 place-items-center rounded-full text-white shadow-[0_4px_14px_-4px_rgb(79_91_255/0.8)]"
      aria-hidden
    >
      <Sparkles className="size-3.5" />
    </span>
  );
}

/** Light formatting for the assistant's text: paragraphs, bullet lists and **bold**. Nothing is ever rendered as HTML. */
function inline(line: string): ReactNode[] {
  return line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: positions in a static split
      <strong key={i} className="font-semibold">
        {part.slice(2, -2)}
      </strong>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: positions in a static split
      <span key={i}>{part}</span>
    ),
  );
}
function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    out.push(
      <ul key={`u${out.length}`} className="my-1.5 list-disc space-y-1 pl-5">
        {items.map((b) => (
          <li key={b}>{inline(b)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^([-•*])\s+(.*)$/.exec(line);
    if (m?.[2]) bullets.push(m[2]);
    else {
      flush();
      if (line) out.push(<p key={`p${out.length}`}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="space-y-1.5 leading-relaxed">{out}</div>;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy this reply"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="rounded-ctl p-1 text-muted opacity-0 transition-opacity hover:bg-s3 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
    >
      {done ? (
        <Check className="size-3.5" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </button>
  );
}

function ScenarioSummary() {
  const sel = useSelection();
  const ui = useUi();
  const a = useAnalysis(sel.instrumentId, sel.tf).data;
  const s = pickSetup(a, ui.setupId, ui.dismissed);
  if (!s) return null;
  const rr = s.plan?.targets[0]?.rr;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-s3 px-3 py-2">
      <Pill tone={s.direction === 'LONG' ? 'bull' : 'bear'}>{directionLabel(s.direction)}</Pill>
      <GradeChip grade={s.grade} />
      {rr !== undefined && (
        <span className="num text-xs text-muted">
          {rr.toFixed(1)}× the risk to the first target
        </span>
      )}
      <button
        type="button"
        onClick={() => {
          ui.setTab('Plan');
          ui.setDrawer(true);
        }}
        className="btn-ghost ml-auto px-2.5 py-1 text-xs"
      >
        Open setup
      </button>
    </div>
  );
}

function Bubble({ m }: { m: Msg }) {
  if (m.kind === 'system') {
    return (
      <p className="rise mx-auto max-w-[92%] rounded-full bg-s3 px-3 py-1 text-center text-xs text-muted">
        {m.text}
      </p>
    );
  }
  if (m.kind === 'user') {
    return (
      <div className="rise ml-auto max-w-[88%]">
        <p className="brand-bg whitespace-pre-wrap rounded-2xl rounded-br-md px-3.5 py-2 text-white shadow-[0_6px_18px_-10px_rgb(79_91_255/0.9)]">
          {m.text}
        </p>
        <p className="mt-1 text-right text-[11px] text-muted">
          {time(m.at)}
          {m.via === 'voice' ? ' · by voice' : ''}
        </p>
      </div>
    );
  }
  if (m.kind === 'assistant') {
    return (
      <div className="rise group flex max-w-[94%] gap-2">
        <Avatar />
        <div className="min-w-0">
          <div className="rounded-2xl rounded-tl-md border border-line bg-s2 px-3.5 py-2.5">
            <Rich text={m.text} />
          </div>
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
            <span>Copilot · {time(m.at)}</span>
            {m.done && m.ai && <AiTag />}
            {m.done && <CopyButton text={m.text} />}
          </div>
        </div>
      </div>
    );
  }
  if (m.kind === 'narrative') {
    const n = m.n;
    return (
      <article className="rise surface-card overflow-hidden">
        <div className="brand-bg h-0.5" aria-hidden />
        <div className="p-3.5">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Pill tone="accent">Market update · {time(m.at)}</Pill>
            {n.aiGenerated && <AiTag />}
            {n.generating && <span>A fuller explanation is being written…</span>}
          </p>
          <h3 className="mt-2 text-[15px] font-semibold leading-snug">{n.content.headline}</h3>
          <p className="mt-1 text-muted">{n.content.bias_summary}</p>
          {n.content.scenarios.length > 0 && (
            <ul className="mt-3 space-y-2">
              {n.content.scenarios.map((s) => (
                <li key={`${s.setupId}-${s.kind}`} className="flex gap-2">
                  <span className="mt-0.5">
                    <Pill tone={s.kind === 'PRIMARY' ? 'accent' : undefined}>
                      {s.kind === 'PRIMARY' ? 'Main' : 'Alternate'}
                    </Pill>
                  </span>
                  <span>{s.if_then}</span>
                </li>
              ))}
            </ul>
          )}
          {n.content.risks_and_unknowns.length > 0 && (
            <p className="mt-3 text-xs text-muted">
              Unknowns: {n.content.risks_and_unknowns.join(' · ')}
            </p>
          )}
          <ScenarioSummary />
        </div>
      </article>
    );
  }
  // explain
  const c = m.content;
  return (
    <article className="rise surface-card overflow-hidden">
      <div className="brand-bg h-0.5" aria-hidden />
      <div className="p-3.5">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Pill tone="accent">Chart explained · {time(m.at)}</Pill>
          {m.mode === 'APPROXIMATE' && (
            <Pill tone="warn">Approximate: read from your picture, no live data</Pill>
          )}
          {m.done && m.ai && <AiTag />}
        </p>
        {!m.done || !c ? (
          <p className="mt-3 flex items-center gap-2 text-muted" role="status">
            <span className="flex gap-1" aria-hidden>
              <span className="typing-dot" />
              <span className="typing-dot [animation-delay:0.15s]" />
              <span className="typing-dot [animation-delay:0.3s]" />
            </span>
            {m.stage === 'reading'
              ? 'Reading the chart…'
              : m.stage === 'writing'
                ? 'Writing the explanation…'
                : 'Working out the market…'}
          </p>
        ) : (
          <div className="mt-2 space-y-2.5">
            <h3 className="text-[15px] font-semibold leading-snug">{c.headline}</h3>
            <p>{c.what_you_are_looking_at}</p>
            <p>{c.structure}</p>
            <p>{c.liquidity}</p>
            {c.key_levels.length > 0 && (
              <ul className="list-disc space-y-1 pl-5 text-muted">
                {c.key_levels.map((k) => (
                  <li key={k.ref}>{k.why}</li>
                ))}
              </ul>
            )}
            <ul className="space-y-2">
              {c.scenarios.map((s) => (
                <li key={`${s.kind}-${s.if_then.slice(0, 24)}`} className="flex gap-2">
                  <span className="mt-0.5">
                    <Pill tone={s.kind === 'PRIMARY' ? 'accent' : undefined}>
                      {s.kind === 'PRIMARY' ? 'Main' : 'Alternate'}
                    </Pill>
                  </span>
                  <span>{s.if_then}</span>
                </li>
              ))}
            </ul>
            {c.what_to_watch.length > 0 && (
              <p className="text-muted">Watch: {c.what_to_watch.join(' · ')}</p>
            )}
            {c.user_markings_note && <p className="text-muted">{c.user_markings_note}</p>}
            <p className="text-xs text-muted">{c.caveats.join(' ')}</p>
          </div>
        )}
        {m.warnings.length > 0 && (
          <p className="mt-2 text-xs text-warn-text">{m.warnings.join(' · ')}</p>
        )}
      </div>
    </article>
  );
}

function Typing() {
  return (
    <div className="rise flex gap-2" role="status" aria-label="The assistant is writing">
      <Avatar />
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-md border border-line bg-s2 px-4 py-3">
        <span className="typing-dot" />
        <span className="typing-dot [animation-delay:0.15s]" />
        <span className="typing-dot [animation-delay:0.3s]" />
      </div>
    </div>
  );
}

const WARN_TEXT: Record<string, string> = {
  NO_SPEECH: 'I could not make out any words. Type what you meant below, or try again.',
  MIC_SILENT:
    'Your microphone gave no sound. Check it is not muted and the right one is selected in your browser. You can still type below.',
  LOW_CONFIDENCE: 'I may have misheard. Check the text before sending.',
  TOO_LONG: 'Recording stopped after three minutes. Review the text below.',
  MIC_PERMISSION_DENIED: 'Microphone access is blocked. Allow it in your browser, or type instead.',
  STT_UNAVAILABLE: 'Speech recognition is not available right now. Type instead.',
};

function MicButton({
  voice,
  disabledReason,
}: {
  voice: ReturnType<typeof useVoice>;
  disabledReason: string | null;
}) {
  const recording = voice.state === 'RECORDING';
  const busy = voice.state === 'TRANSCRIBING' || voice.status === 'LOADING';
  // One click starts listening, the next click stops and shows what was heard (no holding).
  const toggle = () => {
    if (voice.status === 'OFF') void voice.enable();
    else if (voice.status === 'READY') {
      if (recording) voice.release();
      else voice.press();
    }
  };
  const reason =
    disabledReason ??
    (voice.status === 'UNAVAILABLE' ? 'Speech is unavailable on this device. Type instead.' : null);
  const btn = (
    <button
      type="button"
      aria-label={
        voice.status === 'LOADING'
          ? 'Voice is getting ready'
          : recording
            ? 'Stop listening'
            : 'Start talking'
      }
      aria-pressed={recording}
      aria-disabled={reason !== null}
      disabled={reason !== null && disabledReason !== null}
      onClick={() => reason === null && toggle()}
      className={`grid size-9 shrink-0 place-items-center rounded-full transition-colors ${recording ? 'animate-pulse bg-bear-strong text-white' : 'text-muted hover:bg-s3 hover:text-fg'} ${reason ? 'opacity-50' : ''}`}
    >
      {recording ? (
        <Square className="size-3.5 fill-current" aria-hidden />
      ) : (
        <Mic className="size-4" aria-hidden />
      )}
      {busy && <span className="sr-only">Working…</span>}
    </button>
  );
  const tip =
    reason ??
    (voice.status === 'OFF'
      ? 'Voice (runs on this device)'
      : recording
        ? 'Click to stop and review'
        : 'Click to start talking, click again to stop');
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        {disabledReason ? (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a disabled button cannot take focus, so its tooltip needs a focusable wrapper
          <span tabIndex={0}>{btn}</span>
        ) : (
          btn
        )}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={6}
          className="z-50 max-w-60 rounded-ctl border border-line bg-s1 px-2 py-1.5 text-xs shadow-pop"
        >
          {tip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** Five bars that rise and fall with the microphone's loudness while recording. */
function Level({ level }: { level: number }) {
  const v = Math.min(1, Math.sqrt(level) * 1.6);
  return (
    <span className="flex h-6 items-center gap-[3px]" aria-hidden>
      {[0.5, 0.8, 1, 0.8, 0.5].map((k, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: five fixed bars
          key={i}
          className="w-[3px] rounded-full bg-bear transition-[height] duration-75"
          style={{ height: `${Math.max(14, v * k * 100)}%` }}
        />
      ))}
    </span>
  );
}

const SUGGESTIONS = [
  'What is the daily structure?',
  'Where are the key levels near the price?',
  'Is there a trade idea right now?',
];

export function Dock() {
  const sel = useSelection();
  const live = useLive((s) => s.state);
  const messages = useChat((s) => s.messages);
  const waiting = useChat((s) => s.waiting);
  const setExplainOpen = useUi((s) => s.setExplainOpen);
  const voice = useVoice(sel.sessionId);
  const tr = useTranscript();
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const connected =
    sel.sessionId !== null && live !== 'IDLE' && live !== 'ENDED' && live !== 'TAKEN';

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message is added or the typing dots appear
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, waiting]);

  // The box grows with what is typed, up to a few lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resize on every change of the text
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [text]);

  function send() {
    const t = text.trim();
    if (!t) return;
    if (sendChat(t, 'text')) setText('');
  }

  async function sendTranscript() {
    const t = tr.transcript;
    const body = tr.text.trim();
    if (!t || !body) return;
    const { forbiddenByVoice, parseVoiceCommand } = await import('@smc/contracts');
    const stt = { confidence: t.confidence, engine: t.engine };
    // The text may have been edited, so the rules are checked again on what will actually be sent.
    const forbidden = forbiddenByVoice(body);
    if (forbidden || parseVoiceCommand(body)) {
      sendVoiceCommand(body, stt);
    } else {
      sendChat(body, 'voice', stt);
    }
    voice.done();
  }

  const forbidden = tr.transcript?.forbidden ?? null;
  const reasonOff = voice.confirmOpen
    ? 'Voice is off while the confirm dialog is open. Confirming is by tapping the Confirm button only.'
    : !connected
      ? 'Start a session to use voice.'
      : null;
  const hasAnswerPending = waiting && messages[messages.length - 1]?.kind === 'user';

  return (
    <section aria-label="Conversation" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="scroll-thin min-h-8 flex-1 space-y-3.5 overflow-auto px-4 pb-2 pt-1"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <div className="rise pt-1">
            <p className="text-muted">
              {sel.sessionId
                ? 'Ask anything about this market. For example:'
                : 'Connecting to the analysis…'}
            </p>
            {connected && (
              <ul className="mt-3 flex flex-col gap-2">
                {SUGGESTIONS.map((q) => (
                  <li key={q}>
                    <button
                      type="button"
                      onClick={() => sendChat(q, 'text')}
                      className="surface-card group flex w-full items-center justify-between gap-2 px-3.5 py-2.5 text-left text-fg transition-colors hover:border-accent/50"
                    >
                      <span>{q}</span>
                      <ArrowUp
                        className="size-3.5 shrink-0 rotate-45 text-muted transition-colors group-hover:text-accent-text"
                        aria-hidden
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} m={m} />)
        )}
        {hasAnswerPending && <Typing />}
      </div>

      <div className="px-3 pb-3">
        <div className="max-h-[45%] overflow-y-auto">
          {voice.status === 'LOADING' && voice.progress > 0 && voice.progress < 1 && (
            <p className="mb-2 text-xs text-muted" role="status">
              Getting voice ready… {Math.round(voice.progress * 100)}% (once; it stays on this
              device)
            </p>
          )}
          {voice.detail && (
            <p className="mb-2 text-xs text-muted" role="status">
              {voice.detail}
            </p>
          )}
          {(voice.state === 'RECORDING' || voice.state === 'TRANSCRIBING') && (
            <div
              role="status"
              aria-live="polite"
              className="rise mb-2 rounded-card border border-bear/40 bg-bear/8 p-3"
            >
              <div className="flex items-center gap-3">
                {voice.state === 'RECORDING' ? (
                  <Level level={tr.level} />
                ) : (
                  <span className="flex gap-1" aria-hidden>
                    <span className="typing-dot" />
                    <span className="typing-dot [animation-delay:0.15s]" />
                    <span className="typing-dot [animation-delay:0.3s]" />
                  </span>
                )}
                <p className="text-sm font-medium">
                  {voice.state === 'RECORDING'
                    ? 'Listening… click the mic when you are done'
                    : 'Working out what you said…'}
                </p>
              </div>
              <p className="mt-1.5 min-h-5 text-fg">
                {tr.partial || (voice.state === 'RECORDING' ? 'Speak now' : '')}
              </p>
              {voice.state === 'RECORDING' && tr.quiet && (
                <p className="mt-1 text-xs text-warn-text">
                  I cannot hear your microphone. Check it is not muted and the right one is
                  selected.
                </p>
              )}
            </div>
          )}
          {voice.warning && (
            <p className="mb-2 text-xs text-warn-text" role="status">
              {WARN_TEXT[voice.warning]}
            </p>
          )}

          {tr.transcript && (
            <div className="rise surface-card mb-2 p-3">
              <label htmlFor="transcript" className="text-xs font-medium text-muted">
                {tr.transcript.raw
                  ? 'Review what I heard, edit it, then send'
                  : 'Type your message'}
              </label>
              <div className="mt-1.5 flex items-start gap-2">
                <textarea
                  id="transcript"
                  value={tr.text}
                  maxLength={MAX_VOICE_TEXT}
                  rows={tr.text.length > 120 ? 3 : 2}
                  onChange={(e) => tr.set({ text: e.target.value })}
                  // biome-ignore lint/a11y/noAutofocus: the box opens right after a recording so it can be fixed at once
                  autoFocus
                  className="field min-w-0 flex-1 resize-none"
                />
                <div className="flex shrink-0 flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => void sendTranscript()}
                    disabled={!tr.text.trim() || !connected}
                    className="btn-primary px-3 py-1.5"
                  >
                    {forbidden ? 'Send for the record' : 'Send'}
                  </button>
                  <button type="button" onClick={voice.done} className="btn-ghost px-3 py-1.5">
                    Discard
                  </button>
                </div>
              </div>
              {tr.transcript.corrected && (
                <p className="mt-1.5 text-xs text-muted">Heard: “{tr.transcript.raw}”</p>
              )}
              {forbidden && (
                <p role="alert" className="mt-1.5 text-warn-text">
                  Voice cannot confirm, log, change risk, delete data or pay. Use the buttons on
                  screen.
                </p>
              )}
            </div>
          )}
        </div>

        <BudgetMeter />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="surface-card flex items-end gap-1 p-1.5 focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]"
        >
          <button
            type="button"
            onClick={() => setExplainOpen(true)}
            aria-label="Explain this chart"
            title="Explain this chart from a screenshot or your shared screen"
            className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-s3 hover:text-fg"
          >
            <ScanSearch className="size-4" aria-hidden />
          </button>
          <label className="sr-only" htmlFor="chat">
            Message
          </label>
          <textarea
            id="chat"
            ref={box}
            rows={1}
            value={text}
            maxLength={2000}
            disabled={!connected}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={connected ? 'Ask about this market…' : 'Connecting…'}
            className="max-h-32 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-2 leading-snug outline-none placeholder:text-muted disabled:opacity-60"
          />
          <MicButton voice={voice} disabledReason={reasonOff} />
          <button
            type="submit"
            disabled={!connected || !text.trim()}
            aria-label="Send"
            className="btn-primary grid size-9 shrink-0 place-items-center rounded-full"
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </form>
        <p className="mt-1.5 text-center text-[11px] text-muted">
          Enter to send · Shift+Enter for a new line
        </p>
      </div>
      <ExplainDialog />
    </section>
  );
}
