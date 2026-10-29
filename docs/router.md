# Router and page transitions

`Router` maps paths to views and runs page transitions in a fixed order. It updates the URL with the History API
(`mode: 'history'`, real paths) or `#/path` hashes (`mode: 'hash'`, for static hosting without rewrites).

```ts
import { Router } from '@tunakite03/oxygen';

const router = new Router({
  mode: 'history',
  base: '',                          // e.g. '/app' when the site is served under a prefix
  transition: 'out-in',
  focusSelector: 'main',             // focused after each navigation, for screen readers
  routes: [
    { name: 'home', path: '/', title: 'Studio', view: () => homeView },
    { name: 'work', path: '/work/:slug', title: (m) => `${m.params.slug} · Studio`, view: () => import('./work').then((m) => m.view) },
    { name: 'docs', path: '/docs/*', view: () => docsView },
  ],
  notFound: { name: 'notFound', path: '/', view: () => notFoundView },
});
await router.start(); // enters the view of the current URL
```

## Views

```ts
const view: RouteView = {
  async load({ to, signal }) { await fetchAssets(to.params.slug, { signal }); },
  async leave({ signal }) { await fadeOut(signal); },
  async enter({ to, from, direction }) { await fadeIn(); },
  async update({ to }) { await showProject(to.params.slug); }, // optional: same route, new params
};
```

| Mode | Order |
| --- | --- |
| `out-in` (default) | old `leave` and new `load` run together → commit → new `enter` |
| `cross` | new `load` → commit → old `leave` and new `enter` together |

"Commit" sets `router.current`, the document title, state `Router/route` and emits `Router/change` `{ from, to }`.
`Router/navigating` is true while a navigation runs. When the route stays the same and only parameters change, a view
with `update` gets `update` instead of leave + enter.

The newest navigation wins. Starting one aborts `signal` of the one in flight and that navigation resolves
`{ status: 'aborted' }`; a view that already left is not left again. Stop long animations and fetches when the signal
aborts. `navigate` resolves `{ status: 'completed' | 'aborted' | 'unchanged', match }`. Errors thrown by views reject
it.

View factories are called once per route and cached, so `view: () => import(...)` code-splits a page. A factory that
throws is retried on the next navigation.

## Paths

| Pattern | Matches | Params |
| --- | --- | --- |
| `/work/:slug` | `/work/aurora` | `{ slug: 'aurora' }` |
| `/:lang?/about` | `/about`, `/fr/about` | `{}`, `{ lang: 'fr' }` |
| `/docs/*` | `/docs/a/b` | `{ wildcard: 'a/b' }` |

Matching is case-insensitive, ignores a trailing slash and decodes parameters (malformed escapes do not match).
`router.path('work', { slug: 'a b' })` builds `/work/a%20b`; `router.href(...)` adds the base or `#`.
`match.query` is a `URLSearchParams`, `match.hash` the fragment.

## Links

Clicks on `<a>` elements are intercepted when the link is same-origin and inside the base (in hash mode: `href` starts
with `#/`). These are left to the browser: `target` other than `_self`, `download`, `rel="external"`,
`data-router-ignore`, a held modifier key, a non-primary button, and same-page `#fragment` links. Hovering a link
creates its view early (`prefetch: false` turns it off). `interceptLinks: false` disables interception.

Back and forward run transitions with `direction: 'back' | 'forward'`.

## GL page transitions

Combine the router with [`TransitionPass`](post.md#screen-transitions):

```ts
const transition = post.add(new TransitionPass({ effect: 'noise', edgeColor: 0xffa152, edgeIntensity: 3 }), 0);

const view: RouteView = {
  async leave() {
    await transition.capture(); // freeze the old page on screen
  },
  async enter({ to }) {
    buildScene(to);             // render the new page underneath
    await transition.play(1000);
  },
};
```

Respect `prefersReducedMotion()` by passing a duration of 0.
