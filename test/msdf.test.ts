import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { karaokeBuffer, layoutText } from '../src/text/msdf';
import type { Font, FontJson, Glyph } from '../src/text/msdf';

/** Monospace test font: every glyph is 10 units wide and advances 10 at size 10. */
function makeFont(chars: string): Font {
  const glyphs = [...chars].map((char, i): Glyph => ({ id: char.charCodeAt(0), char, width: 10, height: 10, xoffset: 0, yoffset: 0, xadvance: 10, x: i * 10, y: 0 }));
  const json: FontJson = { chars: glyphs, info: { size: 10 }, common: { scaleW: 256, scaleH: 256 }, kernings: [] };
  return { json, glyphs: new Map(glyphs.map((g) => [g.char, g])), firstGlyph: glyphs[0] as Glyph, texture: new THREE.Texture() };
}

const base = { size: 10, letterSpacing: 0, wordSpacing: 0, lineHeight: 1, paragraphSpacing: 1, indent: 0, wordBreak: false } as const;

describe('layoutText', () => {
  const font = makeFont('ab ');

  it('lays out one quad per visible glyph', () => {
    const b = layoutText(font, { ...base, text: 'ab', width: Infinity, align: 'left' });
    expect(b.letterCount).toBe(2);
    expect(b.lineLength).toBe(1);
    expect(b.index.length).toBe(12);
    // Second glyph starts one advance to the right.
    expect(b.position[12]).toBe(10);
  });

  it('wraps whole words that overflow the width', () => {
    const b = layoutText(font, { ...base, text: 'ab ab', width: 25, align: 'left' });
    expect(b.lineLength).toBe(2);
    expect(b.letterCount).toBe(4);
  });

  it('centres lines on the origin', () => {
    const b = layoutText(font, { ...base, text: 'ab', width: Infinity, align: 'center' });
    expect(b.position[0]).toBe(-10);
  });

  it('maps glyph word indices to karaoke timings', () => {
    const b = layoutText(font, { ...base, text: 'ab ab', width: Infinity, align: 'left' });
    const k = karaokeBuffer(b.animation, [
      { text: 'ab', start: 0, end: 1, type: 'word' },
      { text: 'ab', start: 1, end: 2, type: 'word' },
    ]);
    // Last vertex of the last glyph belongs to word 1.
    expect([...k.slice(-3)]).toEqual([1, 2, 0]);
  });
});
