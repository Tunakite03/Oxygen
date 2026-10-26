import { expect, test } from '@playwright/test';

test('renders, resizes, loads GLB and external glTF buffers, and remounts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/embed/');
  const host = page.locator('#scene');
  await expect(host).toHaveAttribute('data-state', 'ready');
  await expect(host).toHaveAttribute('data-draws', /[1-9]/);
  await page.evaluate(() => { const host = document.getElementById('scene')!; host.style.width = '420px'; host.style.height = '240px'; });
  await expect(page.locator('canvas')).toHaveCSS('width', '420px');
  await expect(page.locator('canvas')).toHaveCSS('height', '240px');
  for (const asset of ['../models/triangle.glb', '../models/triangle.gltf']) {
    await page.getByLabel('GLB or glTF URL').fill(asset);
    await page.getByRole('button', { name: 'Load asset', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Asset loaded.');
  }
  for (let count = 0; count < 3; count++) {
    await page.getByRole('button', { name: 'Unmount scene', exact: true }).click();
    await expect(page.locator('canvas')).toHaveCount(0);
    await page.getByRole('button', { name: 'Mount scene', exact: true }).click();
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(host).toHaveAttribute('data-state', 'ready');
  }
  expect(errors).toEqual([]);
});

test('responds to OS reduced motion and explicit preference without blocking keyboard controls', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/embed/');
  const host = page.locator('#scene');
  await expect(host).toHaveAttribute('data-reduced', 'true');
  await expect(host).toHaveAttribute('data-rotation', '0');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(host).toHaveAttribute('data-reduced', 'false');
  await expect.poll(() => host.getAttribute('data-rotation')).not.toBe('0');
  await page.getByLabel('Motion', { exact: true }).selectOption('reduce');
  await expect(host).toHaveAttribute('data-reduced', 'true');
  const rotation = await host.getAttribute('data-rotation');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await host.getAttribute('data-rotation')).toBe(rotation);
  await page.getByRole('button', { name: 'Unmount scene', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('shows semantic fallback when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: object[]): RenderingContext | null {
      if (type === 'webgl2') return null;
      return Reflect.apply(original, this, [type, ...args]) as RenderingContext | null;
    } as typeof original;
  });
  await page.goto('/embed/');
  await expect(page.locator('#scene')).toHaveAttribute('data-state', 'fallback');
  await expect(page.getByRole('heading', { name: 'Scene description' })).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('recovers from actual WebGL context loss', async ({ page }) => {
  await page.goto('/embed/');
  await expect(page.locator('#scene')).toHaveAttribute('data-state', 'ready');
  const extension = await page.evaluateHandle(() => {
    const gl = document.querySelector('canvas')!.getContext('webgl2')!;
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('Chromium lacks WEBGL_lose_context');
    return extension;
  });
  await extension.evaluate(value => value.loseContext());
  await expect(page.locator('#scene')).toHaveAttribute('data-state', 'lost');
  await expect(page.getByRole('heading', { name: 'Scene description' })).toBeVisible();
  await extension.evaluate(value => value.restoreContext());
  await extension.dispose();
  await expect(page.locator('#scene')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { name: 'Scene description' })).toBeHidden();
});

test('cancels a pending asset request with a visible failure reason', async ({ page }) => {
  let requested = (): void => {};
  const requestStarted = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/pending.glb', async route => { requested(); await new Promise(resolve => setTimeout(resolve, 500)); await route.abort(); });
  await page.goto('/embed/');
  await page.getByLabel('GLB or glTF URL').fill('/pending.glb');
  await page.getByRole('button', { name: 'Load asset', exact: true }).click();
  await requestStarted;
  await page.getByRole('button', { name: 'Cancel load' }).click();
  await expect(page.locator('#scene')).toHaveAttribute('data-asset', 'error');
  await expect(page.getByRole('status')).toContainText('pending.glb');
});
