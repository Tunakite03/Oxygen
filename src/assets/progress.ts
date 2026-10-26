/**
 * Weighted load progress: each named stage owns a share of the bar and reports `loaded / total` items. The combined
 * value only ever increases, so out-of-order completions never move the bar backwards.
 */
export interface LoadProgress {
  report(stage: string, loaded: number, total: number): void;
  readonly value: number;
}

export function createLoadProgress(weights: Readonly<Record<string, number>>, onChange: (value: number) => void): LoadProgress {
  const entries = Object.entries(weights);
  if (!entries.length) throw new Error('createLoadProgress needs at least one stage');
  for (const [name, w] of entries) if (!(w > 0) || !Number.isFinite(w)) throw new Error(`Load stage "${name}" needs a positive weight, got ${w}`);
  const sum = entries.reduce((s, [, w]) => s + w, 0);
  const done = new Map<string, number>(entries.map(([name]) => [name, 0]));
  let value = 0;
  return {
    report(stage, loaded, total) {
      if (!done.has(stage)) throw new Error(`Unknown load stage "${stage}"`);
      if (!(total > 0)) throw new Error(`Load stage "${stage}" reported a non-positive total ${total}`);
      done.set(stage, Math.max(done.get(stage) ?? 0, Math.min(Math.max(loaded / total, 0), 1)));
      const next = entries.reduce((s, [name, w]) => s + (w / sum) * (done.get(name) ?? 0), 0);
      if (next <= value) return;
      value = next;
      onChange(value);
    },
    get value() {
      return value;
    },
  };
}
