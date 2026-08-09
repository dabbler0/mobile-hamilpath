import { playSfx, setSfxVolume } from './audio/sfx';
import { BLITZ_PACE_OPTIONS, BLITZ_PACE_PARAMS, createBlitzSequence, DEFAULT_BLITZ_PACE, paceForParams, type BlitzEvent, type BlitzPace, type BlitzParams } from './game/blitz';
import { createComponentColorState, previewComponentColors, resetComponentColorState, snapshotEdgeColors, updateComponentColors, type ComponentColorState } from './game/componentColors';
import { computeFarthestCell, computeReachableEdges, computeRecoloredEdges } from './game/edgeRipple';
import { boardPixelSize, faceToScreen, type Layout } from './game/geometry';
import { canRedo, canUndo, createHistory, decodeMoveLog, recordMove, redo as redoHistory, undo as undoHistory, type HistoryState } from './game/history';
import { orderLoopCells } from './game/loopOrder';
import { applyPathOp, createInitialPath, type EdgeKey, type PathOp, type PathState } from './game/pathEdit';
import { NO_EDGE_COLLECTIONS, totalCells, type Puzzle } from './game/puzzle';
import { generatePuzzle, generateSolutionEdges, randomSeed, SELECTABLE_SHAPE_MODE_OPTIONS, SIZE_OPTIONS, shapeModeOption, sizeOption, type PuzzleId, type ShapeMode } from './game/puzzleGen';
import { computeRegions, type Face, type Region, type RegionMap } from './game/regions';
import { attachPointerHandling, type GameInputHost } from './input';
import { attachKeyboardHandling, type KeyboardInputHost } from './keyboard';
import { startMenuBackground } from './menuBackground';
import { deleteBlitzRun, deleteBlitzRunsForParams, listBlitzDifficulties, listBlitzRunsForParams, saveBlitzRun, type BlitzDifficultySummary, type BlitzRunRecord } from './persistence/blitzStore';
import { clearInProgress, deleteCompleted, getCompleted, listCompleted, listInProgress, puzzleIdOf, recordCompletion, saveInProgress, type CompletedRecord, type InProgressRecord } from './persistence/gameStore';
import { draw, GROW_MS, midgameRippleDelayMs, PULSE_MS, RIPPLE_STAGGER_MS, segmentColor, SHRINK_MS, type AnimationState } from './render';
import { loadSfxVolume, saveSfxVolume } from './settings';
import './style.css';
import { computeFitView, computeZoomAt, panToKeepVisible, type Viewport, type ViewportBounds } from './view/viewport';

const LAYOUT: Layout = { cellSize: 34, pad: 24 };
const VIEW_BOUNDS: ViewportBounds = { minScale: 0.12, maxScale: 3 };
/** How long each replay frame stays on screen at the default (1×) replay speed — see `replaySpeedSelect`/`replaySpeed`. */
const REPLAY_FRAME_MS = 50;
/** How long a transient status message (e.g. "undo history unavailable") stays visible. */
const TOAST_MS = 3200;
/**
 * How close (in on-screen pixels) the keyboard cursor is allowed to get to
 * the edge of `wrapEl` before the view auto-scrolls to pull it back — see
 * `setKeyboardCursor`. Expressed in screen pixels (not board cells), so it
 * stays a sensible-looking gap regardless of zoom level.
 */
const KEYBOARD_CURSOR_SCROLL_MARGIN = 56;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

// ---- Screens ----
// The app is a small stack of full-screen "pages" — see CLAUDE.md's "Menus
// and screen navigation" section. Exactly one is ever visible at a time;
// `showScreen` is the only place that toggles `.hidden` on their roots and
// runs each screen's enter/leave side effects (starting/stopping the main
// menu's animated background, refreshing the Resume/Replays lists, halting
// the live game's animation loop when it's no longer on screen).
type Screen = 'mainMenu' | 'freePlay' | 'newGame' | 'resume' | 'replays' | 'game' | 'blitzMenu' | 'blitzSetup' | 'blitzLeaderboard' | 'blitzLeaderboardRuns' | 'blitzGameOver' | 'settings';
let screen: Screen = 'mainMenu';

const mainMenuScreenEl = byId<HTMLDivElement>('mainMenuScreen');
const menuCanvas = byId<HTMLCanvasElement>('menuCanvas');
const freePlayEntryBtn = byId<HTMLButtonElement>('freePlayEntryBtn');
const blitzEntryBtn = byId<HTMLButtonElement>('blitzEntryBtn');
const settingsEntryBtn = byId<HTMLButtonElement>('settingsEntryBtn');

const settingsScreenEl = byId<HTMLDivElement>('settingsScreen');
const settingsBackBtn = byId<HTMLButtonElement>('settingsBackBtn');
const sfxVolumeSlider = byId<HTMLInputElement>('sfxVolumeSlider');
const sfxVolumeReadout = byId<HTMLSpanElement>('sfxVolumeReadout');
const sfxVolumePreviewBtn = byId<HTMLButtonElement>('sfxVolumePreviewBtn');

const freePlayMenuScreenEl = byId<HTMLDivElement>('freePlayMenuScreen');
const freePlayBackBtn = byId<HTMLButtonElement>('freePlayBackBtn');
const newGameEntryBtn = byId<HTMLButtonElement>('newGameEntryBtn');
const resumeEntryBtn = byId<HTMLButtonElement>('resumeEntryBtn');
const replaysEntryBtn = byId<HTMLButtonElement>('replaysEntryBtn');

const newGameMenuScreenEl = byId<HTMLDivElement>('newGameMenuScreen');
const newGameBackBtn = byId<HTMLButtonElement>('newGameBackBtn');
const newGameSizeSelect = byId<HTMLSelectElement>('newGameSizeSelect');
const newGameShapeSelect = byId<HTMLSelectElement>('newGameShapeSelect');
const newGameStartBtn = byId<HTMLButtonElement>('newGameStartBtn');

const resumeMenuScreenEl = byId<HTMLDivElement>('resumeMenuScreen');
const resumeBackBtn = byId<HTMLButtonElement>('resumeBackBtn');
const resumeListEl = byId<HTMLDivElement>('resumeListEl');

const replaysMenuScreenEl = byId<HTMLDivElement>('replaysMenuScreen');
const replaysBackBtn = byId<HTMLButtonElement>('replaysBackBtn');
const replaysListEl = byId<HTMLDivElement>('replaysListEl');

const blitzMenuScreenEl = byId<HTMLDivElement>('blitzMenuScreen');
const blitzMenuBackBtn = byId<HTMLButtonElement>('blitzMenuBackBtn');
const blitzPlayEntryBtn = byId<HTMLButtonElement>('blitzPlayEntryBtn');
const blitzLeaderboardEntryBtn = byId<HTMLButtonElement>('blitzLeaderboardEntryBtn');

const blitzSetupScreenEl = byId<HTMLDivElement>('blitzSetupScreen');
const blitzSetupBackBtn = byId<HTMLButtonElement>('blitzSetupBackBtn');
const blitzPaceSelect = byId<HTMLSelectElement>('blitzPaceSelect');
const blitzStartBtn = byId<HTMLButtonElement>('blitzStartBtn');

const blitzLeaderboardScreenEl = byId<HTMLDivElement>('blitzLeaderboardScreen');
const blitzLeaderboardBackBtn = byId<HTMLButtonElement>('blitzLeaderboardBackBtn');
const blitzLeaderboardListEl = byId<HTMLDivElement>('blitzLeaderboardListEl');

const blitzLeaderboardRunsScreenEl = byId<HTMLDivElement>('blitzLeaderboardRunsScreen');
const blitzLeaderboardRunsBackBtn = byId<HTMLButtonElement>('blitzLeaderboardRunsBackBtn');
const blitzLeaderboardRunsTitleEl = byId<HTMLHeadingElement>('blitzLeaderboardRunsTitle');
const blitzLeaderboardRunsListEl = byId<HTMLDivElement>('blitzLeaderboardRunsListEl');

const blitzGameOverScreenEl = byId<HTMLDivElement>('blitzGameOverScreen');
const blitzGameOverScoreEl = byId<HTMLParagraphElement>('blitzGameOverScore');
const blitzPlayAgainBtn = byId<HTMLButtonElement>('blitzPlayAgainBtn');
const blitzGameOverReplayBtn = byId<HTMLButtonElement>('blitzGameOverReplayBtn');
const blitzGameOverMenuBtn = byId<HTMLButtonElement>('blitzGameOverMenuBtn');

const gameScreenEl = byId<HTMLDivElement>('gameScreen');
const wrapEl = byId<HTMLDivElement>('boardWrap');
const canvas = byId<HTMLCanvasElement>('canvas');
const maybeCtx = canvas.getContext('2d');
if (!maybeCtx) throw new Error('2D canvas context unavailable');
const ctx: CanvasRenderingContext2D = maybeCtx;
const headerInfoEl = byId<HTMLDivElement>('headerInfo');
const progressEl = byId<HTMLDivElement>('progress');
const puzzleLabelEl = byId<HTMLDivElement>('puzzleLabel');
const winBannerEl = byId<HTMLDivElement>('winBanner');
const playControlsEl = byId<HTMLDivElement>('playControls');
const exitBtn = byId<HTMLButtonElement>('exitBtn');
const undoBtn = byId<HTMLButtonElement>('undoBtn');
const redoBtn = byId<HTMLButtonElement>('redoBtn');
const giveUpBtn = byId<HTMLButtonElement>('giveUpBtn');
const activeControlsEl = byId<HTMLDivElement>('activeControls');
const completeControlsEl = byId<HTMLDivElement>('completeControls');
const rematchBtn = byId<HTMLButtonElement>('rematchBtn');
const viewReplayBtn = byId<HTMLButtonElement>('viewReplayBtn');
const reviewBarEl = byId<HTMLDivElement>('reviewBar');
const reviewLabelEl = byId<HTMLSpanElement>('reviewLabel');
const reviewIdleControlsEl = byId<HTMLDivElement>('reviewIdleControls');
const reviewPlaybackControlsEl = byId<HTMLDivElement>('reviewPlaybackControls');
const replayBtn = byId<HTMLButtonElement>('replayBtn');
const replayPlayPauseBtn = byId<HTMLButtonElement>('replayPlayPauseBtn');
const replaySpeedSelect = byId<HTMLSelectElement>('replaySpeedSelect');
const replayScrubberEl = byId<HTMLInputElement>('replayScrubber');
const replayCounterEl = byId<HTMLSpanElement>('replayCounter');
const replayCloseBtn = byId<HTMLButtonElement>('replayCloseBtn');
const toastEl = byId<HTMLDivElement>('toast');

const blitzExitBtn = byId<HTMLButtonElement>('blitzExitBtn');
const blitzHeaderInfoEl = byId<HTMLDivElement>('blitzHeaderInfo');
const blitzTimerEl = byId<HTMLDivElement>('blitzTimer');
const blitzStatsEl = byId<HTMLDivElement>('blitzStats');
const blitzReplayBarEl = byId<HTMLDivElement>('blitzReplayBar');
const blitzReplayCloseBtn = byId<HTMLButtonElement>('blitzReplayCloseBtn');
const blitzReplayPlayPauseBtn = byId<HTMLButtonElement>('blitzReplayPlayPauseBtn');
const blitzReplaySpeedSelect = byId<HTMLSelectElement>('blitzReplaySpeedSelect');
const blitzReplayScrubberEl = byId<HTMLInputElement>('blitzReplayScrubber');
const blitzReplayCounterEl = byId<HTMLSpanElement>('blitzReplayCounter');

/**
 * `'blitz'` is a live Blitz run and `'blitzReplay'` is watching a recorded
 * one back — both reuse the `'game'` screen and its single canvas exactly
 * like `'playing'`/`'reviewing'` do (see index.html's doc comment on
 * `#gameScreen`), so this stays one `Mode` union rather than Blitz getting
 * its own parallel screen/canvas setup. `activePuzzle()`/`activeRegionMap()`/
 * `inputPathState()` below branch on all four; `render()` branches on all
 * four too, for exactly the same reason `'reviewing'` already needed its own
 * branch there.
 */
type Mode = 'playing' | 'reviewing' | 'blitz' | 'blitzReplay';
let mode: Mode = 'playing';

