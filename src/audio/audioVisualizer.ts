import * as THREE from 'three';
import { clamp } from '../core/math';
import { audioManager, type AudioManager } from './audioManager';

export interface AudioBands {
  bass: number;
  mid: number;
  treble: number;
  energy: number;
}

export interface AudioVisualizerOptions {
  /** Fast Fourier Transform size (power of 2: 32..2048). Default 256. */
  fftSize?: number;
  /** Smoothing time constant on AnalyserNode (0..1). Default 0.8. */
  smoothingTimeConstant?: number;
  /** Value smoothing attack coefficient for animations. Default 0.7. */
  attack?: number;
  /** Value smoothing decay coefficient for animations. Default 0.85. */
  decay?: number;
  /** Custom AudioManager instance. Defaults to global audioManager(). */
  manager?: AudioManager;
}

/**
 * AudioVisualizer bridges Web Audio analysis to Three.js shader uniforms and 2D canvas
 * equalizers and waveforms, for audio-reactive scenes.
 */
export class AudioVisualizer {
  readonly fftSize: number;
  readonly analyser: AnalyserNode;
  readonly ctx: AudioContext;

  private readonly frequencyData: Uint8Array<ArrayBuffer>;
  private readonly timeDomainData: Uint8Array<ArrayBuffer>;
  private readonly normalizedFrequencies: Float32Array;

  private rawBass = 0;
  private rawMid = 0;
  private rawTreble = 0;
  private rawEnergy = 0;

  bass = 0;
  mid = 0;
  treble = 0;
  energy = 0;

  readonly attack: number;
  readonly decay: number;

  private synthGain: GainNode | null = null;
  private synthOscillators: OscillatorNode[] = [];
  private isSynthesizing = false;

  constructor(options: AudioVisualizerOptions = {}) {
    this.fftSize = options.fftSize ?? 256;
    this.attack = options.attack ?? 0.7;
    this.decay = options.decay ?? 0.85;

    const mgr = options.manager ?? audioManager();
    this.ctx = (mgr as unknown as { ctx: AudioContext }).ctx;

    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = this.fftSize;
    this.analyser.smoothingTimeConstant = options.smoothingTimeConstant ?? 0.8;

    const binCount = this.analyser.frequencyBinCount;
    this.frequencyData = new Uint8Array(new ArrayBuffer(binCount));
    this.timeDomainData = new Uint8Array(new ArrayBuffer(binCount));
    this.normalizedFrequencies = new Float32Array(binCount);

    // Connect into manager's main output
    const mainNode = (mgr as unknown as { main: GainNode }).main;
    if (mainNode) mainNode.connect(this.analyser);
  }

  /** Direct connect an external AudioNode (e.g. MediaElementSource or Synth) */
  connectSource(source: AudioNode): void {
    source.connect(this.analyser);
  }

  /** Update analytical bands (call once per frame) */
  update(_dt = 16.67): AudioBands {
    this.analyser.getByteFrequencyData(this.frequencyData);
    this.analyser.getByteTimeDomainData(this.timeDomainData);

    const binCount = this.frequencyData.length;
    let sumTotal = 0;
    let sumBass = 0;
    let sumMid = 0;
    let sumTreble = 0;

    // Split frequency spectrum into bands:
    // bin 0..binCount: 0 to sampleRate/2 (typically 0..24000 Hz)
    const bassEnd = Math.max(1, Math.floor(binCount * 0.12)); // ~0-250Hz
    const midEnd = Math.max(bassEnd + 1, Math.floor(binCount * 0.55)); // ~250-4000Hz

    for (let i = 0; i < binCount; i++) {
      const v = this.frequencyData[i]! / 255.0;
      this.normalizedFrequencies[i] = v;
      sumTotal += v;

      if (i < bassEnd) {
        sumBass += v;
      } else if (i < midEnd) {
        sumMid += v;
      } else {
        sumTreble += v;
      }
    }

    this.rawEnergy = sumTotal / binCount;
    this.rawBass = sumBass / bassEnd;
    this.rawMid = sumMid / Math.max(1, midEnd - bassEnd);
    this.rawTreble = sumTreble / Math.max(1, binCount - midEnd);

    // Smooth values with asymmetric attack / decay
    this.bass = this.smooth(this.bass, this.rawBass);
    this.mid = this.smooth(this.mid, this.rawMid);
    this.treble = this.smooth(this.treble, this.rawTreble);
    this.energy = this.smooth(this.energy, this.rawEnergy);

    return { bass: this.bass, mid: this.mid, treble: this.treble, energy: this.energy };
  }

  private smooth(current: number, target: number): number {
    const factor = target > current ? this.attack : this.decay;
    return current * factor + target * (1.0 - factor);
  }

