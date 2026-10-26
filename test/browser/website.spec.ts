import { expect, test } from '@playwright/test';

test('connects the homepage, guide, examples and reference with a persistent language', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#hero-scene')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'VI', exact: true }).click();
  await page.locator('.hero-actions .button').first().click();
  await expect(page).toHaveURL(/\/docs\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await expect(page.locator('.site-nav [data-nav="docs"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('.site-nav [data-nav="examples"]').click();
  await expect(page).toHaveURL(/\/examples\/$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await page.locator('.site-nav [data-nav="reference"]').click();
  await expect(page.getByRole('navigation', { name: 'Contents' }).getByRole('link')).toHaveCount(19);
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  await page.getByRole('link', { name: 'Oxygen home', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('#hero-scene')).toHaveAttribute('data-state', 'ready');
});

test('filters the real examples and loads every preview', async ({ page }) => {
  await page.goto('/examples/');
  const visible = page.locator('[data-example-category]:visible');
  await expect(visible).toHaveCount(6);
  for (const category of ['rendering', 'simulation', 'interaction']) {
    const filter = page.locator(`[data-category="${category}"]`);
    await filter.click();
    await expect(filter).toHaveAttribute('aria-pressed', 'true');
    await expect(visible).toHaveCount(2);
    await expect(page.locator(`[data-example-category="${category}"]:visible`)).toHaveCount(2);
  }
  await page.locator('[data-category="all"]').click();
  await expect(visible).toHaveCount(6);
  for (const image of await page.locator('.example-grid img').all()) {
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
  }
  await page.locator('.example-grid a[href="../embed/"]').click();
  await expect(page.locator('#scene')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('link', { name: 'All examples', exact: true }).click();
  await expect(page).toHaveURL(/\/examples\/$/);
});

test('pauses the homepage scene and honors system reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  const host = page.locator('#hero-scene');
  const motion = page.locator('#hero-motion');
  await expect(host).toHaveAttribute('data-animated', 'true');
  await motion.click();
  await expect(host).toHaveAttribute('data-animated', 'false');
  await expect(motion).toHaveAttribute('aria-pressed', 'true');
  await motion.click();
  await expect(host).toHaveAttribute('data-animated', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(host).toHaveAttribute('data-animated', 'false');
  await expect(motion).toBeDisabled();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(motion).toBeEnabled();
  await expect(host).toHaveAttribute('data-animated', 'true');
  await page.locator('.home-cta').scrollIntoViewIfNeeded();
  await expect(host).toHaveAttribute('data-animated', 'false');
});

test('keeps the homepage usable without WebGL', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: object[]): RenderingContext | null {
      if (type === 'webgl2') return null;
      return Reflect.apply(original, this, [type, ...args]) as RenderingContext | null;
    } as typeof original;
  });
  await page.goto('/');
  await expect(page.locator('#hero-scene')).toHaveAttribute('data-state', 'fallback');
  await expect(page.locator('#hero-fallback')).toBeVisible();
  await expect(page.locator('#hero-motion')).toBeDisabled();
  await expect(page.locator('#hero-scene canvas')).toHaveCount(0);
  await page.locator('.hero-actions .button').first().click();
  await expect(page).toHaveURL(/\/docs\/$/);
});

test('copies complete setup code and supports keyboard navigation on mobile', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/');
  await page.locator('[data-copy-target="setup-code"]').click();
  await expect(page.locator('[data-copy-target="setup-code"]')).toHaveAttribute('data-state', 'copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm ci\nnpm run dev:website');
  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator('#site-menu-toggle');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
  await menu.click();
  await page.locator('.site-nav [data-nav="examples"]').click();
  await expect(page).toHaveURL(/\/examples\/$/);
});

test('fits all main pages at mobile, tablet and desktop widths in both languages', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const route of ['/', '/docs/', '/examples/', '/reference/']) {
    await page.goto(route);
    for (const language of ['en', 'vi']) {
      await page.getByRole('button', { name: language.toUpperCase(), exact: true }).click();
      for (const width of [360, 768, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${route} ${language} ${width}`).toBe(true);
      }
    }
  }
  expect(errors).toEqual([]);
});