let currentPuzzleId: PuzzleId;
let puzzle: Puzzle;
let regionMap: RegionMap;
let pathState: PathState;
/**
 * True once the player has hit Give Up on the current live puzzle attempt
 * and its `pathState.edges` holds the revealed intended solution rather
 * than anything the player actually marked. Deliberately *not* folded into
 * `pathState.won`: giving up is not a win (no `recordCompletion`, nothing
 * persisted — see `revealSolution`), but input still needs blocking exactly
 * like a real win does, which is why `host.getPathState()` below reports
 * `won: true` whenever this is set.
 */
let gaveUp = false;
/** Undo/redo stacks + replay move log for the live (playing-mode) game. Reset on every fresh/resumed/rematched puzzle. */
let history: HistoryState = createHistory();
let reviewPuzzle: Puzzle | null = null;
let reviewRegionMap: RegionMap | null = null;
let reviewEdges: PathState['edges'] = new Set();
/** The reviewed game's own won-ness, distinct from the hardcoded `true` used for the static "view a finished puzzle" case — during replay playback, intermediate frames aren't won yet. */
let reviewWon = true;
/** The completed-game record currently open in the review overlay, so Replay can read its move log and Done/close-replay can restore the final solved view. */
let currentReviewItem: CompletedRecord | null = null;
/**
 * Where "Done" (`exitReview`) should return to: `'game'` when review was
 * opened via the just-completed live game's own Replay button (in which
 * case Done resumes showing that live, solved game), or `'menu'` when it
 * was opened from the Replays list (in which case Done goes back to that
 * list instead of surfacing whatever the live game happens to be).
 */
let reviewOrigin: 'game' | 'menu' = 'game';
let view: Viewport = { scale: 1, tx: 0, ty: 0 };
/** Tracks the latest in-flight IndexedDB write so a screen change can wait for a completion to land before reading persisted state back. */
let pendingPersist: Promise<void> = Promise.resolve();
/** Id of whichever region is currently focused (press-candidate under a pointer, or the keyboard cursor's region), for highlighting. Reset on any mode/puzzle change. */
let focusedRegionId: number | null = null;
let keyboardCursor: Face | null = null;

let replayFrames: PathState[] = [];
let replayIndex = 0;
let replayTimerId: number | null = null;
/** Playback speed multiplier — `REPLAY_FRAME_MS / replaySpeed` is the actual per-frame interval. Read from/written to `replaySpeedSelect`, and persisted the same way size/shape are. */
let replaySpeed = 1;
let toastTimerId: number | null = null;

/** Teardown for the main menu's animated background loop (`menuBackground.ts`), running only while `screen === 'mainMenu'` — see `showScreen`. */
let stopMenuBackground: (() => void) | null = null;

// ---- Blitz mode ----
// See CLAUDE.md's "Blitz mode" section for the overall design. A live run
// (`mode === 'blitz'`) and watching a recorded one back (`mode ===
// 'blitzReplay'`) are two halves of the same feature but deliberately keep
// separate state below — a live run only ever moves forward in real time,
// while replay needs to seek/scrub/speed-change, which is a genuinely
// different playback engine (closer to `showReplayFrame`/`playReplay` above,
// just driven by real timestamps instead of a frame index).

/** How long the "solved!" flash stays on screen before the next puzzle appears — long enough to read the "Solved!" toast and see the last edge's grow animation land, short enough to still feel like Blitz. */
const BLITZ_ADVANCE_DELAY_MS = 550;
/** Below this many remaining milliseconds, the header timer switches to its urgent (red) styling. */
const BLITZ_LOW_TIME_MS = 10000;

let blitzParams: BlitzParams = BLITZ_PACE_PARAMS[DEFAULT_BLITZ_PACE];
let blitzSeq: ReturnType<typeof createBlitzSequence> | null = null;
let blitzRunSeed = 0;
let blitzPuzzle: Puzzle;
let blitzRegionMap: RegionMap;
let blitzPathState: PathState = createInitialPath();
let blitzCurrentId: PuzzleId | null = null;
/** This run's event log so far — see `game/blitz.ts`'s `BlitzEvent`. Timestamped relative to `blitzRunStartPerf`, not wall-clock `Date.now()`, so it's immune to the system clock changing mid-run. */
let blitzEvents: BlitzEvent[] = [];
/** `performance.now()` when the run's first puzzle started — the zero point every event's `t` is relative to. */
let blitzRunStartPerf = 0;
/** `Date.now()` at the same moment, purely for the leaderboard's human-readable date. */
let blitzRunStartedAt = 0;
/** `performance.now()` timestamp at which the clock reaches zero — starts at `blitzRunStartPerf + startingTimeSec * 1000` and is pushed forward by every `advanceBlitzPuzzle` award, credited the instant each puzzle starts rather than when it's solved (see `BlitzParams.timeBackPerEdgeSec`'s doc comment); can grow arbitrarily large, matching CLAUDE.md's "time bank can get arbitrarily large". */
let blitzDeadline = 0;
let blitzPuzzlesSolved = 0;
let blitzTimerRafId: number | null = null;
let blitzAdvanceTimeoutId: number | null = null;
/** The most recently finished run, kept around purely so the game-over screen's "Watch Replay" button has something to open without a round-trip to IndexedDB. `null` if saving it failed (still shows the game-over screen with its score — CLAUDE.md's "final score" doesn't depend on persistence succeeding). */
let blitzLastRecord: BlitzRunRecord | null = null;

/** Which difficulty (`BlitzParams`) the Leaderboard's runs list is currently showing — set by `openBlitzLeaderboardRuns`, read by `refreshBlitzLeaderboardRunsList`. */
let currentLeaderboardParams: BlitzParams | null = null;

// ---- Blitz replay (watching a recorded run back) ----
let blitzReplayRecord: BlitzRunRecord | null = null;
/** Which screen "‹ Close" returns to — the Leaderboard's runs list, or the game-over screen right after finishing a run. */
let blitzReplayReturnScreen: Screen = 'blitzLeaderboardRuns';
let blitzReplayPuzzle: Puzzle | null = null;
let blitzReplayRegionMap: RegionMap | null = null;
let blitzReplayCurrentId: PuzzleId | null = null;
let blitzReplayPathState: PathState = createInitialPath();
/** Index into `blitzReplayRecord.events` of the next event *not yet* applied — `seekBlitzReplay`/`advanceBlitzReplayTo` both only ever move this forward from 0 (a rewind always resets and replays from the start, same tradeoff `decodeMoveLog` already makes for the ordinary per-puzzle replay). */
let blitzReplayEventCursor = 0;
/** Sum of every `puzzleStart` award applied so far, for reconstructing the header's "remaining time" readout during replay (`startingTimeSec * 1000 + awarded - t`). */
let blitzReplayAwardedMs = 0;
let blitzReplaySolved = 0;
/** Current playback position, in ms since the run's own start — the single source of truth `updateBlitzReplayUI` and the scrubber both read. */
let blitzReplayT = 0;
let blitzReplayPlaying = false;
let blitzReplaySpeed = 1;
let blitzReplayLastPerf = 0;
let blitzReplayRafId: number | null = null;

/**
 * ## Animations
 *
 * All "juice" is purely a rendering overlay on top of the already-committed
 * game state — nothing here ever gates a real move, undo, or win check.
 * `render()` is the single place that reads/prunes this state and feeds it
 * to `render.ts`'s `draw()`; every entry is keyed by `performance.now()`
 * timestamps rather than a frame counter, so pausing/resuming the tab (or a
 * slow frame) can't desync an animation from where it should be.
 *
 * - `growingEdges`/`shrinkingEdges`/`pulsingEdges` are populated by
 *   `scheduleToggleAnimation`, called only from `setPathState` — i.e. only a
 *   live tap/keyboard toggle animates. Undo, redo, Give Up, and
 *   entering/leaving review all jump straight to a new state instead
 *   (`clearEdgeAnimations`), which is simplest and keeps this file from
 *   having to reconcile an in-flight animation with a state it no longer
 *   describes.
 * - `winLoopCells`/`winLoopEdgesRef` track the completed puzzle's cell
 *   cycle, and `pendingCometStart`/`cometActive`/`cometStartIndex`/
 *   `cometStartTime` the win-comet built on top of it; see `render()`'s doc
 *   comment for how they're kept in sync with whatever's actually on screen.
 * - `animFrameId` is the single `requestAnimationFrame` handle driving
 *   continued redraws while anything above is active; `render()` reschedules
 *   itself as long as `edgeAnimsActive() || winLoopCells !== null`, and lets
 *   the loop lapse the moment neither is true. Because the win-comet runs
 *   *forever* once a puzzle is completed, leaving the game screen
 *   (`exitGame`) explicitly cancels this loop rather than waiting for it to
 *   lapse on its own — see `stopLiveAnimationLoop`.
 * - `liveComponentColors`/`reviewComponentColors` (`game/componentColors.ts`)
 *   are *not* cleared by `clearEdgeAnimations` — they track persistent
 *   per-component colors across ordinary edits (undo/redo included), which
 *   is the whole point (see that module's doc comment). `render()` updates
 *   whichever one is active every frame (cheap and idempotent when edges
 *   haven't changed, same as `computeEdgeComponents` always was); only a
 *   genuine switch to a *different* board (`beginPuzzle`, `enterReview`)
 *   explicitly resets one, so an unrelated old component's color can't
 *   spuriously "persist" onto a new puzzle just because cell coordinates
 *   happen to coincide.
 */
const growingEdges = new Map<EdgeKey, number>();
const shrinkingEdges = new Map<EdgeKey, { start: number; color: string }>();
const pulsingEdges = new Map<EdgeKey, { start: number; delay: number; fromColor: string }>();

const liveComponentColors: ComponentColorState = createComponentColorState();
const reviewComponentColors: ComponentColorState = createComponentColorState();

let winLoopCells: ReadonlyArray<readonly [number, number]> | null = null;
/** Reference (not deep-equality) to whichever edge set `winLoopCells` was computed from, so a *different* already-won puzzle (e.g. opening another completed puzzle in review) recomputes instead of keeping a stale cycle — see `render()`. */
let winLoopEdgesRef: ReadonlySet<EdgeKey> | null = null;

/**
 * Set by `scheduleToggleAnimation` the instant a toggle wins the puzzle:
 * where the winning ripple will finally finish (`computeFarthestCell`'s
 * result — the point its outward wave reaches last) and exactly when
 * (mirroring that edge's own pulse-completion time). `render()` holds the
 * win-comet off (`cometActive` stays `false`) until `now` reaches `at`, so
 * the comet only ever starts *after* the whole board has finished turning
 * green, right where that ripple ends — see `render()`'s doc comment.
 * `edgesRef` guards against a stale pending start ever being applied to a
 * *different* state that happens to become completed later (shouldn't
 * really be reachable, but cheap to guard).
 */
let pendingCometStart: { cell: readonly [number, number]; edgesRef: ReadonlySet<EdgeKey>; at: number } | null = null;
let cometActive = false;
let cometStartIndex = 0;
let cometStartTime = 0;

let animFrameId: number | null = null;

function edgeAnimsActive(): boolean {
  return growingEdges.size > 0 || shrinkingEdges.size > 0 || pulsingEdges.size > 0;
}

function pruneFinishedEdgeAnims(now: number): void {
  for (const [ek, start] of growingEdges) if (now - start >= GROW_MS) growingEdges.delete(ek);
  for (const [ek, a] of shrinkingEdges) if (now - a.start >= SHRINK_MS) shrinkingEdges.delete(ek);
  for (const [ek, a] of pulsingEdges) if (now - a.start - a.delay >= PULSE_MS) pulsingEdges.delete(ek);
}

/** Called by every "jump straight to a new state" mutation (undo/redo/Give Up/review navigation) so a leftover in-flight animation never gets reinterpreted against a state it no longer describes. */
function clearEdgeAnimations(): void {
  growingEdges.clear();
  shrinkingEdges.clear();
  pulsingEdges.clear();
  pendingCometStart = null;
}

/**
 * Cancels the live game's `requestAnimationFrame` chain outright, rather
 * than waiting for `render()`'s own "reschedule while anything's active"
 * check to lapse naturally — necessary because the win-comet (once a puzzle
 * is completed) runs forever, so that check alone would never stop firing
 * on a screen the player has since navigated away from (`exitGame`). Safe
 * to call even when nothing is running. The win-loop/comet cache heals
 * itself the next time `render()` actually runs against a fresh state (see
 * its own doc comment), so there's nothing else to reset here.
 */
function stopLiveAnimationLoop(): void {
  if (animFrameId !== null) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }
}

