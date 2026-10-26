import { RouteNotFoundError } from '../core/errors';
import { emit, setState } from '../core/events';
import { buildPath, compilePath, matchPath } from './path';
import type { CompiledPath } from './path';

/**
 * Client-side router with page transitions. Routes map path patterns to views; a navigation resolves the target,
 * updates the URL, then runs the outgoing view's `leave` and the incoming view's `load` / `enter` in the order the
 * transition mode sets. The newest navigation wins: starting one aborts the `signal` of the one in flight, and an
 * outgoing view is never left twice. A view whose route stays the same but whose parameters change gets `update`
 * instead of leave + enter when it defines it.
 *
 * Same-origin `<a>` clicks are intercepted unless the link has `target`, `download`, `rel="external"` or
 * `data-router-ignore`, or a modifier key is held.
 *
 * Published: state `Router/route` (the committed `RouteMatch`), `Router/navigating` (boolean);
 * event `Router/change` with `{ from, to }` when a navigation commits.
 */
export interface RouteMatch {
  readonly name: string;
  /** Path inside the router, without the base or hash prefix. */
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly hash: string;
  readonly route: RouteDefinition;
}

export type NavigationDirection = 'initial' | 'forward' | 'back' | 'replace';

export interface TransitionContext {
  readonly from: RouteMatch | null;
  readonly to: RouteMatch;
  readonly direction: NavigationDirection;
  /** Aborted when a newer navigation starts; stop long animations and loads when it fires. */
  readonly signal: AbortSignal;
}

export interface RouteView {
  /** Fetches what the view needs before it enters. In `out-in` mode it runs while the old view leaves. */
  load?(context: TransitionContext): Promise<void> | void;
  enter(context: TransitionContext): Promise<void> | void;
  leave?(context: TransitionContext): Promise<void> | void;
  /** Same route, new parameters or query. Without it the view leaves and enters again. */
  update?(context: TransitionContext): Promise<void> | void;
}

export interface RouteDefinition {
  name: string;
  path: string;
  /** Document title when the route commits. */
  title?: string | ((match: RouteMatch) => string);
  /** Creates the view. Called once per route and cached; may import code lazily. */
  view: () => RouteView | Promise<RouteView>;
}

export type TransitionMode =
  /** Old view leaves (while the new one loads), then the new view enters. */
  | 'out-in'
  /** New view loads, then leave and enter run together. */
  | 'cross';

export interface RouterOptions {
  routes: readonly RouteDefinition[];
  /** Matches any path no route matches. Without it unknown paths throw `RouteNotFoundError`. */
  notFound?: RouteDefinition;
  /** `history` uses real paths (the server must serve the app for each), `hash` uses `#/path`. Default history. */
  mode?: 'history' | 'hash';
  /** Path prefix of the app in history mode, e.g. `/app`. Default ''. */
  base?: string;
  transition?: TransitionMode;
  /** Intercept same-origin link clicks. Default true. */
  interceptLinks?: boolean;
  /** Creates a link's view on hover so its code is ready when clicked. Default true. */
  prefetch?: boolean;
  /** Element focused after each navigation (given `tabindex="-1"` if needed), for screen readers. */
  focusSelector?: string;
  /** Element whose clicks are intercepted. Default document. */
  root?: Document | HTMLElement;
}

export type NavigationResult =
  | { status: 'completed'; match: RouteMatch }
  /** A newer navigation took over. */
  | { status: 'aborted'; match: RouteMatch }
  /** The target is the current location. */
  | { status: 'unchanged'; match: RouteMatch };

export interface NavigateOptions {
  replace?: boolean;
  /** Runs the transition even when the target is the current location. */
  force?: boolean;
}

interface CompiledRoute {
  definition: RouteDefinition;
  compiled: CompiledPath;
}

interface HistoryState {
  oxygenIndex: number;
}

function isHistoryState(value: unknown): value is HistoryState {
  return typeof value === 'object' && value !== null && typeof (value as { oxygenIndex?: unknown }).oxygenIndex === 'number';
}

