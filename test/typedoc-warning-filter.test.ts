import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('only tolerates the known dependency comment warnings', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'oxygen-typedoc-'));
  const dependency = resolve(directory, 'node_modules/@types/three/src/extras/core/Curve.d.ts');
  const source = resolve(directory, 'source.ts');
  const config = resolve(directory, 'typedoc.json');
  const tsconfig = resolve(directory, 'tsconfig.json');
  const duplicateRemarks = '/**\n * Example.\n * @remarks First.\n * @remarks Second.\n */\n';

  try {
    mkdirSync(dirname(dependency), { recursive: true });
    writeFileSync(dependency, `${'\n'.repeat(9)}${duplicateRemarks}export declare class Curve {}\n`);
    writeFileSync(source, `${duplicateRemarks}export class ProjectClass {}\n`);
    writeFileSync(tsconfig, JSON.stringify({ compilerOptions: { skipLibCheck: true, types: [] }, files: [dependency, source] }));
    const run = (entryPoint: string): SpawnSyncReturns<string> => {
      writeFileSync(config, JSON.stringify({
        entryPoints: [entryPoint],
        tsconfig,
        plugin: [resolve('scripts/typedoc-warning-filter.mjs')],
        out: resolve(directory, 'docs'),
        name: 'Test API',
        readme: 'none',
        treatWarningsAsErrors: true,
      }));
      return spawnSync(process.execPath, [resolve('node_modules/typedoc/bin/typedoc'), '--options', config], { encoding: 'utf8' });
    };

    const dependencyBuild = run(dependency);
    expect(dependencyBuild.error).toBeUndefined();
    expect(dependencyBuild.status, dependencyBuild.stderr).toBe(0);
    expect(dependencyBuild.stdout).toContain('Known third-party documentation warning: At most one @remarks');
    expect(dependencyBuild.stdout).toContain('Known third-party documentation warning: At most one @returns');

    const projectBuild = run(source);
    expect(projectBuild.error).toBeUndefined();
    expect(projectBuild.status).toBe(3);
    expect(projectBuild.stderr).toContain('At most one @remarks');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
