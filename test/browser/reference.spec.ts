import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/reference/');
});

test('searches API exports and translated section names with keyboard navigation', async ({ page }) => {
  const navigation = page.getByRole('navigation', { name: 'Contents' });
  const search = page.getByRole('searchbox');
  await expect(navigation.getByRole('link')).toHaveCount(19);
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('createPipeline');
  await expect(navigation.getByRole('link')).toHaveCount(1);
  await search.press('Enter');
  await expect(page).toHaveURL(/#pipeline$/);
  await expect(navigation.locator('a[aria-current="location"]')).toHaveAttribute('href', '#pipeline');
  await expect(page.locator('#pipeline h2')).toBeFocused();

  await search.fill('chất lượng');
  await expect(navigation.getByRole('link')).toHaveCount(1);
  await expect(navigation.getByRole('link')).toHaveAttribute('href', '#quality');
  await search.fill('no-such-oxygen-export');
  await expect(navigation.getByRole('link')).toHaveCount(0);
  await expect(page.locator('#search-status')).toBeVisible();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(navigation.getByRole('link')).toHaveCount(19);

  await page.locator('#errors').scrollIntoViewIfNeeded();
  await expect(navigation.locator('a[aria-current="location"]')).toHaveAttribute('href', '#errors');
});

test('copies the original code and preserves the language choice after reloading', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const example = page.locator('#quick-start .code-block');
  const source = await example.locator('pre code').textContent();
  await example.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(example.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(source);

  await page.getByRole('button', { name: 'VI', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName('Tài liệu API');
  await expect(example.getByRole('button', { name: 'Đã sao chép', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.getByRole('button', { name: 'VI', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(example.getByRole('button', { name: 'Sao chép', exact: true })).toBeVisible();
});

test('shows a visible copy failure when clipboard access is denied', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (): Promise<void> => { throw new DOMException('Permission denied', 'NotAllowedError'); } },
    });
  });
  const copy = page.locator('#overview .copy-code');
  await copy.click();
  await expect(copy).toHaveAttribute('data-state', 'error');
  await expect(copy).toHaveAccessibleName('Copy unavailable — select the code');
});

test('opens and closes mobile navigation and keeps content within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator('#menu-toggle');
  const navigation = page.getByRole('navigation', { name: 'Contents' });
  await expect(navigation).toBeHidden();
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('main')).toHaveJSProperty('inert', true);
  await page.keyboard.press('Escape');
  await expect(navigation).toBeHidden();
  await expect(menu).toBeFocused();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('searchbox').fill('PhysicsWorld');
  await navigation.getByRole('link', { name: 'Physics', exact: true }).click();
  await expect(page).toHaveURL(/#physics$/);
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('main')).toHaveJSProperty('inert', false);
  await page.getByRole('button', { name: 'VI', exact: true }).click();
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('preserves the interactive engine demos after enhancing the reference', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('#ping').click();
  await expect(page.locator('#ping-count')).toHaveText('1');
  await page.locator('#gain').fill('0.75');
  await expect(page.locator('#gain-value')).toHaveText('0.75');
  await page.locator('#motion').selectOption('reduce');
  await page.locator('#tween-toggle').click();
  await expect(page.locator('#tween-bar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
  await page.locator('#mount').click();
  await expect(page.locator('#scene-host canvas')).toHaveCount(1);
  await page.locator('#unmount').click();
  await expect(page.locator('#scene-host canvas')).toHaveCount(0);
  expect(errors).toEqual([]);
});
