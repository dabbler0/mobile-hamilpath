/**
 * A small styleable confirm dialog (GitHub issue #51), replacing the
 * native `window.confirm()` every "delete this / forfeit this / give up"
 * prompt in `main.ts` used to call — the browser's own confirm box can't be
 * styled at all, so it looked nothing like the rest of this game's UI.
 *
 * `#dialogOverlay` (`index.html`) is a sibling of every `.screen`, not
 * nested inside any one of them, so `confirmDialog` works identically no
 * matter which screen it's opened from: a menu list's delete button
 * (Resume/Replays/Blitz leaderboard) or a live in-game button (Give Up,
 * Blitz Forfeit). It's always present in the DOM — shown/hidden purely via
 * the `.show` class toggling `opacity`/`pointer-events` in CSS, exactly
 * like `main.ts`'s own `#toast` — rather than `display: none` juggling,
 * which is what lets a plain CSS transition animate it in/out for free.
 *
 * Keyboard interaction needs no special-casing here: `keyboard.ts`'s own
 * board-cursor handling already ignores any keydown whose target is a
 * `BUTTON` (`NATIVE_CONTROL_TAGS`), and this module always focuses one of
 * its own buttons the instant it opens — so arrow keys/Enter/Space can
 * never leak through to move the board cursor or toggle a region while a
 * dialog is up, without `dialog.ts` needing to know `keyboard.ts` exists at
 * all. Pointer interaction is similarly automatic: `#dialogOverlay` is a
 * `position: fixed` layer covering the whole viewport above every screen
 * (highest `z-index` in the stylesheet), so a tap anywhere on screen while
 * it's shown always lands on the overlay or its card, never on the board
 * underneath.
 */

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const overlayEl = byId<HTMLDivElement>('dialogOverlay');
const messageEl = byId<HTMLDivElement>('dialogMessage');
const cancelBtn = byId<HTMLButtonElement>('dialogCancelBtn');
const confirmBtn = byId<HTMLButtonElement>('dialogConfirmBtn');

export interface ConfirmOptions {
  message: string;
  /** Defaults to `'Confirm'`. */
  confirmLabel?: string;
  /** Defaults to `'Cancel'`. */
  cancelLabel?: string;
  /**
   * Styles the confirm button as destructive (the same red accent
   * `style.css`'s `.listItemDelete` uses) instead of the ordinary primary
   * blue. Every current call site is a delete/forfeit/give-up prompt, i.e.
   * always `true` in practice — the option exists so a future
   * non-destructive confirm doesn't have to fight that default.
   */
  danger?: boolean;
}

/**
 * The in-flight dialog's resolver, or `null` when none is open. Opening a
 * second dialog while one is still awaiting a response resolves the first
 * as `false` (cancelled) rather than leaving its promise dangling forever
 * — nothing in this codebase actually does that today (every call site
 * `await`s before doing anything else that could open another one), but it
 * keeps this a well-behaved general-purpose primitive rather than one that
 * silently assumes its own callers' discipline.
 */
let activeResolve: ((confirmed: boolean) => void) | null = null;

function settle(confirmed: boolean): void {
  if (!activeResolve) return;
  overlayEl.classList.remove('show');
  const resolve = activeResolve;
  activeResolve = null;
  resolve(confirmed);
}

overlayEl.addEventListener('pointerdown', (evt) => {
  // Only a direct tap on the backdrop itself — not one that merely
  // bubbled up from the card — counts as "cancel by tapping outside".
  if (evt.target === overlayEl) settle(false);
});
cancelBtn.addEventListener('click', () => settle(false));
confirmBtn.addEventListener('click', () => settle(true));
window.addEventListener('keydown', (evt) => {
  if (activeResolve && evt.key === 'Escape') {
    evt.preventDefault();
    settle(false);
  }
});

/**
 * Shows the shared confirm dialog and resolves once the player picks an
 * option: `true` for Confirm, `false` for Cancel, a direct tap on the
 * backdrop, or Escape. Drop-in replacement for `window.confirm()` — every
 * call site just adds an `await`.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // Opening a fresh dialog on top of one still awaiting a response
  // cancels that one first — see `activeResolve`'s own doc comment.
  settle(false);
  messageEl.textContent = options.message;
  confirmBtn.textContent = options.confirmLabel ?? 'Confirm';
  cancelBtn.textContent = options.cancelLabel ?? 'Cancel';
  confirmBtn.classList.toggle('dialogBtnDanger', options.danger ?? false);
  overlayEl.classList.add('show');
  cancelBtn.focus();
  return new Promise<boolean>((resolve) => {
    activeResolve = resolve;
  });
}
