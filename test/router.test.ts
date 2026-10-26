import { afterEach, describe, expect, it } from 'vitest';
import { RouteNotFoundError } from '../src/core/errors';
import { getState, listen } from '../src/core/events';
import { buildPath, compilePath, matchPath } from '../src/router/path';
import { Router } from '../src/router/router';
import type { RouteDefinition, RouteView, TransitionContext } from '../src/router/router';

describe('route paths', () => {
  it('matches static, parameter, optional and wildcard segments', () => {
    expect(matchPath(compilePath('/'), '/')).toEqual({});
    expect(matchPath(compilePath('/about'), '/about/')).toEqual({});
    expect(matchPath(compilePath('/about'), '/about/team')).toBeNull();
    expect(matchPath(compilePath('/work/:slug'), '/work/caf%C3%A9')).toEqual({ slug: 'café' });
    expect(matchPath(compilePath('/:lang?/about'), '/about')).toEqual({});
    expect(matchPath(compilePath('/:lang?/about'), '/fr/about')).toEqual({ lang: 'fr' });
    expect(matchPath(compilePath('/docs/*'), '/docs/a/b')).toEqual({ wildcard: 'a/b' });
    expect(matchPath(compilePath('/work/:slug'), '/work/%E0%A4%A')).toBeNull();
  });

  it('builds paths and rejects malformed patterns', () => {
    expect(buildPath('/work/:slug', { slug: 'a b' })).toBe('/work/a%20b');
    expect(buildPath('/:lang?/about')).toBe('/about');
    expect(() => buildPath('/work/:slug')).toThrow(/Missing parameter/);
    expect(() => compilePath('work')).toThrow(/must start/);
    expect(() => compilePath('/*/x')).toThrow(/last segment/);
    expect(() => compilePath('/:a/:a')).toThrow(/Duplicate/);
  });
});

type Log = string[];

function view(name: string, log: Log, hooks: Partial<Record<'load' | 'enter' | 'leave', (c: TransitionContext) => Promise<void>>> = {}, withUpdate = false): RouteView {
  const v: RouteView = {
    load: async (c) => {
      log.push(`${name}:load`);
      await hooks.load?.(c);
    },
    enter: async (c) => {
      log.push(`${name}:enter`);
      await hooks.enter?.(c);
    },
    leave: async (c) => {
      log.push(`${name}:leave`);
      await hooks.leave?.(c);
    },
  };
  if (withUpdate) v.update = (c) => void log.push(`${name}:update:${c.to.params.slug ?? ''}`);
  return v;
}

let router: Router | null = null;

