/**
 * Route path patterns: `/work/:slug` captures one segment, `/:lang?/about` makes a segment optional and a trailing
 * `*` captures the rest of the path as `wildcard`. Matching ignores a trailing slash and decodes parameters.
 */
export interface CompiledPath {
  readonly path: string;
  readonly pattern: RegExp;
  readonly keys: readonly string[];
}

const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)(\?)?$/;

function escape(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compilePath(path: string): CompiledPath {
  if (!path.startsWith('/')) throw new Error(`Route path must start with "/": ${path}`);
  const keys: string[] = [];
  const segments = path.split('/').filter(Boolean);
  let source = '';
  segments.forEach((segment, i) => {
    if (segment === '*') {
      if (i !== segments.length - 1) throw new Error(`"*" must be the last segment of route path ${path}`);
      keys.push('wildcard');
      source += '(?:/(.*))?';
      return;
    }
    const param = PARAM.exec(segment);
    if (param) {
      const name = param[1] as string;
      if (keys.includes(name)) throw new Error(`Duplicate parameter "${name}" in route path ${path}`);
      keys.push(name);
      source += param[2] ? '(?:/([^/]+))?' : '/([^/]+)';
      return;
    }
    if (segment.includes(':')) throw new Error(`Invalid segment "${segment}" in route path ${path}`);
    source += `/${escape(segment)}`;
  });
  return { path, keys, pattern: new RegExp(`^${source || ''}/?$`, 'i') };
}

/** Parameters of `pathname` for the compiled path, or null when it does not match or a parameter is malformed. */
export function matchPath(compiled: CompiledPath, pathname: string): Record<string, string> | null {
  const m = compiled.pattern.exec(pathname === '' ? '/' : pathname);
  if (!m) return null;
  const params: Record<string, string> = {};
  try {
    compiled.keys.forEach((key, i) => {
      const value = m[i + 1];
      if (value !== undefined) params[key] = decodeURIComponent(value);
    });
  } catch {
    return null;
  }
  return params;
}

/** Fills a route path with parameters; required parameters must be present. */
export function buildPath(path: string, params: Readonly<Record<string, string | number>> = {}): string {
  const out = path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment === '*') return params.wildcard === undefined ? '' : String(params.wildcard).split('/').map(encodeURIComponent).join('/');
      const param = PARAM.exec(segment);
      if (!param) return segment;
      const value = params[param[1] as string];
      if (value === undefined || value === '') {
        if (param[2]) return '';
        throw new Error(`Missing parameter "${param[1]}" for route path ${path}`);
      }
      return encodeURIComponent(String(value));
    })
    .filter(Boolean)
    .join('/');
  return `/${out}`;
}
