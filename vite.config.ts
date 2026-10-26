import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    emptyOutDir: false,
    // Consumers minify; readable output and source maps keep their stack traces pointing at src/.
    minify: false,
    sourcemap: true,
    lib: { entry: 'src/index.ts', formats: ['es'], fileName: 'index' },
    rollupOptions: { external: [/^three(\/.*)?$/, 'zod', '@dimforge/rapier3d-compat'] },
  },
  test: { environment: 'happy-dom', include: ['test/**/*.test.ts'] },
});
