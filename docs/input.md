# Pointer input

## PointerTracker

One primary pointer (mouse, pen or touch through Pointer Events), relative to an element or the window.

```ts
import { PointerTracker, pointerToPlane } from '@tunn/oxygen';

const pointer = new PointerTracker(canvas, { follow: 0.15, dragThreshold: 6, tapMaxMs: 300 });
pointer.on('tap', (p) => select(p));
pointer.on('dragStart', (d) => grab(d.start));
pointer.on('drag', (d) => rotate(d.delta));
pointer.on('dragEnd', () => release());

onFrame((_t, delta) => {
  pointer.update(delta); // eases `smoothed`, decays velocity once moves stop
  if (pointer.inside) light.position.copy(pointerToPlane(pointer.ndc, camera, groundPlane) ?? light.position);
});
```

| Field | Meaning |
| --- | --- |
| `position` | CSS px from the element's top-left |
| `ndc` | -1..1, y up, for raycasting |
| `uv` | 0..1, y up, for shaders |
| `velocity`, `speed` | smoothed px/s |
| `smoothed` | eased follower of `position` |
| `down`, `inside`, `drag` | press state, whether the pointer is over the element, `{ active, start, delta }` |

A press becomes a drag after `dragThreshold` px; a release within `tapMaxMs` without dragging is a tap. Releases are
tracked on the window, so a drag that ends outside the element still ends. `feed(phase, x, y, time, width, height)` is
the single entry point and can replay recorded input in tests.

`pointerToPlane(ndc, camera, plane)` returns where the pointer ray meets a plane, or null.

## Interaction3D

Hover, click and move events on meshes, raycast from the pointer. `ScrollStory` creates one for its camera
(`interaction3d()`); create your own with `new Interaction3D(() => camera)`.

```ts
interaction.add(mesh, (e) => (e.action === 'over' ? highlight() : unhighlight()), () => open());
```

DOM elements with the class `hit` or `prevent_interaction3d` under the pointer block 3D interaction.
