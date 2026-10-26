import { expect, test } from '@playwright/test';

interface TransitionSample {
  progress: number;
  effect: number;
}

declare global {
  interface Window {
    transitionSamples: TransitionSample[];
  }
}

test('previews every transition with an explicit motion override and follows live system preferences', async ({ page }) => {
  // Software GL (SwiftShader) on CI renders each frame in software, so every transition wait takes longer than the global budget.
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.transitionSamples = [];
    const original = WebGL2RenderingContext.prototype.drawArrays;
    const programs = new WeakMap<WebGLProgram, {
      progress: WebGLUniformLocation;
      effect: WebGLUniformLocation;
    } | null>();
    WebGL2RenderingContext.prototype.drawArrays = function (mode: GLenum, first: GLint, count: GLsizei): void {
      original.call(this, mode, first, count);
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram | null;
      if (!program) return;
      if (!programs.has(program)) {
        const progress = this.getUniformLocation(program, 'progress');
        const effect = this.getUniformLocation(program, 'effect');
        const from = this.getUniformLocation(program, 'tFrom');
        programs.set(program, progress && effect && from ? { progress, effect } : null);
      }
      const uniforms = programs.get(program);
      if (uniforms) window.transitionSamples.push({
        progress: this.getUniform(program, uniforms.progress) as number,
        effect: this.getUniform(program, uniforms.effect) as number,
      });
    };
  });
  await page.goto('/router/');
  await expect(page.getByRole('heading', { name: 'Oxygen', exact: true })).toBeVisible();
  const motion = page.getByRole('combobox', { name: 'motion', exact: true });
  const effect = page.getByRole('combobox', { name: 'effect', exact: true });
  const status = page.getByRole('status', { name: 'Transition status' });
  await expect(motion).toHaveValue('system');
  await expect(status).toContainText('reduced motion');
  await motion.selectOption('full');
  await expect(status).toContainText('Transitions ready');

  for (const scenario of [
    { effect: 'noise', id: 2, page: 'Aurora' },
    { effect: 'wipe', id: 1, page: 'Ember' },
    { effect: 'fade', id: 0, page: 'About' },
  ]) {
    await effect.selectOption(scenario.effect);
    await page.evaluate(() => { window.transitionSamples = []; });
    await page.getByRole('link', { name: scenario.page, exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.transitionSamples.some((sample) => sample.progress > 0.05 && sample.progress < 0.95))).toBe(true);
    expect(await page.evaluate(() => [...new Set(window.transitionSamples.map((sample) => sample.effect))])).toEqual([scenario.id]);
    await expect(status).toContainText('Transitions ready');
    await expect(page.getByRole('heading', { name: scenario.page, exact: true })).toBeVisible();
  }

  await motion.selectOption('system');
  await expect(status).toContainText('reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(status).toContainText('Transitions ready');
  await page.evaluate(() => { window.transitionSamples = []; });
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.transitionSamples.some((sample) => sample.progress > 0.05 && sample.progress < 0.95))).toBe(true);
  await expect(status).toContainText('Transitions ready');

  await motion.selectOption('reduce');
  await expect(status).toContainText('reduced motion');
  await page.evaluate(() => { window.transitionSamples = []; });
  await page.getByRole('link', { name: 'Aurora', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Aurora', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.transitionSamples.some((sample) => sample.progress > 0 && sample.progress < 1))).toBe(false);
  expect(errors).toEqual([]);
});
