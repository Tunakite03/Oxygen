/** Process-wide event bus and observable key/value state store. */
type Listener = (value: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
const store = new Map<string, unknown>();

export function emit(name: string, value?: unknown): void {
  const set = listeners.get(name);
  if (set) for (const l of [...set]) l(value);
}

export function listen<T = unknown>(name: string, cb: (value: T) => void): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  const l = cb as Listener;
  set.add(l);
  return () => set.delete(l);
}

export function setState(name: string, value: unknown): void {
  const prev = store.get(name);
  store.set(name, value);
  if (prev !== value) emit(`state:${name}`, value);
}

export function getState<T>(name: string): T | undefined {
  return store.get(name) as T | undefined;
}

export function requireState<T>(name: string): T {
  if (!store.has(name)) throw new Error(`App state "${name}" read before it was set`);
  return store.get(name) as T;
}

/** Calls `cb` now (if set) and on every change. */
export function bindState<T>(name: string, cb: (value: T) => void): () => void {
  if (store.has(name)) cb(store.get(name) as T);
  return listen<T>(`state:${name}`, cb);
}

/** Resolves once the state has a value. */
export function whenState<T>(name: string): Promise<T> {
  if (store.has(name)) return Promise.resolve(store.get(name) as T);
  return new Promise((resolve) => {
    const off = listen<T>(`state:${name}`, (v) => {
      off();
      resolve(v);
    });
  });
}
