import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const directory = mkdtempSync(join(tmpdir(), 'oxygen-consumer-'));
let server;
let browser;
function run(command, args) { return execFileSync(command, args, { cwd: directory, stdio: 'inherit' }); }
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: root, encoding: 'utf8' }));
  if (!packed[0]?.filename || packed[0].filename.includes('/')) throw new Error('npm pack returned an invalid filename');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    private: true, type: 'module', dependencies: {
      [pkg.name]: `file:${join(directory, packed[0].filename)}`,
      three: pkg.devDependencies.three, zod: pkg.devDependencies.zod,
    },
  }));
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  if (existsSync(join(directory, 'node_modules/@dimforge/rapier3d-compat'))) throw new Error('Optional Rapier was pulled into the core consumer');
  run(process.execPath, ['--input-type=module', '-e', "const oxygen = await import('@tunakite03/oxygen'); if (typeof oxygen.createPipeline !== 'function' || typeof window !== 'undefined') throw Error('SSR import failed');"]);
  const consumer = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  consumer.devDependencies = { typescript: pkg.devDependencies.typescript, vite: pkg.devDependencies.vite, '@types/three': pkg.devDependencies['@types/three'] };
  writeFileSync(join(directory, 'package.json'), JSON.stringify(consumer));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  // @types/three declares an older Rapier dependency for its unrelated addon types.
  // Remove it from this isolated fixture to prove Oxygen core declarations do not require it.
  rmSync(join(directory, 'node_modules/@dimforge'), { recursive: true, force: true });
  writeFileSync(join(directory, 'index.html'), '<!doctype html><html lang="en"><title>Oxygen package consumer</title><body><main id="host" style="width:320px;height:200px;position:relative"></main><script type="module" src="/main.ts"></script></body></html>');
  writeFileSync(join(directory, 'main.ts'), `import { createPipeline, GLTFAssets, stopLoop } from '@tunakite03/oxygen';
import { PerspectiveCamera, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
const host = document.getElementById('host');
if (!host) throw Error('Missing host');
const pipeline = createPipeline(host, { sizeMode: 'container' });
const mesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial({ color: 0x55bb99 }));
pipeline.scene.add(mesh);
const camera = new PerspectiveCamera(45, 1.6, 0.1, 100); camera.position.z = 4;
pipeline.render(camera);
host.dataset.ready = String(pipeline.renderer.info.render.calls > 0);
const assets = new GLTFAssets(); assets.dispose(); stopLoop();
`);
  for (const resolution of ['Bundler', 'NodeNext']) {
    writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: resolution === 'Bundler' ? 'ESNext' : 'NodeNext', moduleResolution: resolution, strict: true, noEmit: true, skipLibCheck: false, lib: ['ES2022', 'DOM', 'DOM.Iterable'] }, include: ['main.ts'] }));
    run(process.execPath, ['node_modules/typescript/bin/tsc']);
  }
  run(process.execPath, ['node_modules/vite/bin/vite.js', 'build']);
  for (const file of readdirSync(join(directory, 'dist/assets'))) {
    if (file.endsWith('.js') && /@dimforge|rapier_wasm/.test(readFileSync(join(directory, 'dist/assets', file), 'utf8'))) throw new Error('Core browser bundle includes Rapier');
  }
  let resolveAddress;
  let rejectAddress;
  const address = new Promise((resolve, reject) => { resolveAddress = resolve; rejectAddress = reject; });
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '0'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  const timer = setTimeout(() => rejectAddress(new Error('Consumer preview failed to start')), 30000);
  server.once('error', rejectAddress);
  server.once('exit', code => rejectAddress(new Error(`Consumer preview exited: ${code}`)));
  server.stdout.on('data', chunk => { const match = stripVTControlCharacters(String(chunk)).match(/http:\/\/127\.0\.0\.1:\d+\//); if (match) resolveAddress(match[0]); });
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  let url;
  try { url = await address; } finally { clearTimeout(timer); }
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.locator('#host[data-ready="true"] canvas').waitFor();
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Package consumer passed: SSR, optional peer isolation, Bundler + NodeNext declarations, Vite production build, Chromium WebGL render.');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise(resolve => server.once('exit', resolve));
    server.kill('SIGTERM');
    await exited;
  }
  rmSync(directory, { recursive: true, force: true });
}
