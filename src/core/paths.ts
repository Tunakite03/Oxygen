/** Strips the query string (cache busters, format hints) from an asset reference. */
export function cleanAssetPath(src: string): string {
  return src.split('?')[0] ?? src;
}
