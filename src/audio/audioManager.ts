import { onFrame } from '../core/loop';
import { clamp, range } from '../core/math';
import { device } from '../core/stage';
import { tween } from '../core/tween';

/**
 * Web Audio layer: a master/main gain pair that resumes on the first user gesture and ducks while the window is
 * blurred, decoded tracks with loop / one-shot playback, wet/dry effect chains (low-pass, stereo pan), equal-power
 * cross-fades and a frequency analyser.
 */

/** Smoothing time constant (s) for gain changes. */
export const AUDIO_SMOOTHING = 0.02;

/** `ogg` where the browser can play it, else `mp3`. */
export function preferredAudioFormat(): 'ogg' | 'mp3' {
  return document.createElement('audio').canPlayType('audio/ogg') !== '' ? 'ogg' : 'mp3';
}

export class AudioLoadError extends Error {
  constructor(id: string, url: string, reason: string) {
    super(`Audio "${id}" failed to load from ${url}: ${reason}`);
    this.name = 'AudioLoadError';
  }
}

export interface PlayOptions {
  duration?: number;
  loop?: boolean;
  playOnce?: boolean;
  startFrom?: number | null;
  stopTo?: number | null;
  noTween?: boolean;
  volume?: number;
  allowSimultaneous?: boolean;
}

type CompleteListener = (id: string) => void;

/** Decoded buffer + gain node, looping or one-shot sources and completion events. */
export class AudioTrack {
  readonly gain: GainNode;
  readonly baseGain: number;
  readonly ready: Promise<void>;
  buffer: AudioBuffer | null = null;
  loaded = false;
  playing = false;
  private stopping: Promise<void> | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private startedAt = 0;
  startFrom = 0;
  private stopTo: number | null = null;
  private shouldLoop = false;
  private loopCounter = 0;
  private loopStart = 0;
  private loopEnd = 0;
  private offCheck: (() => void) | null = null;
  private readonly completeListeners = new Set<CompleteListener>();
  readonly fade = { value: 0 };

  constructor(
    readonly id: string,
    private readonly ctx: AudioContext,
    url: string,
    options: { baseGain?: number; needsTrimming?: boolean },
  ) {
    this.baseGain = options.baseGain ?? 1;
    this.gain = ctx.createGain();
    this.ready = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new AudioLoadError(id, url, `HTTP ${response.status}`);
      const data = await response.arrayBuffer();
      this.buffer = await ctx.decodeAudioData(data);
      if (options.needsTrimming) {
        const { loopStart, loopEnd } = trimBounds(this.buffer);
        this.loopStart = loopStart + 0.05;
        this.loopEnd = loopEnd;
      }
      this.loaded = true;
    })();
  }

  onComplete(cb: CompleteListener): () => void {
    this.completeListeners.add(cb);
    return () => this.completeListeners.delete(cb);
  }

  get currentTime(): number {
    return this.ctx.currentTime - this.startedAt + this.startFrom;
  }

  private check = (): void => {
    if (!this.buffer) return;
    const current = this.currentTime;
    const hasPlayedOnce = current >= (this.stopTo || this.buffer.duration);
    const counter = Math.floor(current / this.buffer.duration);
    if (!hasPlayedOnce) return;
    for (const l of [...this.completeListeners]) l(this.id);
    if (this.shouldLoop) {
      if (counter !== this.loopCounter) {
        this.loopCounter = counter;
        this.startFrom = 0;
      }
    } else void this.stop({ duration: 0, clearTimeStamps: true });
  };

  private removeSources(): void {
    for (const s of this.sources) {
      s.stop();
      s.disconnect();
    }
    this.sources = [];
  }

  async play(o: PlayOptions = {}): Promise<void> {
    const duration = o.duration ?? 500;
    const loop = o.loop ?? true;
    const playOnce = o.playOnce ?? false;
    const allowSimultaneous = o.allowSimultaneous ?? false;
    let volume = o.volume ?? this.baseGain;
    if (this.playing && !playOnce && !allowSimultaneous) return;
    if (Number.isNaN(volume)) throw new Error(`Audio "${this.id}" play volume is NaN`);
    volume = Math.max(0, volume);
    if (playOnce && !allowSimultaneous) void this.stop({ duration: 0, clearTimeStamps: true });
    if (this.stopping && !allowSimultaneous) await this.stopping;
    if (!this.buffer) await this.ready;
    const buffer = this.buffer as AudioBuffer;
    this.startedAt = this.ctx.currentTime;
    if (o.startFrom) this.startFrom = o.startFrom;
    if (o.stopTo) this.stopTo = o.stopTo;
    this.shouldLoop = loop;
    this.loopCounter = 0;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = this.shouldLoop;
    source.loopStart = this.loopStart;
    source.loopEnd = this.loopEnd;
    source.connect(this.gain);
    source.start(0, this.startFrom, playOnce ? buffer.duration : undefined);
    this.playing = true;
    this.sources.push(source);
    this.offCheck?.();
    this.offCheck = onFrame(this.check);
    if (duration !== 0) {
      if (o.noTween) {
        this.gain.gain.value = volume;
        return;
      }
      this.gain.gain.value = 0;
      this.gain.gain.setValueAtTime(volume, this.ctx.currentTime);
      this.gain.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + duration / 1000);
      await tween(this.fade, { value: volume }, duration, 'linear').promise();
      return;
    }
    this.gain.gain.value = 1;
  }

  async stop({ duration = 0, clearTimeStamps = true }: { duration?: number; clearTimeStamps?: boolean } = {}): Promise<void> {
    if (this.stopping) await this.stopping;
    if (clearTimeStamps) {
      this.startedAt = 0;
      this.startFrom = 0;
      this.loopCounter = 0;
    }
    this.playing = false;
    this.offCheck?.();
    this.offCheck = null;
    if (duration === 0) {
      this.removeSources();
      return;
    }
    this.gain.gain.setValueAtTime(this.gain.gain.value, this.ctx.currentTime);
    this.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + duration / 1000);
    this.stopping = tween(this.fade, { value: 0 }, duration, 'linear')
      .onComplete(() => this.removeSources())
      .promise()
      .finally(() => (this.stopping = null));
    await this.stopping;
  }
}