/**
 * Schedules the visual grow/shrink/recolor-ripple animation for one edge
 * transition — a live toggle (`setPathState`) or a single replay-frame step
 * (`showReplayFrame`) alike. `toggledEdges` is exactly which edges flipped
 * presence (a live toggle already knows this from its `PathOp`s; a replay
 * step derives it as the symmetric difference between consecutive frames'
 * edge sets, which works uniformly whether that frame came from a real move
 * or an undo/redo jump). An edge newly present starts a grow, one newly
 * absent freezes its current color and starts a shrink (see `render.ts`'s
 * `ShrinkingEdges`).
 *
 * For the recolor ripple: an ordinary toggle uses `computeRecoloredEdges`,
 * which only flags an edge whose *persistent display color* actually
 * changed (a merge or split) — comparing `colorState`'s actual before/after
 * colors (via `snapshotEdgeColors`/`previewComponentColors`), not raw
 * `computeEdgeComponents` ids, see `computeRecoloredEdges`'s doc comment for
 * why that distinction matters. The winning toggle instead uses `computeReachableEdges` — since a
 * win means every remaining edge is now one single component about to
 * switch to the solved color, filtering by "did the id change" would (by
 * incidental id-numbering luck) leave a chunk of the board jumping straight
 * to green with no animation — so every reachable edge ripples instead, so a
 * win visibly reads as the same animation, not a different one. The winning
 * ripple keeps `RIPPLE_STAGGER_MS`'s ordinary constant per-hop pace; an
 * ordinary (non-winning) ripple instead speeds up geometrically via
 * `midgameRippleDelayMs` — see its doc comment for why the two use different
 * timing. On a win, this also arranges for the win-comet to pick up exactly
 * where that ripple leaves off — see `pendingCometStart`'s doc comment.
 *
 * `colorState` is whichever `ComponentColorState` actually reflects
 * `prevEdges` right now (`liveComponentColors` for a live toggle,
 * `reviewComponentColors` for a replay step) — see `main.ts`'s "Animations"
 * doc comment for why that's always true without this function having to
 * recompute anything itself.
 */
function scheduleToggleAnimation(colorState: ComponentColorState, prevEdges: ReadonlySet<EdgeKey>, nextEdges: ReadonlySet<EdgeKey>, toggledEdges: ReadonlySet<EdgeKey>, justWon: boolean): void {
  if (toggledEdges.size === 0) return;

  const now = performance.now();
  const prevColors = snapshotEdgeColors(colorState, prevEdges);
  // Non-mutating dry run of the same color assignment `render()`'s own
  // `updateComponentColors` call will commit for `nextEdges` right after
  // this returns — see `previewComponentColors`'s doc comment for why this
  // has to be the actual persistent colors, not a fresh, independent
  // `computeEdgeComponents` numbering.
  const nextColors = previewComponentColors(colorState, nextEdges);

  for (const ek of toggledEdges) {
    growingEdges.delete(ek);
    shrinkingEdges.delete(ek);
    pulsingEdges.delete(ek);
    if (nextEdges.has(ek) && !prevEdges.has(ek)) {
      growingEdges.set(ek, now);
    } else if (prevEdges.has(ek) && !nextEdges.has(ek)) {
      shrinkingEdges.set(ek, { start: now, color: segmentColor(prevColors.get(ek)!) });
    }
  }

  const rippleEdges = justWon ? computeReachableEdges(prevEdges, nextEdges, toggledEdges) : computeRecoloredEdges(prevEdges, nextEdges, toggledEdges, prevColors, nextColors);
  for (const { edge, distance } of rippleEdges) {
    if (growingEdges.has(edge) || shrinkingEdges.has(edge)) continue;
    const delay = justWon ? distance * RIPPLE_STAGGER_MS : midgameRippleDelayMs(distance);
    pulsingEdges.set(edge, { start: now, delay, fromColor: segmentColor(prevColors.get(edge)!) });
  }

  // `rippleEdges` is exactly "which edges just recolored" (see above) —
  // the chime plays once per toggle that actually caused one, not once per
  // recolored edge, since a single merge/split reads as one event even when
  // it recolors a whole component's worth of edges at once. Fires for both
  // a live toggle and a replayed one (every call site above funnels through
  // here), since the ripple itself already plays either way. The win case
  // is deliberately excluded: every remaining edge "recoloring" to the flat
  // solved color on a win isn't a component color *change* in the same
  // sense — that gets its own distinct win sound below instead.
  if (!justWon && rippleEdges.length > 0) playSfx('componentColorChange');

  if (justWon) {
    playSfx('win');
    const farthest = computeFarthestCell(nextEdges, toggledEdges);
    pendingCometStart = farthest ? { cell: farthest.cell, edgesRef: nextEdges, at: now + farthest.distance * RIPPLE_STAGGER_MS + PULSE_MS } : null;
  }
}

/** The edges present in exactly one of `a`/`b` — what actually changed between two edge sets, regardless of whether that change came from a `PathOp` or an arbitrary jump (undo/redo, a replay frame). */
function symmetricDifference(a: ReadonlySet<EdgeKey>, b: ReadonlySet<EdgeKey>): Set<EdgeKey> {
  const result = new Set<EdgeKey>();
  for (const ek of a) if (!b.has(ek)) result.add(ek);
  for (const ek of b) if (!a.has(ek)) result.add(ek);
  return result;
}

function activePuzzle(): Puzzle {
  if (mode === 'reviewing' && reviewPuzzle) return reviewPuzzle;
  if (mode === 'blitz') return blitzPuzzle;
  if (mode === 'blitzReplay' && blitzReplayPuzzle) return blitzReplayPuzzle;
  return puzzle;
}

function activeRegionMap(): RegionMap {
  if (mode === 'reviewing' && reviewRegionMap) return reviewRegionMap;
  if (mode === 'blitz') return blitzRegionMap;
  if (mode === 'blitzReplay' && blitzReplayRegionMap) return blitzReplayRegionMap;
  return regionMap;
}

/**
 * Draws the current frame and, if any edge/win-loop animation is still in
 * flight, reschedules itself via `requestAnimationFrame` to keep going —
 * every other call site just calls `render()` once, exactly as before
 * animations existed; this function is the only place that decides whether
 * a *follow-up* frame is needed. `animFrameId` guards against ever having
 * more than one such chain running at once (harmless either way, since
 * every frame just redraws the same live state, but wasteful). Only ever
 * called while `screen === 'game'` — see each call site.
 *
 * Also owns the win-loop cycle cache and the win-comet built on it:
 * `completed` is `reviewWon` while reviewing (deliberately excluding
 * `gaveUp` — a given-up puzzle was *not* actually won, see its doc
 * comment) or `pathState.won` while playing. `winLoopCells` is only
 * recomputed when `completed` newly holds *or* the edge set it was
 * computed from has changed by reference — covering a fresh win, opening a
 * different already-completed puzzle in review, and replay reaching (or
 * leaving) its final frame, all without recomputing on every single one of
 * the animation's own re-renders.
 *
 * Whenever that transition happens, the comet either starts right away
 * (`cometStartIndex = 0`) — for anything that arrives at a completed state
 * with no ripple to wait for, e.g. opening an already-completed puzzle in
 * review — or, if `scheduleToggleAnimation` just recorded a
 * `pendingCometStart` for this exact edge set (a live or replayed winning
 * toggle), waits until `pendingCometStart.at` before starting there
 * instead, so the comet always picks up right where the winning ripple
 * left off rather than racing ahead of it.
 */
function render(): void {
  const now = performance.now();
  pruneFinishedEdgeAnims(now);

  // Four mutually-exclusive shapes, one per `Mode` — see `Mode`'s doc
  // comment for why `'blitz'`/`'blitzReplay'` need their own branches here
  // exactly like `'reviewing'` already did. `completed` (below) is tracked
  // separately from `state.won` because a given-up puzzle (`'playing'` +
  // `gaveUp`) draws with the flat solved color but must *not* run the
  // win-loop/comet machinery — see CLAUDE.md's "Give Up" section.
  let state: { puzzle: Puzzle; edges: ReadonlySet<EdgeKey>; won: boolean; focusedRegion: Region | null; keyboardCursor: Face | null };
  let completed: boolean;
  let usesReviewColorState: boolean;
  if (mode === 'reviewing' && reviewPuzzle) {
    state = { puzzle: reviewPuzzle, edges: reviewEdges, won: reviewWon, focusedRegion: null, keyboardCursor: null };
    completed = reviewWon;
    usesReviewColorState = true;
  } else if (mode === 'blitz') {
    state = { puzzle: blitzPuzzle, edges: blitzPathState.edges, won: blitzPathState.won, focusedRegion: focusedRegionId !== null ? blitzRegionMap.regions[focusedRegionId] : null, keyboardCursor };
    completed = blitzPathState.won;
    usesReviewColorState = false;
  } else if (mode === 'blitzReplay' && blitzReplayPuzzle) {
    state = { puzzle: blitzReplayPuzzle, edges: blitzReplayPathState.edges, won: blitzReplayPathState.won, focusedRegion: null, keyboardCursor: null };
    completed = blitzReplayPathState.won;
    usesReviewColorState = true;
  } else {
    state = {
      puzzle,
      edges: pathState.edges,
      // Drawn with the same single "solved" color as an actual win once given
      // up — `pathState.won` itself stays false (it wasn't a real win, see
      // `gaveUp`'s doc comment), this only affects how the revealed solution
      // looks on screen.
      won: pathState.won || gaveUp,
      focusedRegion: focusedRegionId !== null ? regionMap.regions[focusedRegionId] : null,
      keyboardCursor,
    };
    completed = pathState.won;
    usesReviewColorState = false;
  }

  // A win has nothing to color (one component, the flat "solved" color) --
  // skip the update entirely rather than computing colors nothing will use.
  const componentColors = state.won ? null : updateComponentColors(usesReviewColorState ? reviewComponentColors : liveComponentColors, state.edges);

  if (completed) {
    if (winLoopEdgesRef !== state.edges) {
      winLoopCells = orderLoopCells(state.edges);
      winLoopEdgesRef = state.edges;
      if (pendingCometStart && pendingCometStart.edgesRef === state.edges) {
        cometActive = false; // wait for the winning ripple to finish -- see below
      } else {
        cometActive = true;
        cometStartIndex = 0;
        cometStartTime = now;
        pendingCometStart = null;
      }
    }
    if (!cometActive && pendingCometStart && pendingCometStart.edgesRef === state.edges && now >= pendingCometStart.at) {
      const idx = winLoopCells?.findIndex(([x, y]) => x === pendingCometStart!.cell[0] && y === pendingCometStart!.cell[1]) ?? -1;
      cometStartIndex = idx >= 0 ? idx : 0;
      cometStartTime = pendingCometStart.at;
      cometActive = true;
      pendingCometStart = null;
    }
  } else if (winLoopEdgesRef !== null) {
    winLoopCells = null;
    winLoopEdgesRef = null;
    cometActive = false;
    pendingCometStart = null;
  }

  const anim: AnimationState = {
    now,
    growing: growingEdges.size > 0 ? growingEdges : undefined,
    shrinking: shrinkingEdges.size > 0 ? shrinkingEdges : undefined,
    pulsing: pulsingEdges.size > 0 ? pulsingEdges : undefined,
    winComet: winLoopCells && cometActive ? { cells: winLoopCells, startIndex: cometStartIndex, startTime: cometStartTime } : undefined,
  };

  draw(ctx, canvas.width, canvas.height, { ...state, anim, componentColors }, LAYOUT, view);

  if (animFrameId === null && (edgeAnimsActive() || winLoopCells !== null)) {
    animFrameId = requestAnimationFrame(() => {
      animFrameId = null;
      render();
    });
  }
}

function setFocusedRegion(id: number | null): void {
  focusedRegionId = id;
  render();
}

/**
 * Updates the keyboard cursor and, if it moved, auto-scrolls the view to
 * keep it on screen — the same idea as a text editor scrolling to follow
 * its caret. `render()` first so the moved cursor is actually drawn onto the
 * canvas bitmap (needed even when no pan happens, and needed *before*
 * `setView` for a wraparound board, whose `applyTransform` redraws from the
 * current state at the new view); `setView` only runs when a pan is
 * actually needed (`panToKeepVisible` returns the same `view` reference
 * otherwise), so ordinary cursor movement within a screenful of board causes
 * no extra work.
 */