  /** Assigns or updates uniforms on any Three.js ShaderMaterial or Material */
  updateUniforms(uniforms: Record<string, THREE.IUniform>): void {
    if (uniforms.uAudioBass) uniforms.uAudioBass.value = this.bass;
    if (uniforms.uAudioMid) uniforms.uAudioMid.value = this.mid;
    if (uniforms.uAudioTreble) uniforms.uAudioTreble.value = this.treble;
    if (uniforms.uAudioEnergy) uniforms.uAudioEnergy.value = this.energy;
  }

  /** Render oscilloscope waveform line to a 2D canvas context */
  renderWaveform(ctx: CanvasRenderingContext2D, width: number, height: number, strokeColor = '#00f5a0', lineWidth = 1.5): void {
    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeColor;

    const sliceWidth = width / (this.timeDomainData.length - 1);
    let x = 0;

    for (let i = 0; i < this.timeDomainData.length; i++) {
      const v = this.timeDomainData[i]! / 128.0; // 0..2, 1 is center
      const y = (v * height) / 2;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);

      x += sliceWidth;
    }

    ctx.stroke();
  }

  /** Render equalizer bars to a 2D canvas context */
  renderEqualizer(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    barCount = 16,
    barColor = '#00f5a0',
    spacing = 2,
  ): void {
    ctx.clearRect(0, 0, width, height);
    const totalSpacing = (barCount - 1) * spacing;
    const barWidth = Math.max(1, (width - totalSpacing) / barCount);
    const step = Math.floor(this.frequencyData.length / barCount);

    ctx.fillStyle = barColor;

    for (let i = 0; i < barCount; i++) {
      let bandSum = 0;
      for (let j = 0; j < step; j++) {
        bandSum += this.frequencyData[i * step + j]! / 255.0;
      }
      const val = clamp(bandSum / step, 0.05, 1.0);
      const barHeight = val * height;
      const x = i * (barWidth + spacing);
      const y = height - barHeight;

      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }

  /**
   * Built-in ambient drone & melodic synthesizer for immersive offline / dynamic audio
   */
  startAmbientDrone(rootFreq = 110): void {
    if (this.isSynthesizing) return;
    if (this.ctx.state === 'suspended') void this.ctx.resume();

    const master = this.ctx.createGain();
    master.gain.setValueAtTime(0.001, this.ctx.currentTime);
    master.gain.exponentialRampToValueAtTime(0.12, this.ctx.currentTime + 3.0);
    master.connect(this.analyser);
    master.connect(this.ctx.destination);
    this.synthGain = master;

    // Harmonic chords (Root, 5th, Octave, 9th)
    const ratios = [1.0, 1.498, 2.0, 2.245];
    this.synthOscillators = ratios.map((ratio, idx) => {
      const osc = this.ctx.createOscillator();
      const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      const oscGain = this.ctx.createGain();

      osc.type = idx % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(rootFreq * ratio, this.ctx.currentTime);

      oscGain.gain.setValueAtTime(0.25 / ratios.length, this.ctx.currentTime);

      if (panner) {
        panner.pan.setValueAtTime((idx / ratios.length) * 1.6 - 0.8, this.ctx.currentTime);
        osc.connect(panner);
        panner.connect(oscGain);
      } else {
        osc.connect(oscGain);
      }

      oscGain.connect(master);
      osc.start();
      return osc;
    });

    this.isSynthesizing = true;
  }

  /**
   * Fades the drone out. The voice is released at once, so `startAmbientDrone` may follow immediately and cross-fade
   * into a new voice while this one dies away; only the released oscillators are stopped when the fade ends.
   */
  stopAmbientDrone(fadeTime = 1.0): void {
    if (!this.isSynthesizing || !this.synthGain) return;
    const gain = this.synthGain;
    const oscillators = this.synthOscillators;
    this.synthGain = null;
    this.synthOscillators = [];
    this.isSynthesizing = false;

    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + fadeTime);

    setTimeout(() => {
      for (const osc of oscillators) {
        try {
          osc.stop();
          osc.disconnect();
        } catch (error) {
          // An oscillator that already stopped throws InvalidStateError; anything else is a real fault.
          if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error;
        }
      }
      gain.disconnect();
    }, fadeTime * 1000);
  }

  /** Trigger an interactive tactile UI chord / shimmer */
  playChime(notes = [440, 554.37, 659.25], duration = 0.8): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    const now = this.ctx.currentTime;

    notes.forEach((freq, i) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + i * 0.04);

      gain.gain.setValueAtTime(0.0001, now + i * 0.04);
      gain.gain.exponentialRampToValueAtTime(0.08, now + i * 0.04 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.04 + duration);

      osc.connect(gain);
      gain.connect(this.analyser);
      gain.connect(this.ctx.destination);

      osc.start(now + i * 0.04);
      osc.stop(now + i * 0.04 + duration);
    });
  }

  dispose(): void {
    this.stopAmbientDrone(0.1);
  }
}
