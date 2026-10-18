'use client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Mic, ScanSearch, SendHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type Msg, useChat } from '../lib/chat';
import { useLive } from '../lib/live';
import { useAnalysis } from '../lib/market';
import { sendChat, sendVoiceCommand } from '../lib/send';
import { useSelection } from '../lib/sessions';
import { pickSetup, useUi } from '../lib/ui';
import { useTranscript, useVoice } from '../lib/voice';
import { directionLabel } from '../lib/wording';
import { GradeChip } from './canvas-tabs';
import { ExplainDialog } from './explain-dialog';

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const AiTag = () => (
  <span
    className="ml-2 rounded-full border border-line px-1.5 py-0.5 text-[11px] text-muted"
    title="Written by an AI model from the engine's facts"
  >
    AI-written
  </span>
);

function ScenarioSummary() {
  const sel = useSelection();
  const ui = useUi();
  const a = useAnalysis(sel.instrumentId, sel.tf).data;
  const s = pickSetup(a, ui.setupId, ui.dismissed);
  if (!s) return null;
  const rr = s.plan?.targets[0]?.rr;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-ctl border border-line bg-s3 px-3 py-2">
      <span className="font-medium">{directionLabel(s.direction)}</span>
      <span className="text-muted">{s.template}</span>
      <GradeChip grade={s.grade} />
      {rr !== undefined && <span className="num text-muted">{rr.toFixed(2)}R to TP1</span>}
      <button
        type="button"
        onClick={() => {
          ui.setTab('Plan');
          ui.setDrawer(true);
        }}
        className="ml-auto rounded-ctl border border-line px-2 py-1 hover:bg-s2"
      >
        Open plan
      </button>
    </div>
  );
}

