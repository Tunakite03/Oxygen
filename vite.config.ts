import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    target: 'es2022',
    emptyOutDir: false,
    lib: { entry: { index: 'src/index.ts', physics: 'src/physics.ts' }, formats: ['es'], fileName: (_format, name) => `${name}.js` },
    rollupOptions: { external: [/^three(\/.*)?$/, 'zod', '@dimforge/rapier3d-compat'] },
  },
  test: { environment: 'happy-dom', include: ['test/**/*.test.ts'] },
});
