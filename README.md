# Eincycle

A mobile-first Hamiltonian-cycle ("loop") puzzle: drag a path from a single
starting cell until it visits every cell on the board exactly once and closes
back into a loop.

## Development

```sh
npm install
npm run dev      # start the dev server
npm test         # run the unit test suite (vitest)
npm run build    # typecheck + production build to dist/
npm run preview  # preview the production build locally
```

## Project structure

- `src/game/` — pure, dependency-free game logic: seeded RNG, random spanning
  tree generation, Hamiltonian cycle tracing, puzzle graph construction, and
  the path-drag state machine. Fully unit tested.
- `src/view/viewport.ts` — pure pan/zoom math (fit-to-view, zoom-at-point,
  pan), also unit tested.
- `src/render.ts` — canvas drawing.
- `src/input.ts` — unified pointer handling (path editing vs. pan vs.
  pinch-zoom), built on top of the pure modules above.
- `src/main.ts` — DOM wiring and app entry point.

## Deployment

Pushes to `main` build and deploy automatically to GitHub Pages via
`.github/workflows/deploy.yml`. This requires the repository's
**Settings → Pages → Source** to be set to **GitHub Actions** (a one-time,
manual setting GitHub does not expose over the API).