function setKeyboardCursor(cursor: Face | null): void {
  keyboardCursor = cursor;
  render();
  if (cursor) {
    const [px, py] = faceToScreen(cursor, LAYOUT);
    const next = panToKeepVisible(view, px, py, wrapEl.clientWidth, wrapEl.clientHeight, KEYBOARD_CURSOR_SCROLL_MARGIN);
    if (next !== view) setView(next);
  }
}

/** An ordinary board's pan/zoom is a cheap CSS transform on the whole canvas element. A wraparound board instead bakes pan/zoom into the canvas drawing itself (see `render.ts`'s `drawWrapped`), since the board tiles genuinely infinitely — there's no fixed-size bitmap a CSS transform could pan across — so it keeps the canvas untransformed and re-renders on every view change instead. */
function applyTransform(): void {
  if (activePuzzle().topology) {
    canvas.style.transform = '';
    render();
  } else {
    canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  }
}

function updateProgress(): void {
  progressEl.textContent = `${pathState.edges.size} / ${totalCells(puzzle)}`;
}

function updatePuzzleLabel(): void {
  const opt = sizeOption(currentPuzzleId.sizeKey);
  const shapeOpt = shapeModeOption(currentPuzzleId.shapeMode);
  const shapeSuffix = currentPuzzleId.shapeMode === 'rect' ? '' : ` (${shapeOpt.label})`;
  const collectionCount = puzzle.edgeCollections?.length ?? 0;
  const collectionSuffix = collectionCount > 0 ? ` · ${collectionCount} link${collectionCount > 1 ? 's' : ''}` : '';
  puzzleLabelEl.textContent = `${opt.label}${shapeSuffix}${collectionSuffix}`;
}

/** Give Up only makes sense on a live, not-yet-decided game: not once the player has actually won, and not a second time once the solution is already showing. */
function giveUpAllowed(): boolean {
  return !pathState.won && !gaveUp;
}

/** Undo/Redo only ever act on the live, not-yet-won game — once a puzzle is won, editing (and so undoing) is already blocked everywhere else (input.ts/keyboard.ts refuse edits when `won`), so there's no "undo the winning move" case to reconcile with `recordCompletion` having already fired. Giving up blocks editing the same way a win does (see `gaveUp`'s doc comment), so it's excluded here too — there's nothing to undo back into a revealed solution. */
function undoRedoAllowed(): boolean {
  return !pathState.won && !gaveUp;
}

/**
 * A puzzle is "complete" — Undo/Redo/Give Up give way to Rematch/Replay in
 * the control bar — the instant it's either genuinely won or given up on;
 * see CLAUDE.md's "In-game controls" section for the exact button set in
 * each state. `viewReplayBtn` is further restricted to a real win: giving
 * up was never recorded (`revealSolution`'s doc comment), so there's no
 * move log to replay.
 */
function refreshControlBar(): void {
  const complete = pathState.won || gaveUp;
  activeControlsEl.classList.toggle('hidden', complete);
  completeControlsEl.classList.toggle('hidden', !complete);
  undoBtn.disabled = !undoRedoAllowed() || !canUndo(history);
  redoBtn.disabled = !undoRedoAllowed() || !canRedo(history);
  giveUpBtn.disabled = !giveUpAllowed();
  viewReplayBtn.classList.toggle('hidden', !pathState.won);
}

function persistLiveState(): void {
  const edges = [...pathState.edges];
  if (pathState.won) {
    pendingPersist = recordCompletion(currentPuzzleId, edges, history.moveLog).catch((err: unknown) => console.error('failed to record completion', err));
  } else {
    pendingPersist = saveInProgress(currentPuzzleId, edges, history).catch((err: unknown) => console.error('failed to save progress', err));
  }
}

/** Called by pointer/keyboard input with every path change plus exactly which ops produced it (see `PathOp`), so this is the single funnel point that records undo/redo + replay history — nothing else touches `history` for in-game edits. Only ever reached while `mode === 'playing'` — `setPathState` below routes a Blitz edit to `setBlitzPathState` instead, and reviewing/blitz-replay never call in here at all (`inputPathState()` reports `won: true` for both, which blocks `input.ts`/`keyboard.ts` from ever producing an edit). */
function setFreePlayPathState(next: PathState, ops: PathOp[]): void {
  const prev = pathState;
  const justWon = next.won && !prev.won;
  const toggled = new Set<EdgeKey>();
  for (const op of ops) for (const ek of op.edges) toggled.add(ek);
  scheduleToggleAnimation(liveComponentColors, prev.edges, next.edges, toggled, justWon);
  pathState = next;
  history = recordMove(history, prev, ops);
  updateProgress();
  refreshControlBar();
  render();
  if (justWon) winBannerEl.classList.add('show');
  persistLiveState();
}

/**
 * The single `GameInputHost`/`KeyboardInputHost` edit funnel, routed by
 * `mode` — Free Play's own history/persistence (`setFreePlayPathState`) or a
 * live Blitz run's move recording + puzzle-solved handling
 * (`setBlitzPathState`, defined in the Blitz section below). Every call here
 * represents one real tap/keypress toggling a region (`input.ts`/
 * `keyboard.ts` are the only callers), so this is also the one place that
 * plays the region-toggle click — deliberately *not* played from inside
 * `scheduleToggleAnimation`, which is shared with replay's simulated
 * toggles (see its own sfx hooks) and shouldn't re-click for those.
 */
function setPathState(next: PathState, ops: PathOp[]): void {
  playSfx('regionToggle');
  if (mode === 'blitz') {
    setBlitzPathState(next, ops);
    return;
  }
  setFreePlayPathState(next, ops);
}

function performUndo(): void {
  if (!undoRedoAllowed()) return;
  const result = undoHistory(history, pathState);
  if (!result) return;
  clearEdgeAnimations();
  history = result.history;
  pathState = result.state;
  focusedRegionId = null;
  updateProgress();
  refreshControlBar();
  render();
  persistLiveState();
}

function performRedo(): void {
  if (!undoRedoAllowed()) return;
  const result = redoHistory(history, pathState);
  if (!result) return;
  clearEdgeAnimations();
  history = result.history;
  pathState = result.state;
  focusedRegionId = null;
  updateProgress();
  refreshControlBar();
  render();
  persistLiveState();
}

/**
 * Reveals the puzzle's intended solution (the hidden Hamiltonian cycle it
 * was generated from — `puzzleGen.ts`'s `generateSolutionEdges`) and blocks
 * further editing, without treating it as a win: no `recordCompletion`, and
 * — unlike every other path mutation in this file — nothing written to
 * `persistLiveState`, so a reload resumes whatever was actually in progress
 * before Give Up was pressed, exactly as if it had never happened.
 * `pathState.won` deliberately stays `false` (it wasn't a real win);
 * `gaveUp` is what blocks input instead (see its doc comment).
 *
 * A puzzle with edge collections may not have this exact cycle as a valid
 * win at all (`generateSolutionEdges`'s doc comment) — the button still
 * shows it anyway, since it's the intended answer regardless of whether the
 * player's particular collection constraints happen to also accept it.
 */
function revealSolution(): void {
  if (!giveUpAllowed()) return;
  const confirmed = window.confirm('Give up and reveal the intended solution? This puzzle will no longer count as solved.');
  if (!confirmed) return;

  clearEdgeAnimations();
  pathState = { edges: generateSolutionEdges(currentPuzzleId), won: false };
  gaveUp = true;
  focusedRegionId = null;
  keyboardCursor = null;
  updateProgress();
  refreshControlBar();
  winBannerEl.textContent = 'Here’s the solution';
  winBannerEl.classList.add('gaveUp', 'show');
  render();
}

/** Restores `#winBanner` to its default hidden, "Loop complete!" state — shared by every place that starts a fresh live attempt (a real win's banner is set explicitly by `setPathState`; a given-up one by `revealSolution`). */
function resetWinBanner(): void {
  winBannerEl.classList.remove('show', 'gaveUp');
  winBannerEl.textContent = 'Loop complete!';
}

function showToast(message: string): void {
  if (toastTimerId !== null) window.clearTimeout(toastTimerId);
  toastEl.textContent = message;
  toastEl.classList.add('show');
  toastTimerId = window.setTimeout(() => {
    toastEl.classList.remove('show');
    toastTimerId = null;
  }, TOAST_MS);
}

function setView(next: Viewport): void {
  view = next;
  applyTransform();
}

/**
 * "Fit to view" always means fitting one board-tile's span within the wrap
 * element — for a wraparound board this is exactly the same computation as
 * an ordinary board, since the primary tile sits at the canvas's own local
 * origin (see `render.ts`'s `drawWrapped`); there's no separate halo origin
 * to shift around anymore now that the tiling is computed fresh each draw
 * from the current view instead of pre-rendered.
 */
function fitView(): void {
  const { w, h } = boardPixelSize(activePuzzle(), LAYOUT);
  setView(computeFitView(w, h, wrapEl.clientWidth, wrapEl.clientHeight, VIEW_BOUNDS));
}

/**
 * A wraparound board's canvas is sized to the visible viewport itself
 * (content is drawn fresh each frame relative to the current pan/zoom, see
 * `render.ts`), rather than to a fixed board-derived size — so it has to be
 * kept in sync with the wrap element's size, including on window resize
 * (unlike an ordinary board, whose canvas size never changes after the
 * initial layout).
 */
function layout(): void {
  const puzzle = activePuzzle();
  if (puzzle.topology) {
    canvas.width = wrapEl.clientWidth;
    canvas.height = wrapEl.clientHeight;
  } else {
    const { w, h } = boardPixelSize(puzzle, LAYOUT);
    canvas.width = w;
    canvas.height = h;
  }
  fitView();
  render();
}

const LAST_SIZE_STORAGE_KEY = 'loopit:lastSize';
const LAST_SHAPE_STORAGE_KEY = 'loopit:lastShape';
const LAST_REPLAY_SPEED_KEY = 'loopit:replaySpeed';
/** Must match `replaySpeedSelect`'s `<option>` values in `index.html` exactly. */
const REPLAY_SPEED_OPTIONS = [0.25, 0.5, 1, 2];

/**
 * Puts a fresh (or resumed) puzzle on screen and switches to the `'game'`
 * screen — the one place `main.ts` actually starts playing something,
 * shared by New Game, Resume, and Rematch. `resume`, when given, is an
 * exact prior save (edges + its undo/redo history) to restore instead of
 * starting from an empty board; New Game and Rematch never pass it (a
 * random `seed` is a *fresh* puzzle even if it happens to be the same
 * size/shape as one already in progress — see `puzzleGen.ts`'s
 * `randomSeed`).
 */
function beginPuzzle(id: PuzzleId, resume?: { edges: EdgeKey[]; history?: HistoryState }): void {
  stopLiveAnimationLoop();
  stopBlitzTimer();
  pauseBlitzReplay();
  clearEdgeAnimations();
  resetWinLoopState();
  resetComponentColorState(liveComponentColors);
  localStorage.setItem(LAST_SIZE_STORAGE_KEY, id.sizeKey);
  localStorage.setItem(LAST_SHAPE_STORAGE_KEY, id.shapeMode);

  // Defensive resets in case the previous screen was a Blitz run/replay,
  // which repurpose these same header/bar elements — see index.html's doc
  // comment on `#gameScreen`. A no-op when coming from anywhere else.
  headerInfoEl.classList.remove('hidden');
  blitzHeaderInfoEl.classList.add('hidden');
  exitBtn.classList.remove('hidden');
  blitzExitBtn.classList.add('hidden');
  playControlsEl.classList.remove('hidden');
  reviewBarEl.classList.add('hidden');
  blitzReplayBarEl.classList.add('hidden');

  currentPuzzleId = id;
  puzzle = generatePuzzle(id);
  regionMap = computeRegions(puzzle);
  pathState = resume ? { edges: new Set(resume.edges), won: false } : createInitialPath();

  if (resume?.history) {
    history = resume.history;
  } else {
    // Graceful fallback for a save written before undo/redo existed (or a fresh puzzle,
    // which never had history to begin with): start with empty undo/redo/move-log rather
    // than crashing on the missing field. Only worth telling the player about in the
    // resumed-old-save case — a brand-new puzzle having no history yet is completely normal.
    history = createHistory();
    if (resume) showToast("This saved game predates undo history, so it isn't available for it.");
  }

  gaveUp = false;
  resetWinBanner();
  focusedRegionId = null;
  keyboardCursor = null;
  mode = 'playing';
  updatePuzzleLabel();
  updateProgress();
  refreshControlBar();
  showScreen('game');
  layout();
}