function trimBounds(buffer: AudioBuffer, threshold = 0.01): { loopStart: number; loopEnd: number } {
  let first: number | null = null;
  let last: number | null = null;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = new Float32Array(buffer.length);
    buffer.copyFromChannel(data, c);
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i] as number) > threshold) {
        if (i < (first ?? Infinity)) first = i;
        break;
      }
    }
    for (let i = data.length - 1; i >= 0; i--) {
      if (Math.abs(data[i] as number) > threshold) {
        if (i > (last ?? -1)) last = i;
        break;
      }
    }
  }
  return { loopStart: (first ?? 0) / buffer.sampleRate, loopEnd: (last ?? 0) / buffer.sampleRate };
}

/** Wet/dry chain of effects (optional low-pass, optional stereo pan) feeding the main gain. */
export class EffectChain {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly wetGain: GainNode;
  private readonly dryGain: GainNode;
  private wet = 1;
  private dry = 0;
  private overall = 1;
  readonly filter: BiquadFilterNode | null;
  readonly panner: StereoPannerNode | null;

  constructor(
    private readonly ctx: AudioContext,
    opts: { filterFrequency?: number; pan?: number; mix?: number },
  ) {
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    const effectInput = ctx.createGain();
    const effectOutput = ctx.createGain();
    this.wetGain = ctx.createGain();
    this.dryGain = ctx.createGain();
    this.input.connect(this.dryGain);
    this.dryGain.connect(this.output);
    this.input.connect(effectInput);
    this.filter = null;
    this.panner = null;
    let tail: AudioNode = effectInput;
    if (opts.filterFrequency !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      if (opts.filterFrequency) f.frequency.value = opts.filterFrequency;
      tail.connect(f);
      tail = f;
      this.filter = f;
    }
    if (opts.pan !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = opts.pan;
      tail.connect(p);
      tail = p;
      this.panner = p;
    }
    tail.connect(effectOutput);
    effectOutput.connect(this.wetGain);
    this.wetGain.connect(this.output);
    this.mixWetDry(opts.mix ?? 1);
  }

