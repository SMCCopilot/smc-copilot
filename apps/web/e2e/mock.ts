import type { Page, Route } from '@playwright/test';

export const INST_FULL = '11111111-1111-4111-8111-111111111111';
export const INST_RAW_OFF = '22222222-2222-4222-8222-222222222222';
export const SESSION_ID = '33333333-3333-4333-8333-333333333333';
export const PLAN_ID = '44444444-4444-4444-8444-444444444444';
export const SETUP_ID = '55555555-5555-4555-8555-555555555555';
const uuid = (n: number) => `66666666-6666-4666-8666-${String(n).padStart(12, '0')}`;

const instruments = [
  {
    id: INST_FULL,
    canonical: 'BINANCE:PERP:BTCUSDT',
    venue: 'BINANCE',
    marketType: 'PERP',
    display: 'BTCUSDT perp',
    pricePrecision: 2,
    tickSize: 0.1,
    licenseClass: 'DISPLAY_OK',
    rawDataAllowed: true,
  },
  {
    id: INST_RAW_OFF,
    canonical: 'BYBIT:PERP:ETHUSDT',
    venue: 'BYBIT',
    marketType: 'PERP',
    display: 'ETHUSDT perp',
    pricePrecision: 2,
    tickSize: 0.01,
    licenseClass: 'INTERNAL_ONLY',
    rawDataAllowed: false,
  },
];

export const plan = {
  planId: PLAN_ID,
  planVersion: 1,
  planHash: 'hash-abc12345',
  direction: 'LONG',
  entry: { top: 64100, bottom: 64050, refPrice: 64075, basis: 'OB_50' },
  stop: { price: 63945, basis: 'ATR_BUFFER' },
  targets: [{ id: 'T1', price: 64450, levelId: 'L9', rr: 2.88, label: 'TP1' }],
  invalidation: { level: 63945, rule: 'CLOSE_BELOW' },
  scenarios: {
    primary: {
      kind: 'CONTINUATION',
      condition: { type: 'CLOSE_ABOVE', level: 64200, levelId: 'L7' },
      next: { levelId: 'L9', price: 64450 },
    },
    alternate: {
      kind: 'POI_FAILS',
      condition: { type: 'CLOSE_BELOW', level: 63945, levelId: 'L5' },
      next: null,
    },
  },
  assumptions: { spread: 0.1, slippage: 0.2, feeBps: 5 },
  risk: null,
  warnings: [],
  disclaimers: [],
};

const setup = {
  id: SETUP_ID,
  template: 'T1',
  direction: 'LONG',
  instrumentId: INST_FULL,
  canonical: 'BINANCE:PERP:BTCUSDT',
  entryTf: '15m',
  biasTf: '4h',
  state: 'ARMED',
  grade: 'A',
  score: 78.7,
  reasonCodes: [],
  components: [{ kind: 'OB', id: 'Z1', label: 'Bullish order block 15m' }],
  plan,
  historical: null,
  historicalReason: 'INSUFFICIENT_HISTORY',
  confidence: 'LOW',
  createdAt: '2026-10-01T08:00:00Z',
  updatedAt: '2026-10-01T08:15:00Z',
};

export const analysis = (instrumentId: string, withSetup: boolean) => ({
  snapshotId: 'snap-1',
  asOf: '2026-10-01T08:15:00Z',
  instrumentId,
  strategyVersionId: 'v1',
  dataQuality: 'OK',
  warnings: [],
  htfBias: { tf: '4h', trend: 'BULL', lastBreak: null },
  structure: {
    tf: '15m',
    trend: 'BULL',
    internalTrend: 'BULL',
    swings: [],
    breaks: [],
    range: { low: 63500, high: 65000, eq: 64250, oteBottom: 63900, oteTop: 64000, trend: 'BULL' },
  },
  zones: [{ id: 'Z1', label: 'Bullish order block 15m', top: 64100, bottom: 64050, state: 'OPEN' }],
  liquidity: [{ id: 'L9', label: 'Equal highs 15m', kind: 'EQH', price: 64450 }],
  setups: withSetup ? [setup] : [],
});

export const me = (over: Record<string, unknown> = {}) => ({
  user: {
    id: uuid(1),
    displayName: null,
    locale: 'en',
    timezone: 'UTC',
    createdAt: '2026-10-01T00:00:00Z',
  },
  wallets: [
    {
      id: uuid(2),
      chain: 'evm',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      primary: true,
      linkedAt: '2026-10-01T00:00:00Z',
    },
  ],
  email: null,
  workspace: { id: uuid(3), plan: 'free' },
  entitlements: { limits: {}, features: {} },
  invite: { required: true, redeemed: true },
  disclaimer: { required: true, currentVersion: 'v1', acceptedVersion: 'v1' },
  ageConfirmed: true,
  ...over,
});

export interface Calls {
  paths: string[];
  headers: Record<string, Record<string, string>>;
  bodies: Record<string, unknown>;
}

export interface MockOptions {
  me?: () => Record<string, unknown>;
  withSetup?: boolean;
  gateExpiresInMs?: number;
  confirmStatus?: number;
  onRoute?: (
    path: string,
    method: string,
    body: unknown,
  ) => { status: number; json?: unknown } | undefined;
}

