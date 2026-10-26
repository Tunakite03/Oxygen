import { beforeEach, describe, expect, it } from 'vitest';
import { setState } from '../src/core/events';
import { stage } from '../src/core/stage';
import { StoryScene } from '../src/story/storyScene';

class TestScene extends StoryScene {
  constructor() {
    super('TestScene', 0);
  }
}

describe('StoryScene layout and visibility', () => {
  let scene: TestScene;
  const screenHeightWorld = 4;

  beforeEach(async () => {
    stage.width = 1000;
    stage.height = 800;
    setState('Story/screenHeightWorld', screenHeightWorld);
    scene = new TestScene();
    await scene.load(document.body);
    // Two screens of story above it, two screens tall.
    scene.setLayout({ screenHeightWorld, height: 2, totalHeight: 8, marginTop: 0, marginBottom: 0 });
  });

  it('places its slot below the content above and sizes its DOM section', () => {
    expect(scene.worldBottom).toBe(8);
    expect(scene.worldTop).toBe(16);
    expect(scene.heightWorld).toBe(8);
    expect(scene.ui?.element.className).toBe('TestUI');
    expect(scene.ui?.element.style.getPropertyValue('--height')).toBe('1600px');
    expect(scene.id).toBe('testScene');
  });

  it('is hidden above its slot, visible across it and hidden after it', () => {
    const at = (scrollY: number): { visible: boolean; progress: number } => {
      scene.toggleVisibility({ lerpedScrollY: scrollY, screenHeightWorld, visibilityPaddingTop: 0.1, visibilityPaddingBottom: 0.1 });
      return { visible: scene.visible, progress: scene.scrollProgress };
    };
    expect(at(0).visible).toBe(false);
    const entering = at(-4.5);
    expect(entering.visible).toBe(true);
    expect(entering.progress).toBeGreaterThan(0);
    expect(at(-10).progress).toBeCloseTo(0.5);
    expect(at(-16.2).visible).toBe(false);
  });

  it('reports slot edges in viewport heights for shader clipping', () => {
    expect(scene.discardValues(-4)).toEqual({ top: 3, bottom: 1 });
  });
});
