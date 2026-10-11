import { keccak_256 } from '@noble/hashes/sha3.js';
import type { WalletChain } from '@smc/contracts';

export interface Wallet {
  chain: WalletChain;
  /** evm: lowercase 0x + 40 hex; solana: base58 as-is. This is what `wallet_identities.address_norm` stores. */
  norm: string;
  /** evm: EIP-55 checksum form; solana: as-is. */
  display: string;
}

const EVM = /^0x[0-9a-f]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** EIP-55 mixed-case checksum of a lowercase 0x address. */
export function toChecksum(lower: string): string {
  const hex = lower.slice(2);
  const hash = keccak_256(new TextEncoder().encode(hex));
  let out = '0x';
  for (let i = 0; i < hex.length; i++) {
    const nibble = ((hash[i >> 1] as number) >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    const c = hex[i] as string;
    out += nibble >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** Normalises an address for a chain; null when it is not a valid address for that chain. */
export function normalizeWallet(chain: WalletChain, address: string): Wallet | null {
  if (chain === 'evm') {
    const lower = address.trim().toLowerCase();
    return EVM.test(lower) ? { chain, norm: lower, display: toChecksum(lower) } : null;
  }
  const a = address.trim();
  return SOLANA.test(a) ? { chain, norm: a, display: a } : null;
}

const CHAIN_NAMES: Record<string, WalletChain> = {
  ethereum: 'evm',
  evm: 'evm',
  eip155: 'evm',
  solana: 'solana',
};

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * Reads a wallet out of a Supabase Auth identity row. Supabase's Web3 sign-in stores the signing wallet in the
 * identity data; the exact field names have varied (`address`, `custom_claims.address`, or only a
 * `web3:<chain>:<address>` subject), so each shape is tried. UNVERIFIED against a real wallet sign-in until the
 * owner signs in once: if nothing parses, the wallet is simply not mirrored and the user is told to link again.
 */
export function walletFromIdentity(provider: string, data: unknown): Wallet | null {
  if (provider !== 'web3' && provider !== 'ethereum' && provider !== 'solana') return null;
  const d = obj(data);
  const claims = obj(d.custom_claims);
  let chainName = str(claims.chain) ?? str(d.chain);
  let address = str(claims.address) ?? str(d.address);
  const sub = str(d.sub) ?? str(d.provider_id);
  if ((!chainName || !address) && sub?.startsWith('web3:')) {
    const [, chain, ...rest] = sub.split(':');
    chainName ??= chain;
    address ??= rest.join(':');
  }
  if (!chainName && (provider === 'ethereum' || provider === 'solana')) chainName = provider;
  const chain = chainName ? CHAIN_NAMES[chainName.toLowerCase()] : undefined;
  if (!chain || !address) return null;
  return normalizeWallet(chain, address);
}