/** A signed-in browser: a stored Supabase session plus a fake API that answers like the real one. */
export async function signIn(page: Page): Promise<void> {
  const exp = Math.floor(Date.now() / 1000) + 3600 * 24;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: uuid(1), aud: 'authenticated', exp })}.sig`;
  const session = {
    access_token: token,
    refresh_token: 'r',
    expires_at: exp,
    expires_in: 86400,
    token_type: 'bearer',
    user: {
      id: uuid(1),
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-10-01T00:00:00Z',
    },
  };
  await page.addInitScript((s) => {
    localStorage.setItem('sb-supabase-auth-token', JSON.stringify(s));
  }, session);
}

export async function mockApi(page: Page, o: MockOptions = {}): Promise<Calls> {
  const calls: Calls = { paths: [], headers: {}, bodies: {} };
  await page.route('http://api.test/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    calls.paths.push(`${method} ${path}`);
    calls.headers[`${method} ${path}`] = req.headers();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.bodies[`${method} ${path}`] = body;
    const cors = {
      'access-control-allow-origin': 'http://localhost:3100',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
      'access-control-expose-headers': 'etag',
    };
    const send = (status: number, json?: unknown) =>
      route.fulfill({
        status,
        headers: {
          ...cors,
          'content-type': json && status >= 400 ? 'application/problem+json' : 'application/json',
        },
        body: json === undefined ? '' : JSON.stringify(json),
      });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

    const custom = o.onRoute?.(path, method, body);
    if (custom) return send(custom.status, custom.json);

    if (path === '/v1/status')
      return send(200, {
        ingest: 'RUNNING',
        feeds: { ok: 1, degraded: 0, stale: 0, total: 1 },
        asOf: new Date().toISOString(),
      });
    if (path === '/v1/me') return send(200, (o.me ?? me)());
    if (path === '/v1/instruments') return send(200, { items: instruments });
    if (path === '/v1/sessions' && method === 'GET')
      return send(200, { items: [], nextCursor: null });
    if (path === '/v1/sessions' && method === 'POST') {
      return send(201, {
        sessionId: SESSION_ID,
        wsToken: 'ws',
        wsTokenExpiresAt: '2030-01-01T00:00:00Z',
        wsUrl: 'ws://api.test/ws',
        limits: { maxSessionMinutes: 120, dailyAiBudgetUsd: 1, explainPerDay: 10, voicePerDay: 50 },
        initial: null,
      });
    }
    if (path.endsWith('/ws-token'))
      return send(200, { wsToken: 'ws', wsTokenExpiresAt: '2030-01-01T00:00:00Z' });
    if (path.endsWith('/end')) return send(204);
    if (path.endsWith('/analysis')) {
      const id = path.split('/')[3] ?? INST_FULL;
      return send(200, analysis(id, o.withSetup === true && id === INST_FULL));
    }
    if (path.endsWith('/analysis/events'))
      return send(200, {
        items: [
          {
            id: 'E1',
            type: 'BOS_BULL',
            tf: '15m',
            scale: 'external',
            time: '2026-10-01T08:15:00Z',
            anchor: '2026-10-01T08:00:00Z',
            data: {},
          },
        ],
      });
    if (path.endsWith('/candles')) {
      const now = Math.floor(Date.now() / 900000) * 900000;
      return send(200, {
        items: Array.from({ length: 40 }, (_, i) => ({
          openTime: new Date(now - (40 - i) * 900000).toISOString(),
          o: 64000 + i,
          h: 64100 + i,
          l: 63950 + i,
          c: 64050 + i,
          v: 10,
          status: 'CLOSED',
        })),
      });
    }
    if (path === '/v1/setups/rejected') return send(200, { items: [] });
    if (path === '/v1/stats/cohorts') return send(200, { items: [] });
    if (path === '/v1/gate/issue') {
      return send(200, {
        gateId: uuid(9),
        planId: PLAN_ID,
        planHash: plan.planHash,
        state: 'ISSUED',
        expiresAt: new Date(Date.now() + (o.gateExpiresInMs ?? 60_000)).toISOString(),
        token: 'tok_'.padEnd(43, 'x'),
      });
    }
    if (path.endsWith('/confirm')) {
      if (o.confirmStatus && o.confirmStatus >= 400) {
        return send(o.confirmStatus, {
          type: 'about:blank',
          title: 'x',
          status: o.confirmStatus,
          code: o.confirmStatus === 410 ? 'GATE_TOKEN_EXPIRED' : 'PLAN_CHANGED',
          correlationId: 'c',
        });
      }
      return send(200, {
        gateId: uuid(9),
        planId: PLAN_ID,
        planHash: plan.planHash,
        state: 'CONFIRMED',
        expiresAt: new Date().toISOString(),
      });
    }
    if (path.endsWith('/decline')) return send(200, {});
    if (path === '/v1/trades' && method === 'POST') return send(201, { id: uuid(10) });
    if (path === '/v1/trades') return send(200, { items: [], nextCursor: null });
    if (path === '/v1/journal/summary')
      return send(200, {
        closedTrades: 0,
        openTrades: 0,
        setupsShown: 0,
        totalR: null,
        winRate: null,
        winRateReason: 'INSUFFICIENT_HISTORY',
      });
    if (path === '/v1/journal' && method === 'GET')
      return send(200, { items: [], nextCursor: null });
    if (path === '/v1/journal/notes') return send(201, { id: uuid(11) });
    if (path === '/v1/notifications')
      return send(200, {
        items: [
          {
            id: uuid(12),
            type: 'position.STOP_HIT',
            payload: {},
            read: false,
            createdAt: '2026-10-01T09:00:00Z',
          },
        ],
      });
    if (path.startsWith('/v1/me/')) return send(204);
    return send(404, {
      type: 'about:blank',
      title: 'x',
      status: 404,
      code: 'NOT_FOUND',
      correlationId: 'c',
    });
  });
  return calls;
}
