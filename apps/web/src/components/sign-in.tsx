'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AUTH_CONFIGURED } from '@/lib/env';
import { getSupabase } from '@/lib/supabase';
import { type DetectedWallet, detectSolana, discoverEvm, explainWalletError } from '@/lib/wallets';

export function SignIn() {
  const [wallets, setWallets] = useState<DetectedWallet[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const seen = new Map<string, DetectedWallet>();
    const publish = () => setWallets([...seen.values()]);
    const stop = discoverEvm((w) => {
      seen.set(w.id, w);
      publish();
    });
    // Solana wallets inject slightly after load; check again shortly.
    const scan = () => {
      for (const w of detectSolana()) seen.set(w.id, w);
      publish();
    };
    scan();
    const t = setTimeout(scan, 800);
    return () => {
      stop();
      clearTimeout(t);
    };
  }, []);

  async function connect(w: DetectedWallet) {
    setError(null);
    setBusy(w.id);
    try {
      const sb = await getSupabase();
      const { error: e } = await sb.auth.signInWithWeb3({
        chain: w.chain,
        statement: 'Sign in to SMC Copilot',
        wallet: w.provider,
      } as Parameters<SupabaseClient['auth']['signInWithWeb3']>[0]);
      if (e) throw e;
    } catch (e) {
      setError(explainWalletError(e instanceof Error ? e.message : String(e), location.origin));
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-s1 p-6">
        <div className="mb-4 flex items-center gap-2 font-semibold">
          <span
            className="grid size-8 place-items-center rounded-ctl bg-accent text-white"
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
        {!AUTH_CONFIGURED && (
          <p role="alert" className="mt-4 rounded-ctl border border-line bg-s2 p-3 text-warn">
            Sign-in is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY in .env.local and
            restart.
          </p>
        )}
        <ul className="mt-4 flex flex-col gap-2">
          {wallets.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                disabled={busy !== null || !AUTH_CONFIGURED}
                onClick={() => connect(w)}
                className="flex w-full items-center gap-3 rounded-ctl border border-line bg-s2 px-3 py-2.5 text-left hover:bg-s3 disabled:opacity-60"
              >
                {w.icon ? (
                  // biome-ignore lint/performance/noImgElement: wallet-supplied data URI icon
                  <img src={w.icon} alt="" className="size-6 rounded" />
                ) : (
                  <Wallet className="size-6" aria-hidden />
                )}
                <span className="flex-1">{w.name}</span>
                <span className="text-xs text-muted">
                  {busy === w.id
                    ? 'Check your wallet…'
                    : w.chain === 'solana'
                      ? 'Solana'
                      : 'Ethereum'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {wallets.length === 0 && (
          <p className="mt-4 rounded-ctl border border-line bg-s2 p-3 text-muted">
            No wallet found in this browser. Install a wallet extension (for example MetaMask or
            Phantom), then reload this page.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-warn">
            {error}
          </p>
        )}
        <p className="mt-6 text-xs text-muted">
          Educational analysis, not financial advice. You make every decision.
        </p>
      </div>
    </main>
  );
}
