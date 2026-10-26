import { execFileSync } from 'node:child_process';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
await rm(dist, { recursive: true, force: true });
for (const [command, args] of [
  ['typescript/bin/tsc', ['-p', 'tsconfig.build.json']],
  ['vite/bin/vite.js', ['build']],
]) execFileSync(process.execPath, [join(root, 'node_modules', command), ...args], { cwd: root, stdio: 'inherit' });

// NodeNext consumers need explicit extensions in declaration imports as well as runtime imports.
for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
  const path = join(entry.parentPath, entry.name);
  const source = await readFile(path, 'utf8');
  const output = source.replace(/((?:from\s*|import\s*\()(['"]))(\.\.?\/[^'"]+)(\2)/g,
    (match, prefix, _quote, specifier, suffix) => /\.[cm]?js$/.test(specifier) ? match : `${prefix}${specifier}.js${suffix}`);
  await writeFile(path, output);
}
