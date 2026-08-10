/**
 * The game's display name — currently "Eincycle", formerly "Einkreis" before
 * that "Loop It". Per CLAUDE.md's own note on this, the name is a
 * placeholder that's expected to keep changing as it's iterated on, so this
 * is the *one* place that should ever need editing to rename it: every
 * on-screen occurrence (`<title>`, the main menu's `<h1>`, the in-game
 * header's `<h1>`) is a `.gameName` element in `index.html` with static
 * fallback text (for the brief pre-JS paint, and for anything reading the
 * markup without running `main.ts`), and `main.ts`'s `applyGameName` — called
 * once at startup — overwrites all of them, and `document.title`, from this
 * constant. The fallback text in `index.html` is not itself load-bearing;
 * keeping it in sync with this constant is just good hygiene so the
 * pre-JS/no-JS text isn't stale, not something anything at runtime depends
 * on.
 *
 * Deliberately *not* wired into any storage/identity key (`localStorage`
 * keys like `loopit:lastSize` still say `loopit`, `persistence/db.ts`'s
 * IndexedDB database name is still `loopit`) — those are load-bearing
 * storage identifiers a rename must never touch (see CLAUDE.md's "Things to
 * know before changing size/shape/puzzle identity" for why churning a
 * storage-format string is treated as a breaking change here), completely
 * independent of what the game happens to be *called* on screen this week.
 */
export const GAME_NAME = 'Eincycle';