function startNewGame(sizeKey: string, shapeMode: ShapeMode): void {
  beginPuzzle({ sizeKey, shapeMode, seed: randomSeed(), collections: NO_EDGE_COLLECTIONS });
}

/** Immediately starts a fresh puzzle with the exact same size/shape/collections as the one just finished, but a brand-new random seed — only available once the current puzzle is complete (see `refreshControlBar`). */
function rematch(): void {
  if (!(pathState.won || gaveUp)) return;
  beginPuzzle({ sizeKey: currentPuzzleId.sizeKey, shapeMode: currentPuzzleId.shapeMode, seed: randomSeed(), collections: currentPuzzleId.collections });
}

/** Jumps directly from the just-completed live game into replaying it — waits for the winning move's `recordCompletion` write to actually land (see `pendingPersist`) so the move log it reads back is never stale. */
async function viewReplayFromGame(): Promise<void> {
  if (!pathState.won) return;
  await pendingPersist;
  const record = await getCompleted(currentPuzzleId);
  if (!record) return;
  enterReview(record, 'game');
  startReplay();
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function puzzleSummaryLabel(record: { sizeKey: string; shapeMode: ShapeMode }): string {
  const opt = sizeOption(record.sizeKey);
  const shapeOpt = shapeModeOption(record.shapeMode);
  const shapeSuffix = record.shapeMode === 'rect' ? '' : ` (${shapeOpt.label})`;
  return `${opt.label}${shapeSuffix}`;
}

/** A generic Resume/Replays row: a clickable main area plus a separate delete button, so tapping the delete icon can never be mistaken for opening the item (`stopPropagation` isn't needed since they're already two distinct elements). */
function renderListItem(title: string, dateText: string, onOpen: () => void, onDelete: () => void): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'listItem';

  const main = document.createElement('button');
  main.className = 'listItemMain';
  const info = document.createElement('span');
  const titleEl = document.createElement('span');
  titleEl.className = 'listItemTitle';
  titleEl.textContent = title;
  const dateEl = document.createElement('span');
  dateEl.className = 'listItemDate';
  dateEl.textContent = dateText;
  info.append(titleEl, document.createElement('br'), dateEl);
  const chevron = document.createElement('span');
  chevron.textContent = '›';
  main.append(info, chevron);
  main.addEventListener('click', navClick(onOpen));

  const del = document.createElement('button');
  del.className = 'listItemDelete';
  del.textContent = '✕';
  del.title = 'Delete';
  del.setAttribute('aria-label', 'Delete');
  del.addEventListener('click', onDelete);

  row.append(main, del);
  return row;
}

async function refreshResumeList(): Promise<void> {
  const items = await listInProgress();
  resumeListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'listEmpty';
    empty.textContent = 'No saved games in progress.';
    resumeListEl.appendChild(empty);
    return;
  }
  for (const item of items) resumeListEl.appendChild(renderResumeItem(item));
}

function renderResumeItem(record: InProgressRecord): HTMLDivElement {
  return renderListItem(
    puzzleSummaryLabel(record),
    `${record.edges.length} edges marked · ${formatDate(record.updatedAt)}`,
    () => beginPuzzle(puzzleIdOf(record), { edges: record.edges, history: record.history }),
    () => {
      void (async () => {
        if (!window.confirm('Delete this saved game? This cannot be undone.')) return;
        await clearInProgress(puzzleIdOf(record));
        await refreshResumeList();
      })();
    },
  );
}

async function refreshReplaysList(): Promise<void> {
  const items = await listCompleted();
  replaysListEl.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'listEmpty';
    empty.textContent = 'No completed puzzles yet.';
    replaysListEl.appendChild(empty);
    return;
  }
  for (const item of items) replaysListEl.appendChild(renderReplayItem(item));
}

function renderReplayItem(record: CompletedRecord): HTMLDivElement {
  return renderListItem(
    puzzleSummaryLabel(record),
    formatDate(record.completedAt),
    () => enterReview(record, 'menu'),
    () => {
      void (async () => {
        if (!window.confirm('Delete this replay? This cannot be undone.')) return;
        await deleteCompleted(puzzleIdOf(record));
        await refreshReplaysList();
      })();
    },
  );
}

/**
 * Opens a completed puzzle in the read-only review overlay. `origin`
 * decides what "Done" (`exitReview`) returns to afterward — see
 * `reviewOrigin`'s doc comment.
 */
function enterReview(item: CompletedRecord, origin: 'game' | 'menu'): void {
  stopLiveAnimationLoop();
  stopBlitzTimer();
  pauseBlitzReplay();
  clearEdgeAnimations();
  resetWinLoopState();
  resetComponentColorState(reviewComponentColors);
  // Defensive: hide Blitz's header/bar in case the previous screen was a
  // Blitz run/replay — see `beginPuzzle`'s matching comment.
  blitzHeaderInfoEl.classList.add('hidden');
  blitzExitBtn.classList.add('hidden');
  blitzReplayBarEl.classList.add('hidden');
  headerInfoEl.classList.remove('hidden');
  const id = puzzleIdOf(item);
  reviewPuzzle = generatePuzzle(id);
  reviewRegionMap = computeRegions(reviewPuzzle);
  reviewEdges = new Set(item.edges);
  reviewWon = true;
  currentReviewItem = item;
  reviewOrigin = origin;
  mode = 'reviewing';
  focusedRegionId = null;
  keyboardCursor = null;

  reviewLabelEl.textContent = `${puzzleSummaryLabel(item)} · ${formatDate(item.completedAt)}`;
  const hasReplay = Boolean(item.moveLog && item.moveLog.length > 0);
  replayBtn.disabled = !hasReplay;
  replayBtn.title = hasReplay ? '' : "Replay isn't available — this puzzle was solved before replay support was added.";
  reviewBarEl.classList.remove('hidden');
  playControlsEl.classList.add('hidden');
  exitBtn.classList.add('hidden');
  showScreen('game');
  resetWinBanner();
  layout();
}

/** Leaves review mode: back to the live completed game (`reviewOrigin === 'game'`) or back to the Replays list it was opened from (`'menu'`) — see `reviewOrigin`'s doc comment. */
function exitReview(): void {
  closeReplay();
  clearEdgeAnimations();
  const returnToMenu = reviewOrigin === 'menu';
  mode = 'playing';
  reviewPuzzle = null;
  reviewRegionMap = null;
  currentReviewItem = null;
  focusedRegionId = null;
  keyboardCursor = null;
  reviewBarEl.classList.add('hidden');
  playControlsEl.classList.remove('hidden');
  exitBtn.classList.remove('hidden');
  if (returnToMenu) {
    showScreen('replays');
  } else {
    layout();
  }
}

function stopReplayTimer(): void {
  if (replayTimerId !== null) {
    window.clearInterval(replayTimerId);
    replayTimerId = null;
  }
  replayPlayPauseBtn.textContent = 'Play';
}

/**
 * Replay only animates the same grow/shrink/ripple juice a live toggle gets
 * at the two slowest speeds — faster than that, a new animation would just
 * get interrupted by the next frame before finishing (`GROW_MS`/`PULSE_MS`
 * are both longer than a frame at 1×/2×), reading as flicker rather than
 * motion, so it's simplest to just skip scheduling any at those speeds.
 */
function replayAnimationsEnabled(): boolean {
  return replaySpeed <= 0.5;
}

/**
 * Shows one replay frame. `animate` is true only for a natural single-step
 * forward advance (`playReplay`'s own tick) — scrubbing or the initial
 * frame jump straight to the target state instead (`clearEdgeAnimations`),
 * since a dragged scrub can span an arbitrary number of frames and there's
 * no one sensible "toggle" to animate for that. When animating, the edges
 * that actually changed are the symmetric difference between this frame and
 * the previous one, which works the same whether that step was a real move
 * or an undo/redo jump (`symmetricDifference`) — `scheduleToggleAnimation`
 * doesn't need to know which.
 */
function showReplayFrame(index: number, animate = false): void {
  const prevFrame = replayFrames[replayIndex];
  replayIndex = Math.max(0, Math.min(replayFrames.length - 1, index));
  const frame = replayFrames[replayIndex];

  if (animate && replayAnimationsEnabled() && prevFrame) {
    scheduleToggleAnimation(reviewComponentColors, prevFrame.edges, frame.edges, symmetricDifference(prevFrame.edges, frame.edges), frame.won && !prevFrame.won);
  } else {
    clearEdgeAnimations();
  }

  reviewEdges = frame.edges;
  reviewWon = frame.won;
  replayScrubberEl.value = String(replayIndex);
  replayCounterEl.textContent = `${replayIndex + 1} / ${replayFrames.length}`;
  render();
}

function playReplay(): void {
  if (replayIndex >= replayFrames.length - 1) showReplayFrame(0);
  stopReplayTimer();
  replayPlayPauseBtn.textContent = 'Pause';
  replayTimerId = window.setInterval(() => {
    if (replayIndex >= replayFrames.length - 1) {
      stopReplayTimer();
      return;
    }
    showReplayFrame(replayIndex + 1, true);
  }, REPLAY_FRAME_MS / replaySpeed);
}

function startReplay(): void {
  if (!reviewPuzzle || !currentReviewItem?.moveLog?.length) return;
  replayFrames = decodeMoveLog(reviewPuzzle, createInitialPath(), currentReviewItem.moveLog);
  reviewIdleControlsEl.classList.add('hidden');
  reviewPlaybackControlsEl.classList.remove('hidden');
  replayScrubberEl.min = '0';
  replayScrubberEl.max = String(Math.max(0, replayFrames.length - 1));
  showReplayFrame(0);
  playReplay();
}

/** Leaves playback (if any) and restores the static, fully-solved view — called on Done and when leaving review entirely. */
function closeReplay(): void {
  stopReplayTimer();
  clearEdgeAnimations();
  reviewPlaybackControlsEl.classList.add('hidden');
  reviewIdleControlsEl.classList.remove('hidden');
  if (currentReviewItem) {
    reviewEdges = new Set(currentReviewItem.edges);
    reviewWon = true;
    render();
  }
}

/** The path state input handling should see: reviewing and watching a Blitz replay both force `won: true` purely to block further edits (`input.ts`/`keyboard.ts` both gate on `.won`) without pretending either is an actual win, same as giving up already does — `pathState.won`/`blitzReplayPathState.won` themselves, and `main.ts`'s own bookkeeping, stay untouched. A live Blitz run (`mode === 'blitz'`) reports its real `blitzPathState` unmodified — solving one puzzle should stop input exactly as long as it takes `setBlitzPathState` to swap in the next one, no different from an ordinary win blocking input until the next action. */
function inputPathState(): PathState {
  if (mode === 'reviewing') return { edges: reviewEdges, won: true };
  if (mode === 'blitz') return blitzPathState;
  if (mode === 'blitzReplay') return { edges: blitzReplayPathState.edges, won: true };
  return gaveUp ? { edges: pathState.edges, won: true } : pathState;
}

const host: GameInputHost = {
  getPuzzle: () => activePuzzle(),
  getRegionMap: () => activeRegionMap(),
  getPathState: inputPathState,
  setPathState,
  getLayout: () => LAYOUT,
  getView: () => view,
  setView,
  setFocusedRegion,
  bounds: VIEW_BOUNDS,
  wrapEl,
};

attachPointerHandling(wrapEl, host);

const keyboardHost: KeyboardInputHost = {
  getPuzzle: () => activePuzzle(),
  getRegionMap: () => activeRegionMap(),
  getPathState: inputPathState,
  setPathState,
  setFocusedRegion,
  setKeyboardCursor,
  isEnabled: () => screen === 'game' && (mode === 'playing' || mode === 'blitz'),
};

attachKeyboardHandling(window, keyboardHost);

// ---- Blitz mode: live play ----

/** Milliseconds since the run's own start — the zero point every `BlitzEvent.t` is measured from (see `blitzRunStartPerf`'s doc comment). */
function blitzElapsedMs(): number {
  return performance.now() - blitzRunStartPerf;
}

