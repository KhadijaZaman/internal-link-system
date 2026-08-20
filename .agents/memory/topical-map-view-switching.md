---
name: Topical-map view switching
description: Preserving a usable, stateful canvas when a non-canvas topical-map view is the default.
---

When the topical map opens in Overview or Table, keep the canvas container measurable while visually hiding it. Do not use `display: none`, and do not reinitialize the canvas on every view change.

**Why:** The canvas sizes itself from its container. A default hidden container measured at zero width and broke the Map tab; rerunning the drawing effect on every switch would instead discard the user's pan and zoom state.

**How to apply:** Use a zero-height, overflow-hidden, invisible container that retains width. Any future view-mode or responsive-layout change must test Overview-to-Map switching with a nonzero canvas width.