function Bubble({ m }: { m: Msg }) {
  if (m.kind === 'system') {
    return <p className="mx-auto max-w-[90%] text-center text-xs text-muted">{m.text}</p>;
  }
  if (m.kind === 'user') {
    return (
      <div className="ml-auto max-w-[85%]">
        <p className="rounded-card accent-soft px-3 py-2">{m.text}</p>
        <p className="mt-0.5 text-right text-[11px] text-muted">
          You{m.via === 'voice' ? ' (voice)' : ''} · {time(m.at)}
        </p>
      </div>
    );
  }
  if (m.kind === 'assistant') {
    return (
      <div className="max-w-[90%]">
        <p className="whitespace-pre-wrap rounded-card border border-line bg-s2 px-3 py-2">
          {m.text}
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          Copilot · {time(m.at)}
          {m.done && m.ai && <AiTag />}
        </p>
      </div>
    );
  }
  if (m.kind === 'narrative') {
    const n = m.n;
    return (
      <article className="rounded-card border border-line bg-s2 p-3">
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="rounded-full accent-soft px-2 py-0.5 text-accent-text">
            Scenario updated · {time(m.at)}
          </span>
          {n.aiGenerated && <AiTag />}
          {n.generating && <span>A fuller explanation is being written…</span>}
        </p>
        <h3 className="mt-2 font-semibold">{n.content.headline}</h3>
        <p className="mt-1">{n.content.bias_summary}</p>
        {n.content.scenarios.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-muted">
            {n.content.scenarios.map((s) => (
              <li key={`${s.setupId}-${s.kind}`}>
                <span className="text-fg">{s.kind === 'PRIMARY' ? 'Primary' : 'Alternate'}:</span>{' '}
                {s.if_then}
              </li>
            ))}
          </ul>
        )}
        {n.content.risks_and_unknowns.length > 0 && (
          <p className="mt-2 text-xs text-muted">
            Unknowns: {n.content.risks_and_unknowns.join(' · ')}
          </p>
        )}
        <ScenarioSummary />
      </article>
    );
  }
  // explain
  const c = m.content;
  return (
    <article className="rounded-card border border-line bg-s2 p-3">
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="rounded-full accent-soft px-2 py-0.5 text-accent-text">
          Chart explained · {time(m.at)}
        </span>
        {m.mode === 'APPROXIMATE' && (
          <span className="text-warn-text">Approximate: read from your picture, no live data</span>
        )}
        {m.done && m.ai && <AiTag />}
      </p>
      {!m.done || !c ? (
        <p className="mt-2 text-muted" role="status">
          {m.stage === 'reading'
            ? 'Reading the chart…'
            : m.stage === 'writing'
              ? 'Writing the explanation…'
              : 'Working out the market…'}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <h3 className="font-semibold">{c.headline}</h3>
          <p>{c.what_you_are_looking_at}</p>
          <p>{c.structure}</p>
          <p>{c.liquidity}</p>
          {c.key_levels.length > 0 && (
            <ul className="list-inside list-disc text-muted">
              {c.key_levels.map((k) => (
                <li key={k.ref}>{k.why}</li>
              ))}
            </ul>
          )}
          <ul className="list-inside list-disc">
            {c.scenarios.map((s) => (
              <li key={`${s.kind}-${s.if_then.slice(0, 24)}`}>
                <span className="text-muted">
                  {s.kind === 'PRIMARY' ? 'Primary' : 'Alternate'}:
                </span>{' '}
                {s.if_then}
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
    </article>
  );
}

const WARN_TEXT: Record<string, string> = {
  NO_SPEECH: 'I could not make out any words. Speak a little closer, then try again.',
  MIC_SILENT:
    'Your microphone gave no sound. Check it is not muted and the right one is selected in your browser, then try again.',
  LOW_CONFIDENCE: 'I may have misheard. Check the text before sending.',
  TOO_LONG: 'That was too long, so recording stopped.',
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
      className={`grid size-10 shrink-0 place-items-center rounded-ctl border border-line ${recording ? 'animate-pulse bg-bear-strong text-white' : 'bg-s2 hover:bg-s3'} ${reason ? 'opacity-50' : ''}`}
    >
      <Mic className="size-4" aria-hidden />
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
          className="z-50 max-w-60 rounded-ctl border border-line bg-s1 px-2 py-1.5 text-xs"
        >
          {tip}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Dock() {
  const sel = useSelection();
  const live = useLive((s) => s.state);
  const messages = useChat((s) => s.messages);
  const setExplainOpen = useUi((s) => s.setExplainOpen);
  const voice = useVoice(sel.sessionId);
  const tr = useTranscript();
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const connected =
    sel.sessionId !== null && live !== 'IDLE' && live !== 'ENDED' && live !== 'TAKEN';

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message is added
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
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

  return (
    <section aria-label="Conversation" className="flex min-h-0 flex-[3] flex-col p-3">
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-3 overflow-auto pr-1"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="text-muted">
            {sel.sessionId
              ? 'Waiting for the first analysis. Scenario updates and your conversation appear here.'
              : 'Start a session to see scenario updates and chat.'}
          </p>
        ) : (
          messages.map((m) => <Bubble key={m.id} m={m} />)
        )}
      </div>

      {voice.status === 'LOADING' && voice.progress > 0 && voice.progress < 1 && (
        <p className="mt-2 text-xs text-muted" role="status">
          Getting voice ready… {Math.round(voice.progress * 100)}% (once; it stays on this device)
        </p>
      )}
      {voice.detail && (
        <p className="mt-2 text-xs text-muted" role="status">
          {voice.detail}
        </p>
      )}
      {(voice.state === 'RECORDING' || voice.state === 'TRANSCRIBING') && (
        <div
          role="status"
          aria-live="polite"
          className="mt-2 rounded-card border border-bear-text bg-s2 p-3"
        >
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="size-2.5 animate-pulse rounded-full bg-bear" aria-hidden />
            {voice.state === 'RECORDING'
              ? 'Listening… click the mic when you are done'
              : 'Working out what you said…'}
          </p>
          <p className="mt-1 min-h-5 text-fg">
            {tr.partial || (voice.state === 'RECORDING' ? 'Speak now' : '')}
          </p>
          {voice.state === 'RECORDING' && (
            <>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-s3" aria-hidden>
                <div
                  className="h-full rounded-full bg-bull transition-[width] duration-75"
                  style={{ width: `${Math.min(100, Math.round(Math.sqrt(tr.level) * 140))}%` }}
                />
              </div>
              {tr.quiet && (
                <p className="mt-1 text-xs text-warn-text">
                  I cannot hear your microphone. Check it is not muted and the right one is
                  selected.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {voice.warning && (
        <p className="mt-2 text-xs text-warn-text" role="status">
          {WARN_TEXT[voice.warning]}
        </p>
      )}

      {tr.transcript && (
        <div className="mt-2 rounded-card border border-line bg-s2 p-3">
          <label htmlFor="transcript" className="text-xs text-muted">
            Review what I heard, edit it, then send
          </label>
          <textarea
            id="transcript"
            value={tr.text}
            maxLength={500}
            rows={2}
            onChange={(e) => tr.set({ text: e.target.value })}
            className="mt-1 w-full resize-none rounded-ctl border border-line bg-s3 px-2 py-1.5"
          />
          {tr.transcript.corrected && (
            <p className="mt-1 text-xs text-muted">Heard: “{tr.transcript.raw}”</p>
          )}
          {forbidden && (
            <p role="alert" className="mt-1 text-warn-text">
              Voice cannot confirm, log, change risk, delete data or pay. Use the buttons on screen.
            </p>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={voice.done}
              className="rounded-ctl border border-line px-3 py-1.5"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={() => void sendTranscript()}
              disabled={!tr.text.trim() || !connected}
              className="rounded-ctl bg-accent-strong px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {forbidden ? 'Send for the record' : 'Send'}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={submit} className="mt-2 flex items-center gap-2">
        <label className="sr-only" htmlFor="chat">
          Message
        </label>
        <input
          id="chat"
          value={text}
          maxLength={2000}
          disabled={!connected}
          onChange={(e) => setText(e.target.value)}
          placeholder={connected ? 'Ask about the current scenario' : 'Start a session to chat'}
          className="min-w-0 flex-1 rounded-ctl border border-line bg-s3 px-3 py-2 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => setExplainOpen(true)}
          aria-label="Explain this chart"
          title="Explain this chart"
          className="grid size-10 shrink-0 place-items-center rounded-ctl border border-line bg-s2 hover:bg-s3"
        >
          <ScanSearch className="size-4" aria-hidden />
        </button>
        <MicButton voice={voice} disabledReason={reasonOff} />
        <button
          type="submit"
          disabled={!connected || !text.trim()}
          aria-label="Send"
          className="grid size-10 shrink-0 place-items-center rounded-ctl bg-accent-strong text-white disabled:opacity-50"
        >
          <SendHorizontal className="size-4" aria-hidden />
        </button>
      </form>
      <ExplainDialog />
    </section>
  );
}
