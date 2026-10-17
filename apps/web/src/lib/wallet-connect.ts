'use client';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useEffect, useState } from 'react';
import { getSupabase } from './supabase';
import { type DetectedWallet, detectSolana, discoverEvm, explainWalletError } from './wallets';

/** Detects installed wallets and signs in (or signs again, for step-up) with the one the user picks. */
export function useWalletConnect(onDone?: () => void) {
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
      onDone?.();
    } catch (e) {
      setError(explainWalletError(e instanceof Error ? e.message : String(e), location.origin));
    } finally {
      setBusy(null);
    }
  }

  return { wallets, busy, error, connect };
}
