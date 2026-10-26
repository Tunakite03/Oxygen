import * as THREE from 'three';
import { z } from 'zod';
import { getTexture } from '../assets/textures';
import { fetchJson } from '../core/net';

/**
 * MSDF text (msdf-bmfont JSON + atlas): font loading and layout into quad buffers with kerning, word wrap or word
 * break, alignment (including justify), paragraph spacing and per-glyph `animation` indices (glyph, word, line).
 * `karaokeBuffer` turns word indices into per-glyph [start, end] times for timed highlighting.
 */
const glyphSchema = z
  .object({
    id: z.number(),
    char: z.string(),
    width: z.number(),
    height: z.number(),
    xoffset: z.number(),
    yoffset: z.number(),
    xadvance: z.number(),
    x: z.number(),
    y: z.number(),
  })
  .loose();
const fontSchema = z
  .object({
    chars: z.array(glyphSchema),
    info: z.object({ size: z.number() }).loose(),
    common: z.object({ scaleW: z.number(), scaleH: z.number() }).loose(),
    kernings: z.array(z.object({ first: z.number(), second: z.number(), amount: z.number() })).default([]),
  })
  .loose();

export type Glyph = z.infer<typeof glyphSchema>;
export type FontJson = z.infer<typeof fontSchema>;

export interface Font {
  json: FontJson;
  glyphs: Map<string, Glyph>;
  firstGlyph: Glyph;
  texture: THREE.Texture;
}

const fontCache = new Map<string, Promise<Font>>();
let fontPath: string | null = null;

/** Directory holding `<name>.json` and `<name>.png` font pairs, with a trailing slash. */
export function configureFonts(setup: { fontPath: string }): void {
  fontPath = setup.fontPath;
}

export function loadFont(name: string): Promise<Font> {
  let p = fontCache.get(name);
  if (!p) {
    if (fontPath === null) throw new Error('configureFonts() must run before loading fonts');
    const base = fontPath;
    p = (async () => {
      const json = fontSchema.parse(await fetchJson(`${base}${name}.json`));
      const glyphs = new Map<string, Glyph>();
      for (const g of json.chars) glyphs.set(g.char, g);
      const firstGlyph = json.chars[0];
      if (!firstGlyph) throw new Error(`Font ${name} has no glyphs`);
      const texture = getTexture(`${base}${name}.png`);
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      return { json, glyphs, firstGlyph, texture };
    })();
    fontCache.set(name, p);
  }
  return p;
}

export interface TextLayoutOptions {
  text: string;
  width: number;
  align: 'left' | 'center' | 'right' | 'justify';
  size: number;
  letterSpacing: number;
  wordSpacing: number;
  lineHeight: number;
  paragraphSpacing: number;
  indent: number;
  wordBreak: boolean;
}

export interface TextBuffers {
  position: Float32Array;
  uv: Float32Array;
  local: Float32Array;
  animation: Float32Array;
  index: Uint16Array;
  weight: Float32Array;
  lineLength: number;
  letterCount: number;
  wordCount: number;
  lineCount: number;
}

const NEWLINE = /\n/;
// Original: /[^\S ]/ — any whitespace except the non-breaking space.
const WHITESPACE = /[^\S ]/;

interface LineGlyph {
  glyph: Glyph & { whitespace?: boolean };
  x: number;
}
interface Line {
  width: number;
  glyphs: LineGlyph[];
  br?: boolean;
  whitespaces?: number;
}

