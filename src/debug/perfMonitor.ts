import type * as THREE from 'three';
import { onFrame } from '../core/loop';
import type { GUIFolder } from './gui';

/**
 * Frame statistics: fps and frame time averaged over half a second, plus draw calls, triangles, points and lines
 * summed over every render of the frame (post passes and simulations included), and live GPU resource counts. The
 * renderer's `info.autoReset` is turned off so counts cover the whole frame; they reset after each read.
 */
export interface PerfStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  programs: number;
  geometries: number;
  textures: number;
}

export class PerfMonitor {
  readonly stats: PerfStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, points: 0, lines: 0, programs: 0, geometries: 0, textures: 0 };
  private readonly stop: () => void;
  private frames = 0;
  private elapsed = 0;

  constructor(private readonly renderer: Pick<THREE.WebGLRenderer, 'info'>) {
    renderer.info.autoReset = false;
    this.stop = onFrame((_t, delta) => this.sample(delta), 'postRender');
  }

  /** Records one frame; called by the loop. */
  sample(deltaMs: number): void {
    const info = this.renderer.info;
    this.frames++;
    this.elapsed += deltaMs;
    if (this.elapsed >= 500) {
      this.stats.fps = (this.frames * 1000) / this.elapsed;
      this.stats.frameMs = this.elapsed / this.frames;
      this.frames = 0;
      this.elapsed = 0;
    }
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.points = info.render.points;
    this.stats.lines = info.render.lines;
    this.stats.programs = info.programs?.length ?? 0;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
    info.reset();
  }

  /** Adds an fps graph and the counters to a GUI folder. */
  attach(folder: GUIFolder): void {
    folder.addGraph('fps', () => this.stats.fps, { min: 0, max: 120 });
    folder.addMonitor('frame ms', () => this.stats.frameMs, { digits: 2 });
    folder.addMonitor('draw calls', () => String(this.stats.drawCalls));
    folder.addMonitor('triangles', () => this.stats.triangles.toLocaleString('en-US'));
    folder.addMonitor('points', () => this.stats.points.toLocaleString('en-US'));
    folder.addMonitor('programs', () => String(this.stats.programs));
    folder.addMonitor('geometries', () => String(this.stats.geometries));
    folder.addMonitor('textures', () => String(this.stats.textures));
  }

  destroy(): void {
    this.stop();
    this.renderer.info.autoReset = true;
  }
}
