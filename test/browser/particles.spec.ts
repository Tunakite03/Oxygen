import { expect, test } from '@playwright/test';

interface ParticleProbe {
  steps: number;
  position: number[];
  strength: number;
}

declare global {
  interface Window {
    particleProbe: ParticleProbe;
  }
}

test('runs GPU particles, reports motion pauses, and isolates pointer controls from the GUI', async ({ page }) => {
  // Software GL (SwiftShader) on CI makes every frame and readPixels stall slow, so each round trip waits longer.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 800, height: 600 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    window.particleProbe = { steps: 0, position: [], strength: 0 };
    const original = WebGL2RenderingContext.prototype.drawArrays;
    const programs = new WeakMap<WebGLProgram, {
      dt: WebGLUniformLocation | null;
      strength: WebGLUniformLocation | null;
    }>();
    const pixel = new Float32Array(4);
    WebGL2RenderingContext.prototype.drawArrays = function (mode: GLenum, first: GLint, count: GLsizei): void {
      original.call(this, mode, first, count);
      const program = this.getParameter(this.CURRENT_PROGRAM) as WebGLProgram | null;
      if (!program) return;
      let uniforms = programs.get(program);
      if (!uniforms) {
        uniforms = { dt: this.getUniformLocation(program, 'dt'), strength: this.getUniformLocation(program, 'attractorStrength') };
        programs.set(program, uniforms);
      }
      if (!uniforms.dt) return;
      if (uniforms.strength) {
        window.particleProbe.strength = this.getUniform(program, uniforms.strength) as number;
      } else {
        // Read a real simulation texel after its position pass, not the visible canvas.
        this.readPixels(0, 0, 1, 1, this.RGBA, this.FLOAT, pixel);
        window.particleProbe.position = Array.from(pixel);
        window.particleProbe.steps++;
      }
    };
  });
  await page.goto('/particles/');
  const motion = page.getByRole('combobox', { name: 'motion', exact: true });
  const status = page.getByRole('status', { name: 'Simulation status' });
  await expect(motion).toHaveValue('system');
  await expect(status).toContainText('reduced motion');
  expect(await page.evaluate(() => window.particleProbe.steps)).toBe(0);

  await motion.selectOption('full');
  await expect(status).toContainText('Simulation running');
  await expect.poll(() => page.evaluate(() => window.particleProbe.steps)).toBeGreaterThan(1);
  const initial = await page.evaluate(() => window.particleProbe.position);
  await expect.poll(() => page.evaluate(() => window.particleProbe.position)).not.toEqual(initial);
  expect(await page.evaluate(() => window.particleProbe.position.every(Number.isFinite))).toBe(true);

  await page.mouse.move(250, 250);
  await expect.poll(() => page.evaluate(() => window.particleProbe.strength)).toBe(6);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => window.particleProbe.strength)).toBe(-14);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.particleProbe.strength)).toBe(6);
  await motion.hover();
  await expect.poll(() => page.evaluate(() => window.particleProbe.strength)).toBe(0);

  await page.getByRole('spinbutton', { name: 'time scale value', exact: true }).fill('0');
  await page.keyboard.press('Tab');
  await expect(status).toContainText('time scale is 0');
  const paused = await page.evaluate(() => window.particleProbe.steps);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.particleProbe.steps)).toBe(paused);
  await page.getByRole('spinbutton', { name: 'time scale value', exact: true }).fill('1');
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => window.particleProbe.steps)).toBeGreaterThan(paused);

  await page.reload();
  await expect(motion).toHaveValue('full');
  await expect.poll(() => page.evaluate(() => window.particleProbe.steps)).toBeGreaterThan(0);
  await motion.selectOption('system');
  await expect(status).toContainText('reduced motion');
  const reduced = await page.evaluate(() => window.particleProbe.steps);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.particleProbe.steps)).toBe(reduced);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect.poll(() => page.evaluate(() => window.particleProbe.steps)).toBeGreaterThan(reduced);
  await motion.selectOption('reduce');
  await expect(status).toContainText('reduced motion');
  const explicit = await page.evaluate(() => window.particleProbe.steps);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => window.particleProbe.steps)).toBe(explicit);
  expect(errors).toEqual([]);
});