afterEach(() => {
  router?.destroy();
  router = null;
  window.history.replaceState(null, '', '/');
  document.body.innerHTML = '';
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Router', () => {
  it('enters the initial route, then runs leave and load before enter on navigation', async () => {
    const log: Log = [];
    const routes: RouteDefinition[] = [
      { name: 'home', path: '/', title: 'Home', view: () => view('home', log) },
      { name: 'work', path: '/work/:slug', title: (m) => `Work ${m.params.slug}`, view: () => view('work', log) },
    ];
    router = new Router({ routes });
    const changes: string[] = [];
    const off = listen<{ to: { name: string } }>('Router/change', (e) => changes.push(e.to.name));
    expect((await router.start()).status).toBe('completed');
    const result = await router.navigate('/work/a?x=1');
    off();
    expect(result.status).toBe('completed');
    // Leave and load run together; enter waits for both.
    expect(log.slice(0, 2)).toEqual(['home:load', 'home:enter']);
    expect(new Set(log.slice(2, 4))).toEqual(new Set(['home:leave', 'work:load']));
    expect(log[4]).toBe('work:enter');
    expect(window.location.pathname).toBe('/work/a');
    expect(window.location.search).toBe('?x=1');
    expect(document.title).toBe('Work a');
    expect(changes).toEqual(['home', 'work']);
    expect(getState<{ params: Record<string, string> }>('Router/route')?.params).toEqual({ slug: 'a' });
    expect(getState('Router/navigating')).toBe(false);
    expect((await router.navigate('/work/a?x=1')).status).toBe('unchanged');
    expect(router.href('work', { slug: 'b' })).toBe('/work/b');
  });

  it('lets the newest navigation win without leaving a view twice', async () => {
    const log: Log = [];
    const gate = deferred();
    router = new Router({
      routes: [
        { name: 'home', path: '/', view: () => view('home', log, { leave: () => gate.promise }) },
        { name: 'a', path: '/a', view: () => view('a', log) },
        { name: 'b', path: '/b', view: () => view('b', log) },
      ],
    });
    await router.start();
    const first = router.navigate('/a');
    await Promise.resolve();
    const second = router.navigate('/b');
    gate.resolve();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe('aborted');
    expect(r2.status).toBe('completed');
    expect(log.filter((l) => l === 'home:leave')).toHaveLength(1);
    expect(log).not.toContain('a:enter');
    expect(router.current?.name).toBe('b');
    expect(window.location.pathname).toBe('/b');
  });

  it('aborts the signal of a superseded navigation', async () => {
    const signals: AbortSignal[] = [];
    const gate = deferred();
    router = new Router({
      routes: [
        { name: 'home', path: '/', view: () => ({ enter: () => undefined }) },
        { name: 'slow', path: '/slow', view: () => ({ load: (c) => (signals.push(c.signal), gate.promise), enter: () => undefined }) },
        { name: 'fast', path: '/fast', view: () => ({ enter: () => undefined }) },
      ],
    });
    await router.start();
    const slow = router.navigate('/slow');
    await new Promise((r) => setTimeout(r, 0));
    const fast = router.navigate('/fast');
    expect(signals[0]?.aborted).toBe(true);
    gate.resolve();
    expect((await slow).status).toBe('aborted');
    expect((await fast).status).toBe('completed');
  });

  it('updates in place when only parameters change and the view supports it', async () => {
    const log: Log = [];
    router = new Router({ routes: [{ name: 'work', path: '/work/:slug', view: () => view('work', log, {}, true) }] });
    window.history.replaceState(null, '', '/work/a');
    await router.start();
    await router.navigate('/work/b');
    expect(log).toEqual(['work:load', 'work:enter', 'work:update:b']);
  });

  it('loads first, then leaves and enters together in cross mode', async () => {
    const log: Log = [];
    router = new Router({
      transition: 'cross',
      routes: [
        { name: 'home', path: '/', view: () => view('home', log) },
        { name: 'about', path: '/about', view: () => view('about', log) },
      ],
    });
    await router.start();
    log.length = 0;
    await router.navigate('/about');
    expect(log[0]).toBe('about:load');
    expect(new Set(log.slice(1))).toEqual(new Set(['home:leave', 'about:enter']));
  });

  it('falls back to notFound or throws RouteNotFoundError', async () => {
    router = new Router({ routes: [{ name: 'home', path: '/', view: () => ({ enter: () => undefined }) }] });
    expect(() => router?.resolve('/nope')).toThrow(RouteNotFoundError);
    const withFallback = new Router({ routes: [], notFound: { name: '404', path: '/', view: () => ({ enter: () => undefined }) } });
    expect(withFallback.resolve('/nope').name).toBe('404');
  });

  it('treats a malformed percent-escape as unmatched instead of throwing URIError', async () => {
    const plain = new Router({ routes: [{ name: 'home', path: '/', view: () => ({ enter: () => undefined }) }] });
    expect(() => plain.resolve('/work/%E0%A4%A')).toThrow(RouteNotFoundError);
    const withFallback = new Router({ routes: [], notFound: { name: '404', path: '/', view: () => ({ enter: () => undefined }) } });
    expect(withFallback.resolve('/work/%E0%A4%A')).toMatchObject({ name: '404', path: '/work/%E0%A4%A' });

    router = new Router({ routes: [{ name: 'home', path: '/', view: () => ({ enter: () => undefined }) }] });
    await router.start();
    const anchor = document.createElement('a');
    anchor.setAttribute('href', '/work/%E0%A4%A');
    document.body.appendChild(anchor);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    expect(() => anchor.dispatchEvent(click)).not.toThrow();
    expect(click.defaultPrevented).toBe(false);
  });

  it('intercepts plain same-origin links only', async () => {
    router = new Router({
      routes: [
        { name: 'home', path: '/', view: () => ({ enter: () => undefined }) },
        { name: 'about', path: '/about', view: () => ({ enter: () => undefined }) },
      ],
    });
    await router.start();
    const link = (attrs: Record<string, string>): HTMLAnchorElement => {
      const a = document.createElement('a');
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
      document.body.appendChild(a);
      return a;
    };
    expect(router.linkTarget(link({ href: '/about?x=1' }))).toBe('/about?x=1');
    expect(router.linkTarget(link({ href: 'https://example.com/about' }))).toBeNull();
    expect(router.linkTarget(link({ href: '/about', target: '_blank' }))).toBeNull();
    expect(router.linkTarget(link({ href: '/about', download: '' }))).toBeNull();
    expect(router.linkTarget(link({ href: '/about', rel: 'noopener external' }))).toBeNull();
    expect(router.linkTarget(link({ href: '/about', 'data-router-ignore': '' }))).toBeNull();
    expect(router.linkTarget(link({ href: '#section' }))).toBeNull();

    const anchor = link({ href: '/about' });
    const changed = new Promise<void>((resolve) => {
      const off = listen('Router/change', () => (off(), resolve()));
    });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await changed;
    expect(router.current?.name).toBe('about');
    const modified = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    link({ href: '/' }).dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
  });

  it('uses #/paths in hash mode and follows hash changes as history moves', async () => {
    const log: Log = [];
    router = new Router({
      mode: 'hash',
      routes: [
        { name: 'home', path: '/', view: () => view('home', log) },
        { name: 'about', path: '/about', view: () => view('about', log) },
      ],
    });
    await router.start();
    expect(router.href('about')).toBe('#/about');
    await router.navigate('/about');
    expect(window.location.hash).toBe('#/about');
    const back = new Promise<void>((resolve) => {
      const off = listen<{ to: { name: string } }>('Router/change', (e) => {
        if (e.to.name !== 'home') return;
        off();
        resolve();
      });
    });
    window.history.replaceState({ oxygenIndex: 0 }, '', '#/');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await back;
    expect(router.current?.name).toBe('home');
  });
});
