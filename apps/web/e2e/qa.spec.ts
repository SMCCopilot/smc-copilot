import { mkdirSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { INST_FULL, mockApi, signIn } from './mock';

// Layout screenshots at the three audit widths in both themes, the chart with candles, and the Meet-style share flow.
// Screenshots go to docs/qa/<QA_DIR> (default "after") so before/after sets can be compared by eye.
const OUT = `../../docs/qa/${process.env.QA_DIR ?? 'after'}`;
mkdirSync(OUT, { recursive: true });

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
    ],
  },
});

async function room(page: Page, theme: 'dark' | 'light') {
  await page.route('http://supabase.test/**', (r) => r.fulfill({ status: 404, body: '{}' }));
  await page.addInitScript((t) => localStorage.setItem('smc-theme', t), theme);
  await signIn(page);
  const calls = await mockApi(page, { withSetup: true });
  await page.goto('/');
  await page.getByLabel('Chart market').selectOption(INST_FULL);
  await expect(page.getByRole('button', { name: 'Share screen' })).toBeEnabled({ timeout: 15_000 });
  return calls;
}

const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1280', width: 1280, height: 720 },
  { name: '390', width: 390, height: 844 },
] as const;

for (const theme of ['dark', 'light'] as const) {
  for (const size of SIZES) {
    test(`room ${theme} ${size.name}: chart canvas is drawn and nothing scrolls sideways`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await room(page, theme);
      await expect(page.locator('section[aria-label="Chart"] canvas').first()).toBeVisible();
      const box = await page.locator('section[aria-label="Chart"]').boundingBox();
      expect(box?.height ?? 0).toBeGreaterThan(150);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/room-${theme}-${size.name}.png` });
    });
  }
}

test('share screen: button, sharing indicator, self-view, privacy line, stop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await room(page, 'dark');
  await page.getByRole('button', { name: 'Share screen' }).click();
  const panel = page.getByRole('region', { name: 'Screen share' });
  await expect(panel.getByText('Sharing', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('video')).toBeVisible();
  await expect(
    panel.getByText('Frames stay on this device. Only text is sent, unless you press Explain.'),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Explain now' })).toBeVisible();
  await page.screenshot({ path: `${OUT}/share-active-1440.png` });
  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Share screen' })).toBeVisible();
});

test('the web app sends baseline security headers and allows mic and screen capture only for itself', async ({
  page,
}) => {
  const res = await page.goto('/');
  const h = res?.headers() ?? {};
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['permissions-policy']).toContain('display-capture=(self)');
  expect(h['permissions-policy']).toContain('microphone=(self)');
});
