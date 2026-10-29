import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioManager } from '../src/audio/audioManager';
import { AudioVisualizer } from '../src/audio/audioVisualizer';
import { updateTweens } from '../src/core/tween';
import { VirtualScroll } from '../src/scroll/virtualScroll';

interface FakeOscillator {
  stopped: boolean;
  frequency: number;
}

/**
 * Minimal AudioContext that records oscillators, enough for the drone's start/stop bookkeeping. It is handed in as a
 * manager so each test gets its own context instead of the cached global one.
 */
function fakeAudio(): { oscillators: FakeOscillator[]; manager: AudioManager } {
  const oscillators: FakeOscillator[] = [];
  const param = () => ({ value: 0.1, setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} });
  const ctx = {
    state: 'running',
    currentTime: 0,
    destination: {},
    createAnalyser: () => ({ fftSize: 128, smoothingTimeConstant: 0.8, frequencyBinCount: 64, connect: () => {} }),
    createGain: () => ({ gain: param(), connect: () => {}, disconnect: () => {} }),
    createStereoPanner: () => ({ pan: param(), connect: () => {} }),
    createOscillator: () => {
      const record: FakeOscillator = { stopped: false, frequency: 0 };
      oscillators.push(record);
      return {
        type: 'sine',
        frequency: { setValueAtTime: (v: number) => (record.frequency = v) },
        connect: () => {},
        disconnect: () => {},
        start: () => {},
        stop: () => (record.stopped = true),
      };
    },
  };
  return { oscillators, manager: { ctx, main: null } as unknown as AudioManager };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AudioVisualizer ambient drone', () => {
  it('starts a new voice during a fade-out and stops only the released one', () => {
    vi.useFakeTimers();
    const { oscillators, manager } = fakeAudio();
    const visualizer = new AudioVisualizer({ fftSize: 128, manager });

    visualizer.startAmbientDrone(110);
    visualizer.stopAmbientDrone(0.5);
    visualizer.startAmbientDrone(220);
    expect(oscillators).toHaveLength(8);
    expect(oscillators[4]!.frequency).toBe(220);

    vi.advanceTimersByTime(600);
    expect(oscillators.slice(0, 4).every((o) => o.stopped)).toBe(true);
    expect(oscillators.slice(4).some((o) => o.stopped)).toBe(false);
  });

  it('ignores a second start while a voice is playing', () => {
    const { oscillators, manager } = fakeAudio();
    const visualizer = new AudioVisualizer({ fftSize: 128, manager });
    visualizer.startAmbientDrone(110);
    visualizer.startAmbientDrone(110);
    expect(oscillators).toHaveLength(4);
  });
});

describe('VirtualScroll units', () => {
  it('keeps scrollTo, setTarget and targetY in output units when scale is not 1', async () => {
    const scroll = new VirtualScroll({ drag: false, mouseWheel: true, limit: true, keyboard: false, scale: 0.5, touchScale: 0.5 });
    scroll.max.y = 1000;
    try {
      scroll.setTarget(300);
      expect(scroll.targetY).toBe(300);

      scroll.scrollTo(800, 100, 'linear');
      await Promise.resolve();
      updateTweens(200);
      expect(scroll.targetY).toBeCloseTo(800);
    } finally {
      scroll.destroy();
    }
  });
});
