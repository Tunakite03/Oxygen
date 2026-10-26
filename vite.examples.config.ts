import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = resolve(import.meta.dirname, 'examples');

export default defineConfig({
  root,
  base: './',
  resolve: { alias: [
    { find: '@tunn/oxygen/physics', replacement: resolve(import.meta.dirname, 'src/physics.ts') },
    { find: '@tunn/oxygen', replacement: resolve(import.meta.dirname, 'src/index.ts') },
  ] },
  build: {
    target: 'es2022',
    outDir: resolve(import.meta.dirname, 'examples-dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        embed: resolve(root, 'embed/index.html'),
        post: resolve(root, 'post/index.html'),
        particles: resolve(root, 'particles/index.html'),
        physics: resolve(root, 'physics/index.html'),
        router: resolve(root, 'router/index.html'),
        reference: resolve(root, 'reference/index.html'),
      },
    },
  },
});
