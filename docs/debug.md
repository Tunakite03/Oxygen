# Debug panel and frame statistics

## DebugGUI

A small tuning panel built on native, labelled inputs (keyboard and screen-reader friendly). Toggle it with the
backquote key.

```ts
import { DebugGUI, PerfMonitor, debugEnabled } from '@tunakite03/oxygen';

if (debugEnabled()) {                                   // true when the URL has ?debug
  const gui = new DebugGUI({ title: 'Studio', storageKey: 'studio-debug' });
  const post = gui.addFolder('Post');
  post.addNumber(bloom, 'intensity', { min: 0, max: 4, step: 0.01 }).onChange((v) => console.log(v));
  post.addBoolean(fxaa, 'enabled', { label: 'fxaa' });
  post.addSelect(grade, 'toneMapping', ['none', 'reinhard', 'aces']);
  post.addColor(material.color, 'tint');
  post.addUniform(material.uniforms, 'uAmount', { min: 0, max: 1 });
  post.addButton('Replay intro', () => intro.play());

  const perf = new PerfMonitor(pipeline.renderer);
  perf.attach(gui.addFolder('Performance', { open: false }));
}
```

| Method | Control |
| --- | --- |
| `addNumber(obj, key, { min, max, step, label })` | slider and number box with `min` and `max`, a number box without |
| `addBoolean(obj, key)` | checkbox |
| `addSelect(obj, key, choices)` | select |
| `addText(obj, key)` | text box |
| `addColor(color, label)` | colour picker editing a `THREE.Color` in place |
| `addUniform(uniforms, name, options)` | slider on a float uniform's `.value` |
| `addButton(label, action)` | button |
| `addMonitor(label, read, { digits })` | read-only value |
| `addGraph(label, read, { min, max, samples })` | sparkline with the latest value |
| `addFolder(title, { open })` | collapsible group |

Keys are type-checked: `addNumber` only accepts number properties of the object. Controls refresh at about 10 Hz while
the panel is open, so values changed in code show up. With `storageKey`, changed values are saved to `localStorage` per
folder path and label and restored when the same control is added again; `clearStorage()` forgets them. Storage
failures (private mode, blocked site data) are ignored and the panel keeps working.

## PerfMonitor

Averages fps and frame time over half a second and reports draw calls, triangles, points and lines summed over every
render of the frame (post passes and GPU simulations included), plus program, geometry and texture counts. It turns off
`renderer.info.autoReset` so counts cover the whole frame and resets them after each read; `destroy()` restores it.
`perf.stats` holds the numbers for your own overlay.
