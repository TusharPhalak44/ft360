import { expect, test } from '@playwright/test';

test.describe('Phase 1 Frontend <-> Backend Foundation Communication', () => {
  test('renders configurable product identity and live PostgreSQL + Redis health', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByTestId('overall-health-badge')).toContainText('API: HEALTHY');
    await expect(page.getByTestId('product-name')).not.toBeEmpty();
    await expect(page.getByTestId('db-role')).toContainText('ft360_app');
    await expect(page.getByTestId('db-rls-posture')).toHaveText('false / false');
    await expect(page.getByTestId('redis-status')).toContainText('Connected (PONG)');
  });
});

