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
