'use client';
import { useEffect, useState } from 'react';
import { AUTH_CONFIGURED } from '../lib/env';
import { WalletList } from './wallet-list';

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
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-s1 p-6">
        <div className="mb-4 flex items-center gap-2 font-semibold">
          <span
            className="grid size-8 place-items-center rounded-ctl bg-accent-strong text-white"
            aria-hidden
          >
            S
          </span>
          SMC Copilot
        </div>
        <h1 className="text-lg font-semibold">Sign in with your wallet</h1>
        <p className="mt-1 text-muted">
          No email or password. You sign a message to prove you own the wallet. It costs nothing and
          cannot move funds.
        </p>
        {notice && (
          <p role="status" className="mt-4 rounded-ctl border border-line bg-s2 p-3">
            {notice}
          </p>
        )}
        {!AUTH_CONFIGURED && (
          <p role="alert" className="mt-4 rounded-ctl border border-line bg-s2 p-3 text-warn-text">
            Sign-in is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.local and
            restart.
          </p>
        )}
        <WalletList />
        <p className="mt-6 text-xs text-muted">
          Educational analysis, not financial advice. You make every decision.
        </p>
      </div>
    </main>
  );
}
