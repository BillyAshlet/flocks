# Echo Cartography (bonus page)

A past project of mine, shown on flocks at `/echo` as one place a swarm like
this could be put to use. It was made as a team project at the Manycore
spatial intelligence workshop in August 2026; the code here is mine. The full
project is at <https://manycore.billyashlet.com>.

The idea: a device that swerves around something has, for a moment, measured
how far away it is. Each device sends only those near misses, and a terminal
builds them into a map of places no camera has seen. Rays that pass through
open water erase moving things from the map, so the seabed separates from the
fish without any recognition.

## What is here

The code is moved over almost as it was and runs its own engine, separate
from the flocks tiers in `../src`. Its original comments (in Chinese) are kept.

- `src/flock.js`, `sensor.js`, `collision.js`, `creature.js`: the swarm, its
  ray sensors, obstacle collision and the predators.
- `src/eventBus.js`: the near-miss events the swarm uplinks.
- `src/grid.js`: the occupancy grid and free-space carving.
- `src/terminal.js`, `terminalPanel.js`, `mapView.js`: the terminal's
  exploration phases, its panel and the point-cloud map.
- `src/scene.js`, `params.js`, `i18n.js`: rendering, parameters, labels.
- `assets/models/`: the inspection device and predator models.

## Changed for flocks

Changes in the moved files are marked with `flocks:` comments.

- `src/main.js` is new: no cover, pitch deck, parameter panel, language
  switch or pilot mode; the page opens paused and "Release the swarm" starts it.
- `params.js`: the light palette of the rest of the site, and a farther
  overview camera.
- `scene.js`: the canvas follows its column instead of the window, the view is
  offset away from the terminal panel, and glows use normal blending.
- `mapView.js`: larger, darker map points for the light background.
- `terminalPanel.js`: light plan-map colors; storage failures are tolerated.
- `i18n.js`: English only.
