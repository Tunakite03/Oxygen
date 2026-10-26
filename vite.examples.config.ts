import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import website from './website/vite.config.ts';

// Preserve the existing CI artifact and browser-test commands after moving the website.
export default defineConfig({
  ...website,
  build: { ...website.build, outDir: resolve(import.meta.dirname, 'examples-dist') },
});
