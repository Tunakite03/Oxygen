import * as THREE from 'three';
import { Router, TransitionPass, delay, prefersReducedMotion } from '@tunn/oxygen';
import type { RouteMatch, RouteView, TransitionEffect } from '@tunn/oxygen';
import { createExample, everyFrame } from '../shared/setup';

const { pipeline, camera, post, gui } = createExample('Page transitions');
camera.position.set(0, 0, 5);

// The transition runs first in the stack, on HDR colour, so its glowing edge blooms.
const transition = post.add(new TransitionPass({ effect: 'noise', softness: 0.04, edgeColor: 0xffa152, edgeIntensity: 3, noiseScale: 3.5 }), 0);
const settings = { effect: 'noise' as TransitionEffect, duration: 1100 };
const folder = gui.addFolder('Transition');
folder.addSelect(settings, 'effect', ['noise', 'wipe', 'fade']).onChange((v) => (transition.effect = v as TransitionEffect));
folder.addNumber(settings, 'duration', { min: 200, max: 3000, step: 10 });
folder.addColor(transition.edgeColor, 'edge');
folder.addNumber(transition, 'edgeIntensity', { label: 'edge glow', min: 0, max: 10, step: 0.1 });

const scene = pipeline.scene;
scene.add(new THREE.HemisphereLight(0xffffff, 0x202028, 0.8));
const light = new THREE.PointLight(0xffffff, 40);
light.position.set(3, 3, 4);
scene.add(light);
const subject = new THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>(new THREE.IcosahedronGeometry(1.2, 0), new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.4 }));
subject.position.x = 1.2;
scene.add(subject);

interface Page {
  title: string;
  text: string;
  geometry: () => THREE.BufferGeometry;
  color: number;
  emissive: number;
  background: number;
}

const pages: Record<string, Page> = {
  home: { title: 'Oxygen', text: 'A WebGL engine for creative sites. Pick a page above: the router leaves, loads and enters while the screen dissolves.', geometry: () => new THREE.IcosahedronGeometry(1.2, 0), color: 0xe9e4da, emissive: 0x000000, background: 0x07080a },
  aurora: { title: 'Aurora', text: 'Work page with a route parameter (/work/:slug). Switching between works keeps the URL in sync.', geometry: () => new THREE.TorusGeometry(0.9, 0.32, 48, 160), color: 0x1b2a55, emissive: 0x2f6bff, background: 0x050814 },
  ember: { title: 'Ember', text: 'Same route, another slug. Navigating mid-transition aborts the old one; the newest click wins.', geometry: () => new THREE.OctahedronGeometry(1.3, 0), color: 0x2a140c, emissive: 0xff5a1f, background: 0x0e0605 },
  about: { title: 'About', text: 'Links are intercepted, history works with back and forward, and focus moves to the content after each navigation.', geometry: () => new THREE.TorusKnotGeometry(0.8, 0.22, 200, 24), color: 0xe9e4da, emissive: 0x37d6a0, background: 0x050b09 },
};

const main = document.getElementById('content') as HTMLElement;
const reduced = prefersReducedMotion();

function pageOf(match: RouteMatch): Page {
  if (match.name === 'work') {
    const page = pages[match.params.slug ?? ''];
    if (page) return page;
  }
  return pages[match.name] ?? (pages.home as Page);
}

function show(page: Page): void {
  subject.geometry.dispose();
  subject.geometry = page.geometry();
  const material = subject.material;
  material.color.set(page.color);
  material.emissive.set(page.emissive);
  material.emissiveIntensity = 3;
  pipeline.renderer.setClearColor(page.background, 1);
  main.innerHTML = '';
  const h1 = document.createElement('h1');
  h1.textContent = page.title;
  const p = document.createElement('p');
  p.textContent = page.text;
  main.append(h1, p);
  for (const a of document.querySelectorAll<HTMLAnchorElement>('nav a')) {
    if (a.getAttribute('href') === window.location.hash || (a.getAttribute('href') === '#/' && window.location.hash === '')) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

let first = true;
const view: RouteView = {
  async leave() {
    main.classList.add('is-leaving');
    // Hold the current frame; the new page renders underneath and is revealed by `play`.
    await Promise.all([transition.capture(), delay(reduced ? 0 : 250)]);
  },
  async enter({ to, signal }) {
    show(pageOf(to));
    main.classList.remove('is-leaving');
    if (first) {
      first = false;
      return;
    }
    if (signal.aborted) return;
    await transition.play(reduced ? 0 : settings.duration);
  },
  async update(context) {
    await view.leave?.(context);
    await view.enter(context);
  },
};

const router = new Router({
  mode: 'hash',
  focusSelector: '#content',
  routes: [
    { name: 'home', path: '/', title: 'Page transitions · Oxygen', view: () => view },
    { name: 'work', path: '/work/:slug', title: (m) => `${pages[m.params.slug ?? '']?.title ?? 'Work'} · Oxygen`, view: () => view },
    { name: 'about', path: '/about', title: 'About · Oxygen', view: () => view },
  ],
  notFound: { name: 'notFound', path: '/', title: 'Page transitions · Oxygen', view: () => view },
});
await router.start();

everyFrame((delta) => {
  subject.rotation.x += delta * 0.0003;
  subject.rotation.y += delta * 0.0005;
});

void pipeline.warmUp(camera);
