import { expect, test } from '@playwright/test';

function resolveApiBaseUrl(webBaseUrl: string): string {
  if (process.env.NEXT_PUBLIC_API_BASE_URL) {
    return process.env.NEXT_PUBLIC_API_BASE_URL.replace(/\/+$/, '');
  }
  const parsed = new URL(webBaseUrl);
  return `${parsed.protocol}//${parsed.hostname}:4000/api/v1`;
}

test.describe('Phase 3 End-to-End Browser Authentication, Email Verification, Recovery, CSRF Logout & Plane Boundary Suite', () => {
  test('E2E-P3-01: completes browser Registration -> Email Verification -> Login -> Workspace Session -> 403 Platform Boundary -> CSRF Logout -> Password Reset -> Re-Login', async ({
    page,
    baseURL,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const server5xxErrors: string[] = [];

    page.on('console', (msg) => {
      // Browsers emit a generic console error on expected 401/403 network responses (e.g. testing /platform 403 boundary)
      if (msg.type() === 'error' && !msg.text().includes('Failed to load resource')) {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });
    page.on('response', (res) => {
      if (res.status() >= 500) {
        server5xxErrors.push(`${res.status()} ${res.url()}`);
      }
    });

    const uniqueId = Date.now().toString(36);
    const email = `e2e.user.${uniqueId}@ft360-e2e.local`;
    const initialPassword = 'E2e#Initial2026!Pass';
    const rotatedPassword = 'E2e#Rotated2026!Pass';
    const apiBase = resolveApiBaseUrl(baseURL || 'http://localhost:3000');

    // 1. Navigate from Phase 1 home dashboard to /register
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByTestId('overall-health-badge')).toContainText('API: HEALTHY');
    await page.getByTestId('nav-register').click();
    await expect(page).toHaveURL(/\/register$/);

    // 2. Submit Registration form
    await page.getByTestId('register-fullname-input').fill('E2E Verification User');
    await page.getByTestId('register-email-input').fill(email);
    await page.getByTestId('register-password-input').fill(initialPassword);
    await page.getByTestId('register-submit-btn').click();
    await expect(page.getByTestId('register-success-banner')).toContainText(email);

    // 3. Retrieve verification token from non-prod outbox and verify email in browser
    const verifyOutboxRes = await page.request.get(
      `${apiBase}/auth/dev-outbox?email=${encodeURIComponent(email)}&kind=EMAIL_VERIFICATION`,
    );
    expect(verifyOutboxRes.status()).toBe(200);
    const verifyOutboxBody = (await verifyOutboxRes.json()) as {
      data: { rawToken: string };
    };
    expect(verifyOutboxBody.data?.rawToken).toBeTruthy();

    await page.goto(`/verify-email?token=${encodeURIComponent(verifyOutboxBody.data.rawToken)}`);
    await expect(page.getByTestId('email-verified-banner')).toContainText('Email address verified');
    await page.getByTestId('goto-login-after-verify').click();
    await expect(page).toHaveURL(/\/login$/);

    // 4. Sign in via /login and verify authenticated /workspace view
    await page.getByTestId('login-email-input').fill(email);
    await page.getByTestId('login-password-input').fill(initialPassword);
    await page.getByTestId('login-submit-btn').click();

    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByTestId('workspace-user-email')).toHaveText(email);
    await expect(page.getByTestId('unscoped-workspace-notice')).toBeVisible();

    // 5. Verify Platform Super Admin boundary blocks standard authenticated user in browser (403)
    await page.goto('/platform');
    await expect(page.getByTestId('platform-denied-banner')).toContainText(
      'PLATFORM_SUPER_ADMIN_REQUIRED',
    );

    // 6. Return to /workspace and click Sign Out (verifies cookie + X-CSRF-Token mutation in real Chromium)
    await page.goto('/workspace');
    await expect(page.getByTestId('workspace-user-email')).toHaveText(email);
    await page.getByTestId('logout-btn').click();
    await expect(page).toHaveURL(/\/login$/);

    // Confirm revoked session redirects /workspace back to /login
    await page.goto('/workspace');
    await expect(page).toHaveURL(/\/login$/);

    // 7. Forgot-password & Reset-password browser workflow
    await page.goto('/forgot-password');
    await page.getByTestId('forgot-email-input').fill(email);
    await page.getByTestId('forgot-submit-btn').click();
    await expect(page.getByTestId('forgot-password-accepted')).toBeVisible();

    const resetOutboxRes = await page.request.get(
      `${apiBase}/auth/dev-outbox?email=${encodeURIComponent(email)}&kind=PASSWORD_RESET`,
    );
    expect(resetOutboxRes.status()).toBe(200);
    const resetOutboxBody = (await resetOutboxRes.json()) as {
      data: { rawToken: string };
    };
    expect(resetOutboxBody.data?.rawToken).toBeTruthy();

    await page.goto(`/reset-password?token=${encodeURIComponent(resetOutboxBody.data.rawToken)}`);
    await page.getByTestId('reset-new-password-input').fill(rotatedPassword);
    await page.getByTestId('reset-submit-btn').click();
    await expect(page.getByTestId('reset-password-success')).toBeVisible();

    // 8. Sign in with newly reset password
    await page.getByTestId('goto-login-after-reset').click();
    await page.getByTestId('login-email-input').fill(email);
    await page.getByTestId('login-password-input').fill(rotatedPassword);
    await page.getByTestId('login-submit-btn').click();
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByTestId('workspace-user-email')).toHaveText(email);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(server5xxErrors).toEqual([]);
  });
});
