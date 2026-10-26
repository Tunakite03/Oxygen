import * as THREE from 'three';
import type { GazeCamera } from '../camera/gazeCamera';

/** Shared rendering context. `ScrollStory` assigns it once the pipeline and cameras exist. */
export interface WorldContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: GazeCamera;
  /** The story camera's twin without pointer gaze, for screen-locked layers. */
  fixedCamera: GazeCamera;
  /** Pixel-space overlay scene rendered after the composite. */
  uiScene: THREE.Scene;
  /** Pixel-space overlay rendered into the scene buffer before the composite pass. */
  beforePassesScene: THREE.Scene;
  /** Resolved scene buffer of the frame being drawn, sampled by overlay chrome. */
  sceneTexture: THREE.Texture;
  dpr: number;
}

let ctx: WorldContext | null = null;

export function setWorld(world: WorldContext): void {
  ctx = world;
}

/** Releases the context only if it still belongs to the destroyed story. */
export function clearWorld(camera: GazeCamera): void {
  if (ctx?.camera === camera) ctx = null;
}

export function world(): WorldContext {
  if (!ctx) throw new Error('World accessed before bootstrap assigned it');
  return ctx;
}

/** World units per CSS pixel at the story camera's focal plane, updated by ScrollStory on resize. */
export const units = { perPixelY: 0.0035 };

export function getHeightFromCamera(camera: THREE.PerspectiveCamera, dist: number): number {
  const fov = (camera.fov * Math.PI) / 180;
  return 2 * Math.tan(fov / 2) * dist;
}

export function getWidthFromCamera(camera: THREE.PerspectiveCamera, dist: number): number {
  return getHeightFromCamera(camera, dist) * camera.aspect;
}
