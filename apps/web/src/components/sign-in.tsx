'use client';
import { LineChart, ShieldCheck, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AUTH_CONFIGURED } from '../lib/env';
import { WalletList } from './wallet-list';

const POINTS = [
  {
    icon: LineChart,
    title: 'A real chart, with the analysis on it',
    text: 'Zones, levels and market structure drawn on live candles, explained in plain words.',
  },
  {
    icon: Sparkles,
    title: 'An assistant that never makes up prices',
    text: 'Ask by typing or by voice. Answers come only from the analysis’ own facts.',
  },
  {
    icon: ShieldCheck,
    title: 'You stay in control',
    text: 'It never trades for you. Your voice and screen are processed on your device and never stored.',
  },
];

export function SignIn() {
  // Set by Settings when the user asked for deletion: shown once after the forced sign-out.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    try {
      setNotice(sessionStorage.getItem('smc-notice'));
      sessionStorage.removeItem('smc-notice');
    } catch {}
  }, []);
  return (
    <main className="relative grid min-h-dvh overflow-hidden lg:grid-cols-[1.1fr_1fr]">
      <div
        className="pointer-events-none absolute -left-40 -top-40 size-[34rem] rounded-full bg-accent/20 blur-3xl"
        aria-hidden
      />
      <section className="relative hidden flex-col justify-between p-12 lg:flex">
        <div className="flex items-center gap-3 font-semibold">
          <span
            className="brand-bg grid size-10 place-items-center rounded-xl text-lg font-bold text-white shadow-[0_10px_26px_-8px_rgb(79_91_255/0.9)]"
            aria-hidden
          >
            S
          </span>
          <span className="text-lg">SMC Copilot</span>
        </div>
        <div className="max-w-md">
          <h2 className="text-4xl font-semibold leading-[1.1] tracking-tight">
            Read the market <span className="brand-text">like a professional.</span>
          </h2>
          <p className="mt-4 text-[15px] text-muted">
            Smart Money Concepts analysis for crypto, explained clearly, on a chart you can work on.
          </p>
          <ul className="mt-8 space-y-5">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3.5">
                <span className="brand-soft grid size-10 shrink-0 place-items-center rounded-xl text-accent-text">
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="block text-muted">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-muted">
          Educational analysis, not financial advice. You make every decision.
        </p>
      </section>
      <section className="relative grid place-items-center p-4">
        <div className="surface-card w-full max-w-sm p-7 shadow-pop">
          <div className="mb-5 flex items-center gap-2.5 font-semibold lg:hidden">
            <span
              className="brand-bg grid size-8 place-items-center rounded-xl text-white"
              aria-hidden
            >
              S
            </span>
            SMC Copilot
          </div>
          <h1 className="text-xl font-semibold">Sign in with your wallet</h1>
          <p className="mt-1.5 text-muted">
            No email or password. You sign a message to prove you own the wallet. It costs nothing
            and cannot move funds.
          </p>
          {notice && (
            <p role="status" className="mt-4 rounded-ctl border border-line bg-s2 p-3">
              {notice}
            </p>
          )}
          {!AUTH_CONFIGURED && (
            <p
              role="alert"
              className="mt-4 rounded-ctl border border-warn/40 bg-warn/10 p-3 text-warn-text"
            >
              Sign-in is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.local and
              restart.
            </p>
          )}
          <WalletList />
          <p className="mt-6 text-xs text-muted lg:hidden">
            Educational analysis, not financial advice. You make every decision.
          </p>
        </div>
      </section>
    </main>
  );
}