  mixWetDry(value: number): void {
    const blend = (clamp(value, 0, 1) * Math.PI) / 2;
    this.wet = Math.sin(blend);
    this.dry = Math.cos(blend);
    const t = this.ctx.currentTime;
    this.wetGain.gain.setValueAtTime(this.wet * this.overall, t);
    this.dryGain.gain.setValueAtTime(this.dry * this.overall, t);
  }

  setGain(value: number, smoothing = 0): void {
    const t = this.ctx.currentTime;
    if (smoothing) {
      this.wetGain.gain.setTargetAtTime(value * this.wet, t, smoothing);
      this.dryGain.gain.setTargetAtTime(value * this.dry, t, smoothing);
    } else {
      this.wetGain.gain.setValueAtTime(value * this.wet, t);
      this.dryGain.gain.setValueAtTime(value * this.dry, t);
    }
    this.overall = value;
  }

  setFrequency(target: number, smoothing = 0.1): void {
    if (!this.filter) throw new Error('setFrequency called on an effect chain without a filter');
    if (smoothing) this.filter.frequency.setTargetAtTime(target, this.ctx.currentTime, smoothing);
    else this.filter.frequency.value = target;
  }

  setPan(value: number, smoothing = 0.2): void {
    if (!this.panner) throw new Error('setPan called on an effect chain without a panner');
    const target = clamp(value, -1, 1);
    if (smoothing) this.panner.pan.setTargetAtTime(target, this.ctx.currentTime, smoothing);
    else this.panner.pan.value = target;
  }
}

type MuteListener = (muted: boolean) => void;

