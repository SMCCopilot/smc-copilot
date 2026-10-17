import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { INST_FULL, INST_RAW_OFF, me, mockApi, SESSION_ID, signIn } from './mock';

async function openRoom(page: Page, opts: Parameters<typeof mockApi>[1] = {}) {
  await page.route('http://supabase.test/**', (r) => r.fulfill({ status: 404, body: '{}' }));
  await signIn(page);
  const calls = await mockApi(page, opts);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in with your wallet' })).toHaveCount(0);
  return calls;
}

test('signed out users see wallet sign-in and nothing else', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in with your wallet' })).toBeVisible();
  await expect(page.getByText('No wallet found in this browser')).toBeVisible();
  await expect(page.getByText(/email or password/i)).toBeVisible();
});

test('onboarding runs invite, disclaimer and 18+ in order, then opens the app', async ({
  page,
}) => {
  const state = { invited: false, accepted: false, adult: false };
  await openRoom(page, {
    me: () =>
      me({
        invite: { required: true, redeemed: state.invited },
        disclaimer: {
          required: true,
          currentVersion: 'v1',
          acceptedVersion: state.accepted ? 'v1' : null,
        },
        ageConfirmed: state.adult,
      }),
    onRoute: (path, method) => {
      if (method !== 'POST') return undefined;
      if (path === '/v1/me/invite') state.invited = true;
      else if (path === '/v1/me/disclaimer') state.accepted = true;
      else if (path === '/v1/me/age-confirmation') state.adult = true;
      else return undefined;
      return { status: 204 };
    },
  });
  await page.getByLabel('Invite code').fill('BETA-CODE');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText(/accept this disclaimer/)).toBeVisible();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
});

test('a licence-restricted instrument switches to overlay-only and never asks for candles', async ({
  page,
}) => {
  const calls = await openRoom(page);
  await page.getByLabel('Instrument').selectOption(INST_RAW_OFF);
  await expect(
    page
      .getByText(
        'Raw prices unavailable for this venue; use your own chart and share your screen to explain.',
      )
      .first(),
  ).toBeVisible();
  expect(calls.paths.some((p) => p.endsWith('/candles'))).toBe(false);
  await page.getByLabel('Instrument').selectOption(INST_FULL);
  await expect.poll(() => calls.paths.some((p) => p.endsWith('/candles'))).toBe(true);
});

test('starting a session sends one idempotency key and ending it clears the room', async ({
  page,
}) => {
  const calls = await openRoom(page);
  await page.getByLabel('Instrument').selectOption(INST_FULL);
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(page.getByRole('button', { name: 'End session' })).toBeVisible();
  const key = calls.headers['POST /v1/sessions']?.['idempotency-key'];
  expect(key).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.bodies['POST /v1/sessions']).toEqual({
    instrumentId: INST_FULL,
    tf: '15m',
    mode: 'FEED',
  });
  await page.getByRole('button', { name: 'End session' }).click();
  await expect(page.getByRole('button', { name: 'End session' })).toHaveCount(0);
});

test.describe('confirm gate', () => {
  async function toDialog(page: Page, opts: Parameters<typeof mockApi>[1] = {}, pick = true) {
    const calls = await openRoom(page, { withSetup: true, ...opts });
    if (pick) await page.getByLabel('Instrument').selectOption(INST_FULL);
    await expect(page.getByText('Long scenario').first()).toBeVisible();
    await expect(
      page.getByText('Rules check: all hard filters passed. This is not a prediction.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Log trade' }).click();
    await expect(page.getByRole('dialog', { name: 'Log this trade' })).toBeVisible();
    return calls;
  }

  test('only a tap confirms, with the shown hash, then the trade is recorded', async ({ page }) => {
    const calls = await toDialog(page);
    await expect(page.getByText(/valid for/)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm (tap)' }).click();
    await expect(page.getByText('Trade logged in your journal.')).toBeVisible();
    const confirm = Object.keys(calls.headers).find((k) => k.endsWith('/confirm')) as string;
    expect(calls.headers[confirm]?.['x-input-mode']).toBe('tap');
    expect((calls.bodies[confirm] as { planHash: string }).planHash).toBe('hash-abc12345');
    const trade = calls.bodies['POST /v1/trades'] as Record<string, unknown>;
    expect(trade).toMatchObject({
      direction: 'LONG',
      entryPrice: 64075,
      stopPrice: 63945,
      targets: [64450],
    });
    expect(calls.headers['POST /v1/trades']?.['idempotency-key']).toBeTruthy();
  });

  test('the 60 second window ends and Confirm is disabled', async ({ page }) => {
    await toDialog(page, { gateExpiresInMs: 1500 });
    await expect(page.getByText('The 60 second window ended. Review the plan again.')).toBeVisible({
      timeout: 6000,
    });
    await expect(page.getByRole('button', { name: 'Confirm (tap)' })).toBeDisabled();
  });

  test('a server refusal shows a clear message and a way to review the plan', async ({ page }) => {
    await toDialog(page, { confirmStatus: 410 });
    await page.getByRole('button', { name: 'Confirm (tap)' }).click();
    await expect(page.getByRole('alert')).toContainText('confirmation window ended');
    await expect(page.getByRole('button', { name: 'Review updated plan' })).toBeVisible();
  });

  test('the microphone is off while the dialog is open, with the reason', async ({ page }) => {
    await page.addInitScript(
      ([i, s]) =>
        localStorage.setItem(
          'smc-selection',
          JSON.stringify({
            instrumentId: i,
            tf: '15m',
            sessionId: s,
            startedAt: new Date().toISOString(),
          }),
        ),
      [INST_FULL, SESSION_ID],
    );
    await toDialog(page, {}, false);
    await expect(page.getByLabel('Turn on voice')).toBeDisabled();
  });
});

test('settings: theme choice is remembered and "never send images" switches off upload', async ({
  page,
}) => {
  await openRoom(page);
  await page
    .getByRole('button', { name: /Switch to (light|dark) theme/ })
    .first()
    .click();
  const chosen = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe(chosen);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByLabel(/Never send images to AI/).check();
  await page.getByRole('button', { name: 'Session room' }).first().click();
  await page.getByRole('button', { name: 'Explain this chart' }).click();
  await expect(page.getByRole('button', { name: 'Upload an image' })).toBeDisabled();
});

test('journal quick note is saved with tags', async ({ page }) => {
  const calls = await openRoom(page);
  await page.getByRole('button', { name: 'Journal' }).first().click();
  await page.getByLabel('Quick note').fill('Waited for the sweep');
  await page.getByLabel(/Tags/).fill('patience, sweep');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect
    .poll(() => calls.bodies['POST /v1/journal/notes'])
    .toEqual({ notes: 'Waited for the sweep', tags: ['patience', 'sweep'] });
});

test('small screens use a menu and a plan drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openRoom(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Close menu' }).click();
  await page.getByRole('button', { name: 'Open plan panel' }).click();
  await expect(page.getByRole('dialog', { name: 'Plan panel' })).toBeVisible();
});

test('no serious accessibility violations on the main screens', async ({ page }) => {
  await openRoom(page, { withSetup: true });
  await page.getByLabel('Instrument').selectOption(INST_FULL);
  await expect(page.getByText('Long scenario').first()).toBeVisible();
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    const r = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze();
    expect(
      r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
      JSON.stringify(r.violations.map((v) => v.id)),
    ).toEqual([]);
  }
});
