/** Typed domain errors. Every failure names what failed, why, and non-sensitive context. */
export class AssetLoadError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Failed to load asset ${url}: ${reason}`);
    this.name = 'AssetLoadError';
  }
}

export class ShaderNotFoundError extends Error {
  constructor(readonly shaderName: string) {
    super(`Shader "${shaderName}" is not registered in the shader library`);
    this.name = 'ShaderNotFoundError';
  }
}

export class ConfigValueError extends Error {
  constructor(
    readonly key: string,
    readonly expected: string,
  ) {
    super(`Config value "${key}" is missing or not a valid ${expected}`);
    this.name = 'ConfigValueError';
  }
}

export class GeometryFormatError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`Geometry ${url} has an unsupported format: ${reason}`);
    this.name = 'GeometryFormatError';
  }
}

/** The browser or GPU lacks a capability a module needs (float render targets, WebGL 2). */
export class UnsupportedFeatureError extends Error {
  constructor(
    readonly feature: string,
    readonly reason: string,
  ) {
    super(`${feature} is not supported: ${reason}`);
    this.name = 'UnsupportedFeatureError';
  }
}

/** An optional peer dependency a module needs is not installed or failed to initialise. */
export class MissingDependencyError extends Error {
  constructor(
    readonly packageName: string,
    readonly feature: string,
    readonly reason: string,
  ) {
    super(`${feature} needs the "${packageName}" package: ${reason}`);
    this.name = 'MissingDependencyError';
  }
}

/** No route matches a path and the router has no `notFound` route. */
export class RouteNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`No route matches "${path}"`);
    this.name = 'RouteNotFoundError';
  }
}
