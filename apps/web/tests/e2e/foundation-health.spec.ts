import { expect, test } from '@playwright/test';

test.describe('Phase 1 Frontend <-> Backend Foundation Communication & Zero-Issue UI Check', () => {
  test('renders configurable product identity, live PostgreSQL + Redis health, dynamic icon, and zero Next.js dev issues even with browser extension DOM mutations', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const httpErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) {
        httpErrors.push(`${res.status()} ${res.url()}`);
      }
    });

    // Simulate desktop Chrome extensions (e.g. Grammarly / ColorZilla) mutating <body> pre-hydration
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        if (document.body && !document.body.hasAttribute('data-new-gr-c-s-check-loaded')) {
          document.body.setAttribute('data-new-gr-c-s-check-loaded', '14.1200.0');
          document.body.setAttribute('cz-shortcut-listen', 'true');
          observer.disconnect();
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    });

    await page.goto('/', { waitUntil: 'networkidle' });

    await expect(page.getByTestId('overall-health-badge')).toContainText('API: HEALTHY');
    await expect(page.getByTestId('product-name')).not.toBeEmpty();
    await expect(page.getByTestId('db-role')).toContainText('ft360_app');
    await expect(page.getByTestId('db-rls-posture')).toHaveText('false / false');
    await expect(page.getByTestId('redis-status')).toContainText('Connected (PONG)');

    // Verify dynamic configurable icon route returns 200 image/png
    const iconRes = await page.request.get('/icon');
    expect(iconRes.status()).toBe(200);
    expect(iconRes.headers()['content-type']).toContain('image/png');

    // Verify Next.js Dev Tools badge reports 0 issues (data-error !== "true")
    const devBadgeError = await page.evaluate(() => {
      const sr = document.querySelector('nextjs-portal')?.shadowRoot;
      const badge = sr?.querySelector('[data-next-badge]');
      return badge?.getAttribute('data-error') ?? 'none';
    });
    expect(devBadgeError).not.toBe('true');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(httpErrors).toEqual([]);
  });
});