export function layoutText(font: Font, o: TextLayoutOptions): TextBuffers {
  const { json } = font;
  const text = o.text;
  const scale = o.size / json.info.size;
  const kern = (id1: number, id2: number): number => {
    return json.kernings.find((pair) => pair.first === id1 && pair.second === id2)?.amount ?? 0;
  };

  const numChars = text.replace(/[ \n]/g, '').length;
  const buffers: TextBuffers = {
    position: new Float32Array(4 * numChars * 3),
    uv: new Float32Array(4 * numChars * 2),
    local: new Float32Array(4 * numChars * 2),
    animation: new Float32Array(3 * numChars * 4),
    index: new Uint16Array(6 * numChars),
    weight: new Float32Array(4 * numChars),
    lineLength: 0,
    letterCount: 0,
    wordCount: 0,
    lineCount: 0,
  };
  for (let i = 0; i < numChars; i++) buffers.index.set([4 * i, 4 * i + 2, 4 * i + 1, 4 * i + 1, 4 * i + 2, 4 * i + 3], 6 * i);

  const lines: Line[] = [];
  let cursor = 0;
  let wordCursor = 0;
  let wordWidth = 0;
  const newLine = (br = false): Line => {
    const line: Line = { width: 0, glyphs: [] };
    const last = lines[lines.length - 1];
    if (last) last.br = br;
    lines.push(line);
    wordCursor = cursor;
    wordWidth = 0;
    return line;
  };
  let line = newLine();
  while (cursor < text.length) {
    const prev = text[cursor - 1];
    let char = text[cursor] as string;
    if (!line.glyphs.length && WHITESPACE.test(char) && !(prev && NEWLINE.test(char) && NEWLINE.test(prev))) {
      cursor++;
      wordCursor = cursor;
      wordWidth = 0;
      continue;
    }
    if (NEWLINE.test(char)) {
      cursor++;
      line = newLine(true);
      continue;
    }
    if (!cursor && o.indent) line.width += o.indent;
    let glyph = font.glyphs.get(char);
    if (!glyph) {
      console.warn('GLText: font is missing a character, substituting the first glyph', { char });
      glyph = font.firstGlyph;
      char = glyph.char;
    }
    if (line.glyphs.length) {
      const prevGlyph = (line.glyphs[line.glyphs.length - 1] as LineGlyph).glyph;
      const k = kern(prevGlyph.id, glyph.id) * scale;
      line.width += k;
      wordWidth += k;
    }
    const gl: LineGlyph['glyph'] = { ...glyph };
    line.glyphs.push({ glyph: gl, x: line.width });
    let advance = 0;
    if (WHITESPACE.test(char)) {
      gl.whitespace = true;
      wordCursor = cursor;
      wordWidth = 0;
      advance += o.wordSpacing * o.size;
    }
    advance += o.letterSpacing * o.size;
    advance += glyph.xadvance * scale;
    line.width += advance;
    wordWidth += advance;
    if (line.width > o.width) {
      if (o.wordBreak && line.glyphs.length > 1) {
        line.width -= advance;
        line.glyphs.pop();
        line = newLine();
        continue;
      }
      if (!o.wordBreak && wordWidth !== line.width) {
        const numGlyphs = cursor - wordCursor + 1;
        line.glyphs.splice(-numGlyphs, numGlyphs);
        cursor = wordCursor;
        line.width -= wordWidth;
        line = newLine();
        continue;
      }
    }
    cursor++;
  }
  if (!line.glyphs.length) lines.pop();

  if (o.align === 'justify') {
    let max = -Infinity;
    for (const l of lines) {
      l.whitespaces = 0;
      if (max < l.width) max = l.width;
      for (const g of l.glyphs) if (g.glyph.whitespace) l.whitespaces++;
    }
    for (const l of lines) {
      const add = l.whitespaces === 0 ? 0 : (max - l.width) / (l.whitespaces ?? 1);
      l.width = max;
      let extra = 0;
      for (const g of l.glyphs) {
        g.x += extra;
        if (g.glyph.whitespace) extra += add;
      }
    }
  }

  const texW = json.common.scaleW;
  const texH = json.common.scaleH;
  let j = 0;
  let y = (-o.size * (o.lineHeight - 1)) / 2;
  let glyphIndex = 0;
  let wordIndex = -1;
  let lineId = -1;
  for (const l of lines) {
    wordIndex++;
    lineId++;
    for (const { glyph, x: gx } of l.glyphs) {
      let x = gx;
      if (o.align === 'center' || o.align === 'justify') x -= 0.5 * l.width;
      else if (o.align === 'right') x -= l.width;
      if (WHITESPACE.test(glyph.char)) {
        wordIndex++;
        continue;
      }
      x += glyph.xoffset * scale;
      y -= glyph.yoffset * scale;
      buffers.weight.set([0, 0, 0, 0], 4 * glyphIndex);
      const w = glyph.width * scale;
      const h = glyph.height * scale;
      buffers.position.set([x, y - h, 0, x, y, 0, x + w, y - h, 0, x + w, y, 0], 4 * j * 3);
      buffers.animation.set(
        [glyphIndex, wordIndex, lineId, glyphIndex, wordIndex, lineId, glyphIndex, wordIndex, lineId, glyphIndex, wordIndex, lineId],
        3 * glyphIndex * 4,
      );
      glyphIndex++;
      const u = glyph.x / texW;
      const uw = glyph.width / texW;
      const v = 1 - glyph.y / texH;
      const vh = glyph.height / texH;
      buffers.uv.set([u, v - vh, u, v, u + uw, v - vh, u + uw, v], 4 * j * 2);
      buffers.local.set([0, 1, 0, 0, 1, 1, 1, 0], 4 * j * 2);
      y += glyph.yoffset * scale;
      j++;
    }
    y -= o.size * o.lineHeight * (l.br ? o.paragraphSpacing : 1);
  }
  buffers.lineLength = lines.length;
  buffers.letterCount = glyphIndex;
  buffers.lineCount = lineId;
  buffers.wordCount = wordIndex;
  return buffers;
}

export interface KaraokeWord {
  text: string;
  start: number;
  end: number;
  type: string;
}

/** Per-glyph [start, end, 0] of the karaoke word each glyph belongs to (glyphs outside any word keep their indices). */
export function karaokeBuffer(animation: Float32Array, words: KaraokeWord[]): Float32Array {
  const out = new Float32Array(animation);
  const karaokeWords = words.filter((w) => w.type === 'word');
  for (let i = 0; i < animation.length; i += 3) {
    const item = karaokeWords[animation[i + 1] as number];
    if (item) {
      out[i] = item.start;
      out[i + 1] = item.end;
      out[i + 2] = 0;
    }
  }
  return out;
}
