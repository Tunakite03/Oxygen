import * as THREE from 'three';

export interface VideoTextureOptions {
  src: string;
  poster?: string;
  autoplay?: boolean;
  loop?: boolean;
  muted?: boolean;
  fit?: 'cover' | 'contain' | 'fill';
  targetAspect?: number;
}

export class VideoTextureController {
  readonly video: HTMLVideoElement;
  readonly texture: THREE.VideoTexture;
  readonly ready: Promise<void>;
  posterTexture: THREE.Texture | null = null;
  fit: 'cover' | 'contain' | 'fill';
  targetAspect: number;
  private disposed = false;

  constructor(options: VideoTextureOptions) {
    this.fit = options.fit ?? 'cover';
    this.targetAspect = options.targetAspect ?? 16 / 9;

    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.playsInline = true;
    video.autoplay = options.autoplay ?? true;
    video.loop = options.loop ?? true;
    video.muted = options.muted ?? true;
    video.preload = 'auto';
    video.src = options.src;
    this.video = video;

    const texture = new THREE.VideoTexture(video);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.format = THREE.RGBAFormat;
    texture.generateMipmaps = false;
    this.texture = texture;

    if (options.poster) {
      const loader = new THREE.TextureLoader();
      loader.load(options.poster, (tex) => {
        if (!this.disposed) {
          this.posterTexture = tex;
        }
      });
    }

    this.ready = new Promise((resolve) => {
      if (video.readyState >= 2) {
        this.updateAspectMatrix();
        resolve();
      } else {
        const onLoaded = (): void => {
          video.removeEventListener('loadeddata', onLoaded);
          this.updateAspectMatrix();
          resolve();
        };
        video.addEventListener('loadeddata', onLoaded, { once: true });
      }
    });

    if (options.autoplay ?? true) {
      void this.play();
    }
  }

  updateAspectMatrix(meshAspect = this.targetAspect): void {
    if (this.fit === 'fill' || !this.video.videoWidth || !this.video.videoHeight) return;

    const videoAspect = this.video.videoWidth / this.video.videoHeight;
    this.texture.matrixAutoUpdate = false;
    this.texture.matrix.identity();

    if (this.fit === 'cover') {
      if (meshAspect > videoAspect) {
        // Mesh is wider than video: scale Y
        const scaleY = videoAspect / meshAspect;
        this.texture.matrix.setUvTransform(0, (1 - scaleY) / 2, 1, scaleY, 0, 0.5, 0.5);
      } else {
        // Mesh is taller than video: scale X
        const scaleX = meshAspect / videoAspect;
        this.texture.matrix.setUvTransform((1 - scaleX) / 2, 0, scaleX, 1, 0, 0.5, 0.5);
      }
    } else if (this.fit === 'contain') {
      if (meshAspect > videoAspect) {
        const scaleX = meshAspect / videoAspect;
        this.texture.matrix.setUvTransform((1 - scaleX) / 2, 0, scaleX, 1, 0, 0.5, 0.5);
      } else {
        const scaleY = videoAspect / meshAspect;
        this.texture.matrix.setUvTransform(0, (1 - scaleY) / 2, 1, scaleY, 0, 0.5, 0.5);
      }
    }
  }

  async play(): Promise<void> {
    if (this.disposed) return;
    try {
      await this.video.play();
    } catch {
      // Autoplay with sound restricted, retry muted
      this.video.muted = true;
      try {
        await this.video.play();
      } catch {
        // Video blocked or media unavailable
      }
    }
  }

  pause(): void {
    this.video.pause();
  }

  setMuted(muted: boolean): void {
    this.video.muted = muted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.texture.dispose();
    this.posterTexture?.dispose();
  }
}
