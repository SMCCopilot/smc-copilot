'use client';
import type { MeResponse } from '@smc/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { signOut } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { nextStep } from '../lib/gate';
import { DisclaimerText } from './disclaimer';

const STEPS = [
  ['DISCLAIMER', 'Disclaimer'],
  ['AGE', 'Age'],
] as const;

export function Onboarding({ me }: { me: MeResponse }) {
  const qc = useQueryClient();
  const step = nextStep(me);
  const [agree, setAgree] = useState(false);
  const [adult, setAdult] = useState(false);

  const run = useMutation({
    mutationFn: async () => {
      if (step === 'DISCLAIMER') {
        await api('/v1/me/disclaimer', {
          method: 'POST',
          body: { version: me.disclaimer.currentVersion },
        });
      } else if (step === 'AGE') {
        await api('/v1/me/age-confirmation', { method: 'POST', body: { confirmed: true } });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  const ready = (step === 'DISCLAIMER' && agree) || (step === 'AGE' && adult);
  const err =
    run.error instanceof ApiError
      ? run.error.message
      : run.error
        ? 'Something went wrong. Try again.'
        : null;

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <form
        className="surface-card w-full max-w-lg p-7 shadow-pop"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) run.mutate();
        }}
      >
        <h1 className="text-xl font-semibold">Before you start</h1>
        <p className="mt-1 text-muted">Two quick things, then you are in.</p>
        <ol className="mt-3 flex gap-2 text-xs" aria-label="Steps">
          {STEPS.map(([k, label]) => {
            const order = ['DISCLAIMER', 'AGE'];
            const done = order.indexOf(k) < order.indexOf(step);
            return (
              <li
                key={k}
                aria-current={k === step ? 'step' : undefined}
                className={`flex items-center gap-1 rounded-full border px-3 py-1 font-medium ${k === step ? 'brand-soft border-accent/40 text-accent-text' : 'border-line text-muted'}`}
              >
                {done && <Check className="size-3" aria-hidden />} {label}
              </li>
            );
          })}
        </ol>

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
            className="btn-primary px-5 py-2"
          >
            {run.isPending ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </form>
    </main>
  );
}
