'use client';
import { Wallet } from 'lucide-react';
import { AUTH_CONFIGURED } from '../lib/env';
import { useWalletConnect } from '../lib/wallet-connect';

export function WalletList({ onDone }: { onDone?: () => void }) {
  const { wallets, busy, error, connect } = useWalletConnect(onDone);
  return (
    <>
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
        <p role="alert" className="mt-4 text-warn-text">
          {error}
        </p>
      )}
    </>
  );
}
