'use client';
import type { MeResponse } from '@smc/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { api } from '../lib/api';
import { signOut } from '../lib/auth';
import { TURNSTILE_SITE_KEY } from '../lib/env';
import { ApiError } from '../lib/errors';
import { nextStep } from '../lib/gate';
import { DisclaimerText } from './disclaimer';
import { Turnstile, type TurnstileHandle } from './turnstile';

const STEPS = [
  ['INVITE', 'Invite code'],
  ['DISCLAIMER', 'Disclaimer'],
  ['AGE', 'Age'],
] as const;

export function Onboarding({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const step = nextStep(me);
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [adult, setAdult] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const bot = useRef<TurnstileHandle>(null);
  const onToken = useCallback((t: string | null) => setToken(t), []);

  const run = useMutation({
    mutationFn: async () => {
      if (step === 'INVITE') {
        await api('/v1/me/invite', {
          method: 'POST',
          body: { code: code.trim() },
          headers: token ? { 'x-turnstile-token': token } : {},
        });
      } else if (step === 'DISCLAIMER') {
        await api('/v1/me/disclaimer', {
          method: 'POST',
          body: { version: me.disclaimer.currentVersion },
        });
      } else if (step === 'AGE') {
        await api('/v1/me/age-confirmation', { method: 'POST', body: { confirmed: true } });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
    onError: () => bot.current?.reset(),
  });

  const needsBot = step === 'INVITE' && TURNSTILE_SITE_KEY !== '';
  const ready =
    (step === 'INVITE' && code.trim().length >= 3 && (!needsBot || token !== null)) ||
    (step === 'DISCLAIMER' && agree) ||
    (step === 'AGE' && adult);
  const err =
    run.error instanceof ApiError
      ? run.error.message
      : run.error
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <form
        className="w-full max-w-lg rounded-card border border-line bg-s1 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) run.mutate();
        }}
      >
        <h1 className="text-lg font-semibold">Before you start</h1>
        <ol className="mt-3 flex gap-2 text-xs" aria-label="Steps">
          {STEPS.filter(([k]) => k !== 'INVITE' || me.invite.required).map(([k, label]) => {
            const order = ['INVITE', 'DISCLAIMER', 'AGE'];
            const done = order.indexOf(k) < order.indexOf(step);
            return (
              <li
                key={k}
                aria-current={k === step ? 'step' : undefined}
                className={`flex items-center gap-1 rounded-full border border-line px-2.5 py-1 ${k === step ? 'accent-soft text-accent-text' : 'text-muted'}`}
              >
                {done && <Check className="size-3" aria-hidden />} {label}
              </li>
            );
          })}
        </ol>

        {step === 'INVITE' && (
          <div className="mt-4">
            <label htmlFor="invite" className="block font-medium">
              Invite code
            </label>
            <input
              id="invite"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="mt-1 w-full rounded-ctl border border-line bg-s3 px-3 py-2"
            />
            <div className="mt-3">
              <Turnstile ref={bot} onToken={onToken} />
            </div>
          </div>
        )}
        {step === 'DISCLAIMER' && (
          <div className="mt-4">
            <DisclaimerText />
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={agree}
                onChange={(e) => setAgree(e.target.checked)}
                className="mt-1"
              />
              <span>
                I have read and accept this disclaimer (version {me.disclaimer.currentVersion}).
              </span>
            </label>
          </div>
        )}
        {step === 'AGE' && (
          <label className="mt-4 flex items-start gap-2">
            <input
              type="checkbox"
              checked={adult}
              onChange={(e) => setAdult(e.target.checked)}
              className="mt-1"
            />
            <span>I confirm that I am 18 years old or older.</span>
          </label>
        )}

        {err && (
          <p role="alert" className="mt-3 text-warn-text">
            {err}
          </p>
        )}
        <div className="mt-5 flex items-center justify-between">
          <button type="button" onClick={() => signOut()} className="text-muted underline">
            Sign out
          </button>
          <button
            type="submit"
            disabled={!ready || run.isPending}
            className="rounded-ctl bg-accent-strong px-4 py-2 font-medium text-white disabled:opacity-50"
          >
            {run.isPending ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </form>
    </main>
  );
}
