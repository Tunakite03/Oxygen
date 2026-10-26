import { z } from 'zod';
import { ConfigValueError } from '../core/errors';
import { fetchJson } from '../core/net';
import { cleanAssetPath } from '../core/paths';

/**
 * Typed read access to a flat key/value scene-config document (authored transforms, uniforms, layer settings).
 * Every getter returns `undefined` for a missing key and throws `ConfigValueError` for a present key of the wrong type.
 */
const documentSchema = z.record(z.string(), z.unknown());
const numberSchema = z.number();
const vecSchema = z.array(z.number());
const stringSchema = z.string();
const boolSchema = z.boolean();
const fileSchema = z.object({ src: z.string() }).loose();

export type ConfigData = Readonly<Record<string, unknown>>;

export class ConfigStore {
  private constructor(private readonly data: ConfigData) {}

  static from(raw: unknown): ConfigStore {
    return new ConfigStore(documentSchema.parse(raw));
  }

  static async load(url: string): Promise<ConfigStore> {
    return ConfigStore.from(await fetchJson(url));
  }

  has(key: string): boolean {
    return key in this.data;
  }

  raw(key: string): unknown {
    return this.data[key];
  }

  /** Numbers may be stored as numeric strings. */
  number(key: string): number | undefined {
    const v = this.data[key];
    if (v === undefined) return undefined;
    const parsed = numberSchema.safeParse(typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
    if (!parsed.success) throw new ConfigValueError(key, 'number');
    return parsed.data;
  }

  vec(key: string): number[] | undefined {
    const v = this.data[key];
    if (v === undefined) return undefined;
    const parsed = vecSchema.safeParse(v);
    if (!parsed.success) throw new ConfigValueError(key, 'number[]');
    return parsed.data;
  }

  string(key: string): string | undefined {
    const v = this.data[key];
    if (v === undefined) return undefined;
    const parsed = stringSchema.safeParse(v);
    if (!parsed.success) throw new ConfigValueError(key, 'string');
    return parsed.data;
  }

  bool(key: string): boolean | undefined {
    const v = this.data[key];
    if (v === undefined) return undefined;
    const parsed = boolSchema.safeParse(v);
    if (!parsed.success) throw new ConfigValueError(key, 'boolean');
    return parsed.data;
  }

  /** File inputs are stored as a path or as `{ src }`. Query strings are stripped. */
  file(key: string): string | undefined {
    const v = this.data[key];
    if (v === undefined || v === '') return undefined;
    if (typeof v === 'string') return cleanAssetPath(v);
    const parsed = fileSchema.safeParse(v);
    if (!parsed.success) throw new ConfigValueError(key, 'file reference');
    return cleanAssetPath(parsed.data.src);
  }

  keys(prefix: string): string[] {
    return Object.keys(this.data).filter((k) => k.startsWith(prefix));
  }
}
