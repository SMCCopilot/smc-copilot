import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WsTokenClaims {
  /** Session id. */
  sid: string;
  /** User id. */
  uid: string;
  /** Expiry, epoch seconds. */
  exp: number;
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
export const WS_TOKEN_TTL_SEC = 300;

/**
 * Short-lived socket credential (A02 section 4): `v1.<claims>.<hmac>`, bound to one session and one user and valid for
 * five minutes. It authorises opening the socket only; it is not a login token and cannot call any REST route.
 */
export function signWsToken(
  secret: string,
  claims: Omit<WsTokenClaims, 'exp'>,
  nowSec: number,
): { token: string; exp: number } {
  const exp = nowSec + WS_TOKEN_TTL_SEC;
  const payload = b64(JSON.stringify({ sid: claims.sid, uid: claims.uid, exp }));
  const mac = createHmac('sha256', secret).update(`v1.${payload}`).digest();
  return { token: `v1.${payload}.${b64(mac)}`, exp };
}

/** Returns the claims, or null for anything malformed, forged or expired. Constant-time signature comparison. */
export function verifyWsToken(secret: string, token: string, nowSec: number): WsTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const [, payload, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`v1.${payload}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const c = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<WsTokenClaims>;
    if (typeof c.sid !== 'string' || typeof c.uid !== 'string' || typeof c.exp !== 'number')
      return null;
    if (c.exp <= nowSec) return null;
    return { sid: c.sid, uid: c.uid, exp: c.exp };
  } catch {
    return null;
  }
}