/** `mm:ss`, floored to the second — used for the live countdown (which ticks once a frame and doesn't need sub-second precision) and the replay scrubber's counter. */
function formatBlitzClock(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

/** `mm:ss.t` — one decimal place, for a final score/leaderboard entry where two runs finishing within the same second are still worth distinguishing. */
function formatBlitzScore(ms: number): string {
  const totalSec = Math.max(0, ms) / 1000;
  const mm = Math.floor(totalSec / 60);
  const ss = (totalSec - mm * 60).toFixed(1).padStart(4, '0');
  return `${mm}:${ss}`;
}

function blitzPuzzleStatsLabel(id: PuzzleId, puzzlesSolvedSoFar: number): string {
  const opt = sizeOption(id.sizeKey);
  const shapeOpt = shapeModeOption(id.shapeMode);
  const shapeSuffix = id.shapeMode === 'rect' ? '' : ` (${shapeOpt.label})`;
  return `Puzzle ${puzzlesSolvedSoFar + 1} · ${opt.label}${shapeSuffix}`;
}

/** Refreshes the live-run header readout — called every timer tick (for the countdown) and on every puzzle transition (for the stats line). */
function updateBlitzHeader(): void {
  const remaining = blitzDeadline - performance.now();
  blitzTimerEl.textContent = formatBlitzClock(remaining);
  blitzTimerEl.classList.toggle('low', remaining <= BLITZ_LOW_TIME_MS);
  if (blitzCurrentId) blitzStatsEl.textContent = blitzPuzzleStatsLabel(blitzCurrentId, blitzPuzzlesSolved);
}

/**
 * Pulls the next puzzle from this run's `blitzSeq` (see
 * `game/blitz.ts`'s `createBlitzSequence`) and puts it on screen — called
 * once to start the run and again after every solve (`handleBlitzPuzzleSolved`,
 * via its short delay). Immediately credits this puzzle's own time-back
 * bonus (`timeBackPerEdgeSec * totalCells(puzzle)` seconds, CLAUDE.md: "time
 * refunded proportional to the number of edges in the solution... at the
 * start of the puzzle in question" — `totalCells` *is* that edge count, see
 * `game/blitz.ts`'s `boardEdgeCount` doc comment) onto the deadline *before*
 * the player has made a single move on it, rather than waiting for it to be
 * solved — see `game/blitz.ts`'s `BlitzEvent` doc comment for why the award
 * now lives on `puzzleStart` instead of `puzzleSolved`. Records the
 * transition as a `puzzleStart` event carrying that award; the very first
 * call of a run forces `t: 0` exactly (rather than `blitzElapsedMs()`, which
 * would be a sub-millisecond positive jitter) so `seekBlitzReplay(0)` can
 * find it with a simple `<=` comparison.
 */
function advanceBlitzPuzzle(): void {
  clearEdgeAnimations();
  resetComponentColorState(liveComponentColors);
  const id = blitzSeq!.next();
  blitzCurrentId = id;
  blitzPuzzle = generatePuzzle(id);
  blitzRegionMap = computeRegions(blitzPuzzle);
  blitzPathState = createInitialPath();
  focusedRegionId = null;
  keyboardCursor = null;
  const awardMs = Math.round(blitzParams.timeBackPerEdgeSec * 1000 * totalCells(blitzPuzzle));
  blitzDeadline += awardMs;
  blitzEvents.push({ kind: 'puzzleStart', t: blitzEvents.length === 0 ? 0 : blitzElapsedMs(), sizeKey: id.sizeKey, shapeMode: id.shapeMode, seed: id.seed, timeAwardedMs: awardMs });
  showToast(`+${(awardMs / 1000).toFixed(1)}s for this puzzle`);
  updateBlitzHeader();
  layout();
}

/**
 * A puzzle was just solved: no longer moves the clock at all (see
 * `advanceBlitzPuzzle`'s doc comment — the time-back bonus for a puzzle is
 * credited when it *starts*, not when it's solved), just tallies the solve
 * and, after a short flash (`BLITZ_ADVANCE_DELAY_MS`) so the win is actually
 * visible, moves on to the next puzzle. Guarded by `mode === 'blitz'` in the
 * timeout callback in case the run already ended (timer expired, or the
 * player forfeited) before the delay elapsed.
 */
function handleBlitzPuzzleSolved(): void {
  blitzPuzzlesSolved += 1;
  blitzEvents.push({ kind: 'puzzleSolved', t: blitzElapsedMs() });
  showToast('Solved!');
  updateBlitzHeader();
  if (blitzAdvanceTimeoutId !== null) window.clearTimeout(blitzAdvanceTimeoutId);
  blitzAdvanceTimeoutId = window.setTimeout(() => {
    blitzAdvanceTimeoutId = null;
    if (mode === 'blitz') advanceBlitzPuzzle();
  }, BLITZ_ADVANCE_DELAY_MS);
}

/** Blitz's own edit funnel (see `setPathState`'s dispatch) — no undo/redo/persistence, just move recording + win handling. */
function setBlitzPathState(next: PathState, ops: PathOp[]): void {
  const prevWon = blitzPathState.won;
  const toggled = new Set<EdgeKey>();
  for (const op of ops) for (const ek of op.edges) toggled.add(ek);
  scheduleToggleAnimation(liveComponentColors, blitzPathState.edges, next.edges, toggled, next.won && !prevWon);
  blitzPathState = next;
  blitzEvents.push({ kind: 'move', t: blitzElapsedMs(), ops });
  render();
  if (next.won && !prevWon) handleBlitzPuzzleSolved();
}

function stopBlitzTimer(): void {
  if (blitzTimerRafId !== null) {
    cancelAnimationFrame(blitzTimerRafId);
    blitzTimerRafId = null;
  }
  if (blitzAdvanceTimeoutId !== null) {
    window.clearTimeout(blitzAdvanceTimeoutId);
    blitzAdvanceTimeoutId = null;
  }
}

function blitzTick(): void {
  if (mode !== 'blitz') return;
  const remaining = blitzDeadline - performance.now();
  updateBlitzHeader();
  if (remaining <= 0) {
    void endBlitzRun();
    return;
  }
  blitzTimerRafId = requestAnimationFrame(blitzTick);
}

function startBlitzTimer(): void {
  stopBlitzTimer();
  blitzTimerRafId = requestAnimationFrame(blitzTick);
}

/** Clears the win-loop/comet cache — used when jumping straight into a brand-new Blitz run or replay, so a leftover comet from whatever was on screen before can't bleed into it (see `render()`'s own doc comment for how this cache normally self-heals from `completed` transitions alone; a mode switch is the one case that isn't itself such a transition). */
function resetWinLoopState(): void {
  winLoopCells = null;
  winLoopEdgesRef = null;
  cometActive = false;
  pendingCometStart = null;
}

/** Starts a brand-new run: mints a fresh random seed (independent of `params` — see `BlitzParams`'s doc comment), resets every piece of live-run state, and shows the first puzzle. */
function startBlitzRun(params: BlitzParams): void {
  stopLiveAnimationLoop();
  stopBlitzTimer();
  pauseBlitzReplay();
  clearEdgeAnimations();
  resetWinLoopState();
  resetComponentColorState(liveComponentColors);

  blitzParams = params;
  blitzRunSeed = randomSeed();
  blitzSeq = createBlitzSequence(blitzRunSeed);
  blitzEvents = [];
  blitzPuzzlesSolved = 0;
  blitzRunStartPerf = performance.now();
  blitzRunStartedAt = Date.now();
  blitzDeadline = blitzRunStartPerf + params.startingTimeSec * 1000;
  mode = 'blitz';
  focusedRegionId = null;
  keyboardCursor = null;

  resetWinBanner();
  headerInfoEl.classList.add('hidden');
  blitzHeaderInfoEl.classList.remove('hidden');
  exitBtn.classList.add('hidden');
  blitzExitBtn.classList.remove('hidden');
  playControlsEl.classList.add('hidden');
  reviewBarEl.classList.add('hidden');
  blitzReplayBarEl.classList.add('hidden');

  // `showScreen('game')` must run before `advanceBlitzPuzzle()`'s `layout()`
  // — `#gameScreen` is still `.hidden` (`display: none`) up to that call, so
  // `wrapEl.clientWidth`/`clientHeight` would read 0 and `fitView()` would
  // compute a bogus/degenerate view (see `layout()`'s doc comment for why
  // every other mode-entry function — `beginPuzzle`, `enterReview`,
  // `openBlitzReplay` — already does `showScreen('game')` first).
  showScreen('game');
  advanceBlitzPuzzle();
  startBlitzTimer();
}

function showBlitzGameOver(record: BlitzRunRecord | null, scoreMs: number): void {
  blitzGameOverScoreEl.textContent = `You lasted ${formatBlitzScore(scoreMs)} and solved ${blitzPuzzlesSolved} puzzle${blitzPuzzlesSolved === 1 ? '' : 's'}.`;
  blitzGameOverReplayBtn.disabled = !record;
  showScreen('blitzGameOver');
}

/** Ends the current run (timer hit zero, or the player forfeited) — records it (score = total real time survived, CLAUDE.md's "final score is the total amount of time they lasted") and shows the game-over screen. Guarded by `mode === 'blitz'` so the timer's own expiry check and an explicit forfeit can't both fire. */
async function endBlitzRun(): Promise<void> {
  if (mode !== 'blitz') return;
  stopBlitzTimer();
  const scoreMs = Math.max(0, blitzElapsedMs());
  blitzEvents.push({ kind: 'runEnd', t: scoreMs, scoreMs });
  clearEdgeAnimations();
  mode = 'playing';

  let saved: BlitzRunRecord | null = null;
  try {
    saved = await saveBlitzRun({
      seed: blitzRunSeed,
      startingTimeSec: blitzParams.startingTimeSec,
      timeBackPerEdgeSec: blitzParams.timeBackPerEdgeSec,
      scoreMs,
      puzzlesSolved: blitzPuzzlesSolved,
      startedAt: blitzRunStartedAt,
      completedAt: Date.now(),
      events: blitzEvents,
    });
  } catch (err) {
    console.error('failed to save blitz run', err);
  }
  blitzLastRecord = saved;
  showBlitzGameOver(saved, scoreMs);
}

function forfeitBlitzRun(): void {
  if (mode !== 'blitz') return;
  if (!window.confirm('Forfeit this Blitz run? Your score so far will still be recorded.')) return;
  void endBlitzRun();
}

// ---- Blitz mode: leaderboard ----

/** The leaderboard's per-difficulty heading — the matching pace preset's name ("Slow"/"Normal"/"Fast") when `params` matches one exactly, or the raw numbers as a fallback for a run recorded before the pace presets existed (see `paceForParams`). */
function formatBlitzParamsLabel(params: BlitzParams): string {
  const pace = paceForParams(params);
  if (pace) return BLITZ_PACE_OPTIONS.find((opt) => opt.key === pace)!.label;
  return `${params.startingTimeSec}s start · +${params.timeBackPerEdgeSec}s/edge`;
}

async function refreshBlitzLeaderboardList(): Promise<void> {
  const diffs = await listBlitzDifficulties();
  blitzLeaderboardListEl.replaceChildren();
  if (diffs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'listEmpty';
    empty.textContent = 'No Blitz runs recorded yet.';
    blitzLeaderboardListEl.appendChild(empty);
    return;
  }
  for (const d of diffs) blitzLeaderboardListEl.appendChild(renderBlitzDifficultyItem(d));
}

function renderBlitzDifficultyItem(d: BlitzDifficultySummary): HTMLDivElement {
  return renderListItem(
    formatBlitzParamsLabel(d),
    `${d.runCount} run${d.runCount === 1 ? '' : 's'} · best ${formatBlitzScore(d.bestScoreMs)} · ${formatDate(d.lastPlayedAt)}`,
    () => openBlitzLeaderboardRuns(d),
    () => {
      void (async () => {
        if (!window.confirm(`Delete all ${d.runCount} run(s) at this difficulty? This cannot be undone.`)) return;
        await deleteBlitzRunsForParams(d);
        await refreshBlitzLeaderboardList();
      })();
    },
  );
}

function openBlitzLeaderboardRuns(params: BlitzParams): void {
  currentLeaderboardParams = params;
  blitzLeaderboardRunsTitleEl.textContent = formatBlitzParamsLabel(params);
  showScreen('blitzLeaderboardRuns');
}

async function refreshBlitzLeaderboardRunsList(): Promise<void> {
  blitzLeaderboardRunsListEl.replaceChildren();
  if (!currentLeaderboardParams) return;
  const runs = await listBlitzRunsForParams(currentLeaderboardParams);
  if (runs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'listEmpty';
    empty.textContent = 'No runs at this difficulty.';
    blitzLeaderboardRunsListEl.appendChild(empty);
    return;
  }
  runs.forEach((run, rank) => blitzLeaderboardRunsListEl.appendChild(renderBlitzRunItem(run, rank)));
}

function renderBlitzRunItem(run: BlitzRunRecord, rank: number): HTMLDivElement {
  return renderListItem(
    `#${rank + 1} · ${formatBlitzScore(run.scoreMs)} · ${run.puzzlesSolved} solved`,
    formatDate(run.completedAt),
    () => openBlitzReplay(run, 'blitzLeaderboardRuns'),
    () => {
      void (async () => {
        if (!window.confirm('Delete this run? This cannot be undone.')) return;
        await deleteBlitzRun(run.id);
        await refreshBlitzLeaderboardRunsList();
      })();
    },
  );
}

// ---- Blitz mode: real-time run replay ----
// Distinct from `startReplay`/`showReplayFrame` above (which replay a single
// *puzzle's* move log): this replays a whole *run* — potentially many
// puzzles — at real pace, driven by each `BlitzEvent`'s own timestamp rather
// than a frame index. See `game/blitz.ts`'s `BlitzEvent` doc comment.

function blitzReplayDurationMs(): number {
  if (!blitzReplayRecord || blitzReplayRecord.events.length === 0) return 0;
  return blitzReplayRecord.events[blitzReplayRecord.events.length - 1].t;
}

/**
 * Applies one event to the replay's own puzzle/path state — the exact same
 * state transitions live play made, just replayed instead of performed.
 * `puzzleStart` calls `layout()` for the same reason `advanceBlitzPuzzle()`
 * (live play) does: each puzzle in a run can be a different size, and
 * `layout()` is what resizes the canvas to the new puzzle's board and
 * re-fits the view to it. Without this, the canvas stayed sized (and the
 * view fitted) to whichever board the *first* `puzzleStart` event set it
 * to, cropping every later, larger board even when zoomed out — a plain
 * `render()` redraws the current puzzle but never revisits the canvas's
 * own pixel dimensions or the view. Safe to call regardless of which
 * caller reached here (`seekBlitzReplay`'s initial/scrub jump or
 * `advanceBlitzReplayTo`'s natural forward step): both only ever run once
 * `mode === 'blitzReplay'` and `#gameScreen` is already the visible
 * screen, so `wrapEl`'s size (which `fitView()` inside `layout()` reads) is
 * always real by the time any `puzzleStart` event is applied.
 */
function applyBlitzReplayEvent(ev: BlitzEvent): void {
  switch (ev.kind) {
    case 'puzzleStart': {
      const id: PuzzleId = { sizeKey: ev.sizeKey, shapeMode: ev.shapeMode, seed: ev.seed, collections: NO_EDGE_COLLECTIONS };
      blitzReplayCurrentId = id;
      blitzReplayPuzzle = generatePuzzle(id);
      blitzReplayRegionMap = computeRegions(blitzReplayPuzzle);
      blitzReplayPathState = createInitialPath();
      resetComponentColorState(reviewComponentColors);
      blitzReplayAwardedMs += ev.timeAwardedMs;
      layout();
      break;
    }
    case 'move':
      if (blitzReplayPuzzle) {
        for (const op of ev.ops) blitzReplayPathState = applyPathOp(blitzReplayPathState, blitzReplayPuzzle, op);
      }
      break;
    case 'puzzleSolved':
      blitzReplaySolved += 1;
      break;
    case 'runEnd':
      break;
  }
}

function resetBlitzReplayState(): void {
  blitzReplayPuzzle = null;
  blitzReplayRegionMap = null;
  blitzReplayCurrentId = null;
  blitzReplayPathState = createInitialPath();
  blitzReplayAwardedMs = 0;
  blitzReplaySolved = 0;
  blitzReplayEventCursor = 0;
  blitzReplayT = 0;
}

function updateBlitzReplayUI(): void {
  const duration = blitzReplayDurationMs();
  blitzReplayScrubberEl.max = String(Math.max(0, Math.round(duration)));
  blitzReplayScrubberEl.value = String(Math.round(blitzReplayT));
  blitzReplayCounterEl.textContent = `${formatBlitzClock(blitzReplayT)} / ${formatBlitzClock(duration)}`;

  const remaining = (blitzReplayRecord ? blitzReplayRecord.startingTimeSec * 1000 : 0) + blitzReplayAwardedMs - blitzReplayT;
  blitzTimerEl.textContent = formatBlitzClock(remaining);
  blitzTimerEl.classList.toggle('low', remaining <= BLITZ_LOW_TIME_MS);
  blitzStatsEl.textContent = blitzReplayCurrentId ? blitzPuzzleStatsLabel(blitzReplayCurrentId, blitzReplaySolved) : '';
}

/**
 * Jumps straight to `targetT`, snapping (no animation) — replays from the
 * very start every time rather than trying to step backward from wherever
 * playback currently is, the same simplifying tradeoff `decodeMoveLog`
 * already makes for the ordinary per-puzzle replay. Used for the initial
 * open (`targetT: 0`) and for scrubbing.
 */
function seekBlitzReplay(targetT: number): void {
  resetBlitzReplayState();
  clearEdgeAnimations();
  resetWinLoopState();
  if (!blitzReplayRecord) return;
  const clamped = Math.max(0, Math.min(targetT, blitzReplayDurationMs()));
  const events = blitzReplayRecord.events;
  while (blitzReplayEventCursor < events.length && events[blitzReplayEventCursor].t <= clamped) {
    applyBlitzReplayEvent(events[blitzReplayEventCursor]);
    blitzReplayEventCursor++;
  }
  blitzReplayT = clamped;
  updateBlitzReplayUI();
  render();
}

/** Advances playback forward from wherever it currently is to `target`, applying every event in between in order — animated (grow/shrink/ripple, exactly like a live toggle) when `animate` is true, i.e. only for `blitzReplayTick`'s own natural forward steps; scrubbing always snaps via `seekBlitzReplay` instead. */
function advanceBlitzReplayTo(target: number, animate: boolean): void {
  if (!blitzReplayRecord) return;
  const events = blitzReplayRecord.events;
  while (blitzReplayEventCursor < events.length && events[blitzReplayEventCursor].t <= target) {
    const ev = events[blitzReplayEventCursor];
    if (animate && ev.kind === 'move' && blitzReplayPuzzle) {
      const before = blitzReplayPathState;
      applyBlitzReplayEvent(ev);
      const toggled = new Set<EdgeKey>();
      for (const op of ev.ops) for (const ek of op.edges) toggled.add(ek);
      scheduleToggleAnimation(reviewComponentColors, before.edges, blitzReplayPathState.edges, toggled, false);
    } else {
      applyBlitzReplayEvent(ev);
    }
    if (ev.kind === 'puzzleStart') showToast(`+${(ev.timeAwardedMs / 1000).toFixed(1)}s for this puzzle`);
    if (ev.kind === 'puzzleSolved') {
      showToast('Solved!');
      // The per-move `scheduleToggleAnimation` call above always passes
      // `justWon: false` (a Blitz run's real win detection is this separate
      // `puzzleSolved` event, not derived from the move's own `PathState`
      // transition — see `BlitzEvent`'s doc comment), so the win sound
      // needs its own trigger here to match what a live Blitz run's
      // `setBlitzPathState` already plays on every solve.
      playSfx('win');
    }
    blitzReplayEventCursor++;
  }
  blitzReplayT = target;
  updateBlitzReplayUI();
  render();
}

function blitzReplayTick(): void {
  if (!blitzReplayPlaying || !blitzReplayRecord) return;
  const now = performance.now();
  const dt = (now - blitzReplayLastPerf) * blitzReplaySpeed;
  blitzReplayLastPerf = now;
  const duration = blitzReplayDurationMs();
  advanceBlitzReplayTo(Math.min(blitzReplayT + dt, duration), true);
  if (blitzReplayT >= duration) {
    pauseBlitzReplay();
    return;
  }
  blitzReplayRafId = requestAnimationFrame(blitzReplayTick);
}

function playBlitzReplay(): void {
  if (!blitzReplayRecord) return;
  if (blitzReplayT >= blitzReplayDurationMs()) seekBlitzReplay(0);
  blitzReplayPlaying = true;
  blitzReplayPlayPauseBtn.textContent = 'Pause';
  blitzReplayLastPerf = performance.now();
  if (blitzReplayRafId === null) blitzReplayRafId = requestAnimationFrame(blitzReplayTick);
}

function pauseBlitzReplay(): void {
  blitzReplayPlaying = false;
  blitzReplayPlayPauseBtn.textContent = 'Play';
  if (blitzReplayRafId !== null) {
    cancelAnimationFrame(blitzReplayRafId);
    blitzReplayRafId = null;
  }
}

/** Opens a stored run in the real-time replay viewer. `returnScreen` is where "‹ Close" goes back to — the Leaderboard's runs list, or straight back to the game-over screen right after finishing a run. */
function openBlitzReplay(record: BlitzRunRecord, returnScreen: Screen): void {
  stopLiveAnimationLoop();
  stopBlitzTimer();
  clearEdgeAnimations();
  resetWinLoopState();
  resetComponentColorState(reviewComponentColors);

  blitzReplayRecord = record;
  blitzReplayReturnScreen = returnScreen;
  mode = 'blitzReplay';
  focusedRegionId = null;
  keyboardCursor = null;
  blitzReplaySpeedSelect.value = String(blitzReplaySpeed);

  resetWinBanner();
  headerInfoEl.classList.add('hidden');
  blitzHeaderInfoEl.classList.remove('hidden');
  exitBtn.classList.add('hidden');
  blitzExitBtn.classList.add('hidden');
  playControlsEl.classList.add('hidden');
  reviewBarEl.classList.add('hidden');
  blitzReplayBarEl.classList.remove('hidden');

  // `showScreen('game')` must come before `seekBlitzReplay(0)`: that call
  // synchronously applies t=0's `puzzleStart` event, which now itself calls
  // `layout()` (see `applyBlitzReplayEvent`) — and `layout()`'s `fitView()`
  // needs `wrapEl`'s real (non-`.hidden`) size to compute a sane view, same
  // reasoning as `startBlitzRun`'s doc comment. The extra `layout()` below
  // is a harmless belt-and-suspenders call for the edge case of a record
  // with no events at all, where `seekBlitzReplay` has nothing to apply.
  showScreen('game');
  seekBlitzReplay(0);
  layout();
  playBlitzReplay();
}

/** Leaves the replay viewer without touching the stored record — back to wherever it was opened from. */
function closeBlitzReplay(): void {
  pauseBlitzReplay();
  clearEdgeAnimations();
  resetWinLoopState();
  blitzReplayRecord = null;
  mode = 'playing';
  showScreen(blitzReplayReturnScreen);
}

// ---- Screen navigation ----

/**
 * Every screen with a fixed layout (as opposed to a variable-length list)
 * shows the animated postgame-loop background behind it — see `index.html`'s
 * `#menuCanvas` doc comment. The Resume/Replays lists and the game screen
 * itself keep an opaque background instead. Blitz mirrors Free Play exactly:
 * its two fixed-layout screens (`blitzMenu`, `blitzSetup`, plus the
 * game-over screen) opt in, its variable-length leaderboard lists
 * (`blitzLeaderboard`, `blitzLeaderboardRuns`) don't — same reasoning as
 * Resume/Replays. Settings is fixed-layout too (a single slider + a preview
 * button, same shape as New Game's form), so it opts in as well.
 */
const BACKGROUND_SCREENS: readonly Screen[] = ['mainMenu', 'freePlay', 'newGame', 'blitzMenu', 'blitzSetup', 'blitzGameOver', 'settings'];

/**
 * Hides every screen but `next` and runs each screen's enter/leave side
 * effects: the shared animated background starts the instant navigation
 * enters `BACKGROUND_SCREENS` and stops the instant it leaves that set
 * (and stays running, uninterrupted, while moving *within* it — e.g. Free
 * Play to New Game — so its own `requestAnimationFrame` chain doesn't
 * restart on every menu tap, and doesn't run forever behind a screen that
 * doesn't show it); the live game's animation loop is likewise
 * force-stopped whenever leaving `'game'` (see `stopLiveAnimationLoop`'s
 * doc comment for why that can't just be left to lapse on its own);
 * Resume/Replays refresh their lists from IndexedDB every time they're
 * shown, so a delete or a just-finished game is always reflected.
 *
 * Whether the background is currently running is read off
 * `stopMenuBackground` itself (non-null while it's active) rather than off
 * the previous `screen` value — `screen`'s initial value is `'mainMenu'`
 * before the very first `showScreen('mainMenu')` call ever runs, which
 * would otherwise look like "already there, nothing to start".
 */
function showScreen(next: Screen): void {
  const nextIsBackgroundScreen = BACKGROUND_SCREENS.includes(next);
  if (!nextIsBackgroundScreen && stopMenuBackground) {
    stopMenuBackground();
    stopMenuBackground = null;
  }
  if (screen === 'game' && next !== 'game') {
    stopLiveAnimationLoop();
    // Defensive: `forfeitBlitzRun`/`endBlitzRun`/`closeBlitzReplay` already
    // stop these on every path that actually leaves `'game'` deliberately,
    // but stopping here too means a stray navigation can never leave one of
    // these `requestAnimationFrame`/timeout chains running behind a screen
    // that no longer shows it (the same reasoning `stopLiveAnimationLoop`
    // itself documents).
    stopBlitzTimer();
    pauseBlitzReplay();
  }

  screen = next;
  mainMenuScreenEl.classList.toggle('hidden', next !== 'mainMenu');
  freePlayMenuScreenEl.classList.toggle('hidden', next !== 'freePlay');
  newGameMenuScreenEl.classList.toggle('hidden', next !== 'newGame');
  resumeMenuScreenEl.classList.toggle('hidden', next !== 'resume');
  replaysMenuScreenEl.classList.toggle('hidden', next !== 'replays');
  blitzMenuScreenEl.classList.toggle('hidden', next !== 'blitzMenu');
  blitzSetupScreenEl.classList.toggle('hidden', next !== 'blitzSetup');
  blitzLeaderboardScreenEl.classList.toggle('hidden', next !== 'blitzLeaderboard');
  blitzLeaderboardRunsScreenEl.classList.toggle('hidden', next !== 'blitzLeaderboardRuns');
  blitzGameOverScreenEl.classList.toggle('hidden', next !== 'blitzGameOver');
  settingsScreenEl.classList.toggle('hidden', next !== 'settings');
  gameScreenEl.classList.toggle('hidden', next !== 'game');

  if (nextIsBackgroundScreen && !stopMenuBackground) stopMenuBackground = startMenuBackground(menuCanvas);
  if (next === 'resume') void refreshResumeList();
  if (next === 'replays') void refreshReplaysList();
  if (next === 'blitzLeaderboard') void refreshBlitzLeaderboardList();
  if (next === 'blitzLeaderboardRuns') void refreshBlitzLeaderboardRunsList();
}

/** Leaves the live game back to the Free Play hub — the "Exit" button. Whatever's in progress is already autosaved on every edit (`persistLiveState`), so there's nothing extra to do here. */
function exitGame(): void {
  showScreen('freePlay');
}

/**
 * Wraps a click handler that navigates somewhere (a plain screen swap,
 * starting a fresh puzzle/run, entering or leaving review/replay) with the
 * shared menu-nav sound (`SfxRole` `'menuNav'` — see `audio/sfx.ts`).
 * Deliberately *not* applied to every button: Undo/Redo/Give Up, a list
 * row's Delete, and playback play/pause/scrub controls all act in place
 * without navigating anywhere, so they stay silent for now (easy to opt in
 * later, per-button, without touching this helper).
 */
function navClick(action: () => void): () => void {
  return () => {
    playSfx('menuNav');
    action();
  };
}

freePlayEntryBtn.addEventListener('click', navClick(() => showScreen('freePlay')));
blitzEntryBtn.addEventListener('click', navClick(() => showScreen('blitzMenu')));
settingsEntryBtn.addEventListener('click', navClick(() => showScreen('settings')));
settingsBackBtn.addEventListener('click', navClick(() => showScreen('mainMenu')));
freePlayBackBtn.addEventListener('click', navClick(() => showScreen('mainMenu')));
newGameEntryBtn.addEventListener('click', navClick(() => showScreen('newGame')));
resumeEntryBtn.addEventListener('click', navClick(() => showScreen('resume')));
replaysEntryBtn.addEventListener('click', navClick(() => showScreen('replays')));
newGameBackBtn.addEventListener('click', navClick(() => showScreen('freePlay')));
resumeBackBtn.addEventListener('click', navClick(() => showScreen('freePlay')));
replaysBackBtn.addEventListener('click', navClick(() => showScreen('freePlay')));
newGameStartBtn.addEventListener(
  'click',
  navClick(() => {
    startNewGame(newGameSizeSelect.value, newGameShapeSelect.value as ShapeMode);
  }),
);

blitzMenuBackBtn.addEventListener('click', navClick(() => showScreen('mainMenu')));
blitzPlayEntryBtn.addEventListener('click', navClick(() => showScreen('blitzSetup')));
blitzLeaderboardEntryBtn.addEventListener('click', navClick(() => showScreen('blitzLeaderboard')));
blitzSetupBackBtn.addEventListener('click', navClick(() => showScreen('blitzMenu')));
blitzLeaderboardBackBtn.addEventListener('click', navClick(() => showScreen('blitzMenu')));
blitzLeaderboardRunsBackBtn.addEventListener('click', navClick(() => showScreen('blitzLeaderboard')));
blitzStartBtn.addEventListener(
  'click',
  navClick(() => {
    const pace = (blitzPaceSelect.value as BlitzPace) in BLITZ_PACE_PARAMS ? (blitzPaceSelect.value as BlitzPace) : DEFAULT_BLITZ_PACE;
    startBlitzRun(BLITZ_PACE_PARAMS[pace]);
  }),
);
blitzExitBtn.addEventListener('click', navClick(forfeitBlitzRun));
blitzPlayAgainBtn.addEventListener('click', navClick(() => startBlitzRun(blitzParams)));
blitzGameOverReplayBtn.addEventListener(
  'click',
  navClick(() => {
    if (blitzLastRecord) openBlitzReplay(blitzLastRecord, 'blitzGameOver');
  }),
);
blitzGameOverMenuBtn.addEventListener('click', navClick(() => showScreen('blitzMenu')));
blitzReplayCloseBtn.addEventListener('click', navClick(closeBlitzReplay));
blitzReplayPlayPauseBtn.addEventListener('click', () => {
  if (blitzReplayPlaying) pauseBlitzReplay();
  else playBlitzReplay();
});
blitzReplayScrubberEl.addEventListener('input', () => {
  pauseBlitzReplay();
  seekBlitzReplay(Number(blitzReplayScrubberEl.value));
});
blitzReplaySpeedSelect.addEventListener('change', () => {
  blitzReplaySpeed = Number(blitzReplaySpeedSelect.value) || 1;
});

exitBtn.addEventListener('click', navClick(exitGame));
undoBtn.addEventListener('click', performUndo);
redoBtn.addEventListener('click', performRedo);
giveUpBtn.addEventListener('click', revealSolution);
rematchBtn.addEventListener('click', navClick(rematch));
viewReplayBtn.addEventListener(
  'click',
  navClick(() => {
    void viewReplayFromGame();
  }),
);
replayBtn.addEventListener('click', navClick(startReplay));
replayCloseBtn.addEventListener('click', navClick(closeReplay));
byId('exitReviewBtn').addEventListener('click', navClick(exitReview));
replayPlayPauseBtn.addEventListener('click', () => {
  if (replayTimerId !== null) stopReplayTimer();
  else playReplay();
});
replayScrubberEl.addEventListener('input', () => {
  stopReplayTimer();
  showReplayFrame(Number(replayScrubberEl.value));
});
replaySpeedSelect.addEventListener('change', () => {
  replaySpeed = Number(replaySpeedSelect.value) || 1;
  localStorage.setItem(LAST_REPLAY_SPEED_KEY, String(replaySpeed));
  // Restart the running interval so a mid-playback speed change takes effect immediately, rather than waiting for the next tick.
  if (replayTimerId !== null) playReplay();
});

/** Tag names for controls where ctrl+z/y should keep its native text-editing meaning instead of undo/redo-ing the puzzle. Deliberately narrower than `keyboard.ts`'s equivalent list (which also excludes SELECT/BUTTON, since arrow keys and Enter/Space *do* conflict with those) — ctrl+z has no native behavior on a focused button or select, and excluding BUTTON here would mean clicking Undo/Redo (which keeps focus on the button afterward) silently breaks the ctrl+z shortcut until focus moves elsewhere. */
const TEXT_EDITING_TAGS = new Set(['INPUT', 'TEXTAREA']);

window.addEventListener('keydown', (evt) => {
  if (!(evt.ctrlKey || evt.metaKey)) return;
  if (screen !== 'game' || mode !== 'playing') return;
  const targetTag = (evt.target as HTMLElement | null)?.tagName;
  if (targetTag && TEXT_EDITING_TAGS.has(targetTag)) return;

  const k = evt.key.toLowerCase();
  if (k === 'z') {
    evt.preventDefault();
    if (evt.shiftKey) performRedo();
    else performUndo();
  } else if (k === 'y') {
    evt.preventDefault();
    performRedo();
  }
});

byId('zoomFitBtn').addEventListener('click', fitView);
byId('zoomInBtn').addEventListener('click', () => {
  setView(computeZoomAt(view, wrapEl.clientWidth / 2, wrapEl.clientHeight / 2, view.scale * 1.4, VIEW_BOUNDS));
});
byId('zoomOutBtn').addEventListener('click', () => {
  setView(computeZoomAt(view, wrapEl.clientWidth / 2, wrapEl.clientHeight / 2, view.scale / 1.4, VIEW_BOUNDS));
});
window.addEventListener('resize', () => {
  // Whichever mode is live has already assigned its own puzzle variable by
  // the time `screen === 'game'` is reachable at all (`beginPuzzle`,
  // `startBlitzRun`, `enterReview`, `openBlitzReplay`), so `activePuzzle()`
  // is always safe to call here regardless of which one it is.
  if (screen === 'game') layout();
});

wrapEl.addEventListener(
  'wheel',
  (evt) => {
    evt.preventDefault();
    const rect = wrapEl.getBoundingClientRect();
    const wx = evt.clientX - rect.left;
    const wy = evt.clientY - rect.top;
    const factor = Math.pow(1.0015, -evt.deltaY);
    setView(computeZoomAt(view, wx, wy, view.scale * factor, VIEW_BOUNDS));
  },
  { passive: false },
);

const lastSize = localStorage.getItem(LAST_SIZE_STORAGE_KEY);
if (lastSize && SIZE_OPTIONS.some((opt) => opt.key === lastSize)) {
  newGameSizeSelect.value = lastSize;
}
const lastShape = localStorage.getItem(LAST_SHAPE_STORAGE_KEY);
if (lastShape && SELECTABLE_SHAPE_MODE_OPTIONS.some((opt) => opt.key === lastShape)) {
  newGameShapeSelect.value = lastShape;
}
const lastReplaySpeed = Number(localStorage.getItem(LAST_REPLAY_SPEED_KEY));
if (REPLAY_SPEED_OPTIONS.includes(lastReplaySpeed)) {
  replaySpeed = lastReplaySpeed;
  replaySpeedSelect.value = String(lastReplaySpeed);
}

// ---- Settings ----
// Currently just sfx volume (`settings.ts`), applied live to `audio/sfx.ts`'s
// shared gain node the instant the slider moves, and persisted only once the
// player lets go (`change`, not `input`) — dragging shouldn't hammer
// `localStorage` on every intermediate frame.
function updateSfxVolumeReadout(volume: number): void {
  sfxVolumeReadout.textContent = `${Math.round(volume * 100)}%`;
}
const initialSfxVolume = loadSfxVolume();
setSfxVolume(initialSfxVolume);
sfxVolumeSlider.value = String(Math.round(initialSfxVolume * 100));
updateSfxVolumeReadout(initialSfxVolume);
sfxVolumeSlider.addEventListener('input', () => {
  const volume = Number(sfxVolumeSlider.value) / 100;
  setSfxVolume(volume);
  updateSfxVolumeReadout(volume);
});
sfxVolumeSlider.addEventListener('change', () => {
  saveSfxVolume(Number(sfxVolumeSlider.value) / 100);
});
sfxVolumePreviewBtn.addEventListener('click', () => playSfx('menuNav'));

showScreen('mainMenu');
