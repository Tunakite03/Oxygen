import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const root = import.meta.dirname;
const fragments = ['head', 'header', 'footer'] as const;

function siteLayout(): Plugin {
  return {
    name: 'oxygen-site-layout',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context): string {
        const depth = relative(root, dirname(context.filename)).split(/[\\/]/).filter(Boolean).length;
        const rootHref = depth === 0 ? './' : '../'.repeat(depth);
        return fragments.reduce((page, fragment) => {
          const marker = `<!-- site:${fragment} -->`;
          if (!page.includes(marker)) return page;
          const content = readFileSync(resolve(root, 'shared', `${fragment}.html`), 'utf8');
          return page.replaceAll(marker, content.replaceAll('{{root}}', rootHref));
        }, html);
      },
    },
    configureServer(server): void {
      server.watcher.add(resolve(root, 'shared'));
      server.watcher.on('change', (file: string) => {
        if (fragments.some((fragment) => file === resolve(root, 'shared', `${fragment}.html`))) {
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
  };
}

export default defineConfig({
  root,
  base: './',
  plugins: [siteLayout()],
  resolve: { alias: [
    { find: '@tunn/oxygen/physics', replacement: resolve(root, '../src/physics.ts') },
    { find: '@tunn/oxygen', replacement: resolve(root, '../src/index.ts') },
  ] },
  build: {
    target: 'es2022',
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(['index', 'docs', 'reference', 'examples', 'embed', 'post', 'particles', 'physics', 'router', 'activetheory']
        .map((page) => [page, resolve(root, page === 'index' ? 'index.html' : `${page}/index.html`)])),
    },
  },
});
