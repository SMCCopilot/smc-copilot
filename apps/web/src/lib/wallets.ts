export type Chain = 'ethereum' | 'solana';

export interface DetectedWallet {
  id: string;
  name: string;
  chain: Chain;
  icon?: string;
  /** The provider object `signInWithWeb3` signs with. */
  provider: unknown;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string };
  provider: unknown;
}
interface InjectedWindow {
  solana?: { isPhantom?: boolean };
  phantom?: { solana?: unknown };
  solflare?: { isSolflare?: boolean };
}

/** EVM wallets announce themselves (EIP-6963), so several installed wallets are all listed. */
export function discoverEvm(onFound: (w: DetectedWallet) => void): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent<Eip6963Detail>).detail;
    if (d?.info) {
      onFound({
        id: `evm:${d.info.uuid}`,
        name: d.info.name,
        chain: 'ethereum',
        icon: d.info.icon,
        provider: d.provider,
      });
    }
  };
  window.addEventListener('eip6963:announceProvider', handler);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => window.removeEventListener('eip6963:announceProvider', handler);
}

export function detectSolana(): DetectedWallet[] {
  const w = window as unknown as InjectedWindow;
  const out: DetectedWallet[] = [];
  const phantom = w.phantom?.solana ?? (w.solana?.isPhantom ? w.solana : undefined);
  if (phantom) out.push({ id: 'sol:phantom', name: 'Phantom', chain: 'solana', provider: phantom });
  if (w.solflare?.isSolflare) {
    out.push({ id: 'sol:solflare', name: 'Solflare', chain: 'solana', provider: w.solflare });
  }
  return out;
}

/** Plain-language explanation of the failures people actually hit. */
export function explainWalletError(message: string, origin: string): string {
  if (/reject|denied|cancel/i.test(message)) {
    return 'You cancelled the wallet request. Try again when you are ready.';
  }
  if (/domain/i.test(message)) {
    return `Supabase does not accept this address yet. Add ${origin} to Authentication > URL Configuration > Redirect URLs, then reload.`;
  }
  if (/provider|disabled|not enabled|unsupported/i.test(message)) {
    return 'Wallet sign-in is not switched on. Enable Web3 Wallet (Ethereum and/or Solana) in Supabase Authentication > Sign In / Providers.';
  }
  return `Wallet sign-in failed: ${message}`;
}