/** Decoded pathname, or null when it contains a malformed percent-escape (nothing can match such a path). */
function decodePathname(pathname: string): string | null {
  try {
    return decodeURI(pathname);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

export class Router {
  private readonly routes: CompiledRoute[];
  private readonly mode: 'history' | 'hash';
  private readonly base: string;
  private readonly transitionMode: TransitionMode;
  private readonly views = new Map<string, Promise<RouteView>>();
  private readonly cleanup: (() => void)[] = [];
  private controller: AbortController | null = null;
  private shown: { match: RouteMatch; view: RouteView } | null = null;
  private leaving: Promise<void> = Promise.resolve();
  private index = 0;
  private started = false;
  current: RouteMatch | null = null;

  constructor(private readonly options: RouterOptions) {
    const names = new Set<string>();
    for (const r of options.routes) {
      if (names.has(r.name)) throw new Error(`Duplicate route name "${r.name}"`);
      names.add(r.name);
    }
    this.routes = options.routes.map((definition) => ({ definition, compiled: compilePath(definition.path) }));
    this.mode = options.mode ?? 'history';
    this.base = (options.base ?? '').replace(/\/+$/, '');
    this.transitionMode = options.transition ?? 'out-in';
  }

  /** True while a navigation is running. */
  get busy(): boolean {
    return this.controller !== null;
  }

  /** Matches a router path (`/work/a?x=1#top`). Throws `RouteNotFoundError` when nothing matches. */
  resolve(target: string): RouteMatch {
    const url = new URL(target, 'http://router.local');
    const decoded = decodePathname(url.pathname);
    if (decoded !== null) {
      for (const { definition, compiled } of this.routes) {
        const params = matchPath(compiled, url.pathname);
        if (params) return { name: definition.name, path: decoded, params, query: url.searchParams, hash: url.hash, route: definition };
      }
    }
    const path = decoded ?? url.pathname;
    if (this.options.notFound) return { name: this.options.notFound.name, path, params: {}, query: url.searchParams, hash: url.hash, route: this.options.notFound };
    throw new RouteNotFoundError(path);
  }

  /** Router path of a named route. */
  path(name: string, params: Readonly<Record<string, string | number>> = {}): string {
    const route = this.routes.find((r) => r.definition.name === name);
    if (!route) throw new Error(`Unknown route "${name}"`);
    return buildPath(route.definition.path, params);
  }

  /** `href` for a named route, with the base or hash prefix. */
  href(name: string, params: Readonly<Record<string, string | number>> = {}): string {
    return this.toHref(this.path(name, params));
  }

  private toHref(path: string): string {
    return this.mode === 'hash' ? `#${path}` : `${this.base}${path}`;
  }

  /** The router path of the current document location, or null when it is outside the base. */
  locationPath(): string | null {
    if (this.mode === 'hash') {
      const hash = window.location.hash.slice(1);
      return hash.startsWith('/') ? hash : '/';
    }
    const { pathname, search, hash } = window.location;
    if (this.base && pathname !== this.base && !pathname.startsWith(`${this.base}/`)) return null;
    return `${pathname.slice(this.base.length) || '/'}${search}${hash}`;
  }

  /** Resolves the current location, enters its view and starts listening to history and link clicks. */
  async start(): Promise<NavigationResult> {
    if (this.started) throw new Error('Router already started');
    this.started = true;
    const onPop = (): void => {
      const path = this.locationPath();
      if (path === null) return;
      const state: unknown = window.history.state;
      const index = isHistoryState(state) ? state.oxygenIndex : this.index + 1;
      const direction: NavigationDirection = index < this.index ? 'back' : 'forward';
      this.index = index;
      void this.run(this.resolve(path), direction);
    };
    const popEvent = this.mode === 'hash' ? 'hashchange' : 'popstate';
    window.addEventListener(popEvent, onPop);
    this.cleanup.push(() => window.removeEventListener(popEvent, onPop));
    if (this.options.interceptLinks ?? true) this.listenToLinks();
    const state: unknown = window.history.state;
    this.index = isHistoryState(state) ? state.oxygenIndex : 0;
    window.history.replaceState({ ...(typeof state === 'object' && state ? state : {}), oxygenIndex: this.index }, '');
    return this.run(this.resolve(this.locationPath() ?? '/'), 'initial');
  }

  /** Navigates to a router path (`/work/a`). Resolves when the transition finishes or is superseded. */
  async navigate(target: string, options: NavigateOptions = {}): Promise<NavigationResult> {
    if (!this.started) throw new Error('Router.navigate called before start');
    const match = this.resolve(target);
    const full = `${match.path}${match.query.size ? `?${match.query.toString()}` : ''}${match.hash}`;
    if (!options.force && this.current && this.sameLocation(this.current, match)) return { status: 'unchanged', match: this.current };
    if (options.replace) window.history.replaceState({ oxygenIndex: this.index }, '', this.toHref(full));
    else window.history.pushState({ oxygenIndex: ++this.index }, '', this.toHref(full));
    return this.run(match, options.replace ? 'replace' : 'forward');
  }

  /** Steps back in history; the transition runs when the browser reports the change. */
  back(): void {
    window.history.back();
  }

  private sameLocation(a: RouteMatch, b: RouteMatch): boolean {
    return a.path === b.path && a.query.toString() === b.query.toString() && a.hash === b.hash;
  }

  private view(route: RouteDefinition): Promise<RouteView> {
    let view = this.views.get(route.name);
    if (!view) {
      view = Promise.resolve(route.view());
      // A failed factory is retried on the next navigation instead of caching the rejection.
      view.catch(() => this.views.delete(route.name));
      this.views.set(route.name, view);
    }
    return view;
  }

  private async run(to: RouteMatch, direction: NavigationDirection): Promise<NavigationResult> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    setState('Router/navigating', true);
    const context: TransitionContext = { from: this.current, to, direction, signal: controller.signal };
    const aborted = (): boolean => controller.signal.aborted;
    try {
      const outgoing = this.shown;
      if (outgoing && outgoing.match.route === to.route && outgoing.view.update) {
        this.commit(to);
        this.shown = { match: to, view: outgoing.view };
        await outgoing.view.update(context);
        return this.finish(controller, to);
      }
      const leave = (): Promise<void> => {
        if (!outgoing) return this.leaving;
        this.shown = null;
        const pending = this.leaving.then(() => outgoing.view.leave?.(context));
        this.leaving = pending.catch(() => undefined);
        return pending;
      };
      const view = await this.view(to.route);
      if (aborted()) return { status: 'aborted', match: to };
      if (this.transitionMode === 'out-in') {
        await Promise.all([leave(), view.load?.(context)]);
        if (aborted()) return { status: 'aborted', match: to };
        this.commit(to);
        this.shown = { match: to, view };
        await view.enter(context);
      } else {
        await view.load?.(context);
        if (aborted()) return { status: 'aborted', match: to };
        this.commit(to);
        const leaving = leave();
        this.shown = { match: to, view };
        await Promise.all([leaving, view.enter(context)]);
      }
      return this.finish(controller, to);
    } catch (err) {
      if (this.controller === controller) {
        this.controller = null;
        setState('Router/navigating', false);
      }
      throw err;
    }
  }

  private finish(controller: AbortController, to: RouteMatch): NavigationResult {
    if (controller.signal.aborted) return { status: 'aborted', match: to };
    this.controller = null;
    setState('Router/navigating', false);
    this.focus();
    return { status: 'completed', match: to };
  }

  private commit(to: RouteMatch): void {
    const from = this.current;
    this.current = to;
    const title = to.route.title;
    if (title !== undefined) document.title = typeof title === 'function' ? title(to) : title;
    setState('Router/route', to);
    emit('Router/change', { from, to });
  }

  private focus(): void {
    if (!this.options.focusSelector) return;
    const el = document.querySelector<HTMLElement>(this.options.focusSelector);
    if (!el) return;
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }

  /** Router path a click on `anchor` should navigate to, or null to let the browser handle it. */
  linkTarget(anchor: HTMLAnchorElement): string | null {
    const href = anchor.getAttribute('href');
    if (href === null || anchor.hasAttribute('download') || anchor.hasAttribute('data-router-ignore')) return null;
    const target = anchor.getAttribute('target');
    if (target && target !== '_self') return null;
    if ((anchor.getAttribute('rel') ?? '').split(/\s+/).includes('external')) return null;
    if (this.mode === 'hash') return href.startsWith('#/') ? href.slice(1) : null;
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin) return null;
    // Same-document fragment links keep the browser's anchor scrolling.
    if (url.pathname === window.location.pathname && url.search === window.location.search && url.hash) return null;
    if (this.base && url.pathname !== this.base && !url.pathname.startsWith(`${this.base}/`)) return null;
    return `${url.pathname.slice(this.base.length) || '/'}${url.search}${url.hash}`;
  }

  private listenToLinks(): void {
    const root = this.options.root ?? document;
    const anchorOf = (e: Event): HTMLAnchorElement | null => (e.target instanceof Element ? e.target.closest('a') : null);
    const onClick = (e: Event): void => {
      if (!(e instanceof MouseEvent) || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = anchorOf(e);
      const path = anchor ? this.linkTarget(anchor) : null;
      if (path === null) return;
      let match: RouteMatch;
      try {
        match = this.resolve(path);
      } catch (err) {
        if (err instanceof RouteNotFoundError) return; // Not ours: let the browser load it.
        throw err;
      }
      e.preventDefault();
      void this.navigate(path).catch((error: unknown) => console.error('[router] navigation failed', { path: match.path, error }));
    };
    const onOver = (e: Event): void => {
      const anchor = anchorOf(e);
      const path = anchor ? this.linkTarget(anchor) : null;
      if (path === null) return;
      try {
        void this.view(this.resolve(path).route).catch(() => undefined);
      } catch {
        // Unknown paths are not prefetched.
      }
    };
    root.addEventListener('click', onClick);
    this.cleanup.push(() => root.removeEventListener('click', onClick));
    if (this.options.prefetch ?? true) {
      root.addEventListener('pointerover', onOver);
      this.cleanup.push(() => root.removeEventListener('pointerover', onOver));
    }
  }

  /** Stops listening; the current view stays on screen. */
  destroy(): void {
    this.controller?.abort();
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
  }
}