export class AudioManager {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly main: GainNode;
  private readonly pool = new Map<string, AudioTrack>();
  private readonly chains = new Map<string, EffectChain>();
  private analyser: AnalyserNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  muted = false;
  private readonly muteListeners = new Set<MuteListener>();

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.main = this.ctx.createGain();
    this.main.connect(this.master);
    for (const evt of ['auxclick', 'click', 'contextmenu', 'dblclick', 'keydown', 'keyup', 'mousedown', 'mouseup', 'touchend']) {
      document.addEventListener(evt, () => void this.tryResume(), { capture: true, passive: true });
    }
    window.addEventListener('blur', () => this.onVisibility(false));
    window.addEventListener('focus', () => this.onVisibility(true));
  }

  private async tryResume(): Promise<void> {
    if (this.ctx.state !== 'suspended') return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.main.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.value = 0;
    this.main.gain.value = 0;
    await this.ctx.resume();
    this.master.gain.setTargetAtTime(1, this.ctx.currentTime + 0.4, 0.5);
    this.main.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime + 0.4, 0.5);
  }

  private onVisibility(visible: boolean): void {
    if (!visible) {
      if (this.ctx.state === 'suspended') return;
      this.master.gain.cancelScheduledValues(0);
      if (device.mobile) {
        this.master.gain.value = 0;
        void this.ctx.suspend();
      } else this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    } else if (this.ctx.state === 'suspended') void this.tryResume();
    else {
      this.master.gain.cancelScheduledValues(0);
      this.master.gain.setTargetAtTime(1, this.ctx.currentTime, 0.05);
    }
  }

  waitRunning(): Promise<void> {
    if (this.ctx.state === 'running') return Promise.resolve();
    return new Promise((resolve) => {
      const off = onFrame(() => {
        if (this.ctx.state === 'running') {
          off();
          resolve();
        }
      });
    });
  }

  registerEffectChain(id: string, chain: EffectChain): void {
    this.chains.set(id, chain);
    chain.output.connect(this.main);
  }

  /** Decodes `url` as track `id`, routed through effect chain `effectChainId` (else `general`, else the main gain). */
  registerAudio(id: string, url: string, options: { baseGain?: number; needsTrimming?: boolean; effectChainId?: string } = {}): Promise<void> {
    const node = new AudioTrack(id, this.ctx, url, options);
    this.pool.set(id, node);
    const out = this.chains.get(options.effectChainId ?? 'general')?.input ?? this.main;
    node.gain.connect(out);
    return node.ready;
  }

  async play(id: string, options: PlayOptions = {}): Promise<void> {
    const node = this.requireAudio(id);
    if (this.ctx.state !== 'running') await this.waitRunning();
    if (!node.loaded) await node.ready;
    await node.play(options);
  }

  getAudio(id: string): AudioTrack | undefined {
    return this.pool.get(id);
  }

  requireAudio(id: string): AudioTrack {
    const node = this.pool.get(id);
    if (!node) throw new Error(`No audio registered with id ${id}`);
    return node;
  }

  effectChains(): [string, EffectChain][] {
    return [...this.chains];
  }

  getEffectChain(id: string): EffectChain {
    const chain = this.chains.get(id);
    if (!chain) throw new Error(`No effect chain registered with id ${id}`);
    return chain;
  }

  onMute(cb: MuteListener): void {
    this.muteListeners.add(cb);
  }

  mute(bool: boolean, { duration = 0 }: { duration?: number } = {}): void {
    if (this.muted === bool) return;
    this.muted = bool;
    const target = bool ? 0 : 1;
    if (duration) {
      const t = this.ctx.currentTime + duration / 1000;
      this.master.gain.setTargetAtTime(target, t, 0.25);
      this.main.gain.setTargetAtTime(target, t, 0.25);
    } else {
      this.master.gain.value = target;
      this.main.gain.value = target;
    }
    for (const l of this.muteListeners) l(bool);
  }

  blend(fromId: string, toId: string, mix: number): void {
    const target = clamp(mix, 0, 1);
    const from = this.requireAudio(fromId);
    const to = this.requireAudio(toId);
    const b = (target * Math.PI) / 2;
    const now = this.ctx.currentTime;
    from.gain.gain.setTargetAtTime(Math.cos(b) * from.baseGain, now, AUDIO_SMOOTHING);
    to.gain.gain.setTargetAtTime(Math.sin(b) * to.baseGain, now, AUDIO_SMOOTHING);
  }

  setVolume(id: string, volume: number, { smoothing = AUDIO_SMOOTHING }: { smoothing?: number } = {}): void {
    const node = this.requireAudio(id);
    node.gain.gain.setTargetAtTime(Math.max(volume, 0) * node.baseGain, this.ctx.currentTime, smoothing);
  }

  setupFrequencyAnalyzer(): void {
    if (this.analyser) return;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.main.connect(this.analyser);
    this.frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
  }

  getFrequencies(): { data: Uint8Array; bufferLength: number; sampleRate: number } {
    if (!this.analyser || !this.frequencyData) throw new Error('Frequency analyser not set up');
    this.analyser.getByteFrequencyData(this.frequencyData);
    return { data: this.frequencyData, bufferLength: this.analyser.frequencyBinCount, sampleRate: this.ctx.sampleRate };
  }
}

let instance: AudioManager | null = null;

/** The app's audio manager, created (with its AudioContext) on first use. */
export function audioManager(): AudioManager {
  instance ??= new AudioManager();
  return instance;
}

/** Linear cross-fade position of `progress` between `boundStart` and `boundEnd` (unclamped: <0 before, >1 after). */
export function crossfadeMix(progress: number, { boundStart, boundEnd }: { boundStart: number; boundEnd: number } = { boundStart: 0, boundEnd: 1 }): number {
  if (boundEnd <= boundStart) throw new Error('Cross-fade bounds must have end > start');
  return range(progress, boundStart, boundEnd, 0, 1, false);
}

/**
 * Round-robin variant picker for `<id>_<n>` tracks. The sequence is (value + 1) % count + 1 starting at 1: it visits
 * every variant when `count` is odd and only the odd-numbered ones when it is even (6 → 1, 3, 5, 1, ...).
 */
export class RoundRobin {
  private readonly entries = new Map<string, { count: number; value: number }>();

  add(id: string, count: number): void {
    if (!Number.isInteger(count) || count < 1) throw new Error(`Round robin ${id} needs a positive integer count, got ${count}`);
    this.entries.set(id, { count, value: 1 });
  }

  next(id: string): number {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Round robin has not been set up for ${id}`);
    const result = entry.value;
    entry.value = ((entry.value + 1) % entry.count) + 1;
    return result;
  }
}
