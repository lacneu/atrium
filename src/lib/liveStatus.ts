// A status said EACH time it is given (lot 23).
//
// A live region (role="status") is announced when its content CHANGES. The block lists
// say "this passage changed, nothing was done" when a pick is refused: a second refusal
// set the same words again — nothing changed, nothing was announced. A region that
// appears already filled is not reliably announced either: ARIA22 wants it on the
// page, empty, before its message. So the region is rendered empty from the start, and
// saying a status empties it, then fills it on a later task: the filling is a change of
// its own, heard every time.

/** Runs `task` after `ms`; the function returned cancels it. */
export type Schedule = (task: () => void, ms: number) => () => void;

/** How long the region stays empty before it is filled again: a separate task, long
 *  enough for assistive technologies that read the page in batches to see it empty. */
export const STATUS_REFILL_MS = 150;

export interface LiveStatus {
  /** Empties the region, then fills it with `text`: announced even when the same.
   *  With `holdMs`, the region empties again that long after it was filled (a status
   *  shown over the page, not in a dialog that closes with it: lot 24). */
  say(text: string, holdMs?: number): void;
  /** Empties the region, and drops a filling still to come. */
  clear(): void;
}

export function liveStatus(set: (text: string) => void, schedule: Schedule): LiveStatus {
  let cancel: (() => void) | null = null;
  const stop = () => {
    cancel?.();
    cancel = null;
  };
  return {
    say(text, holdMs) {
      stop();
      set("");
      cancel = schedule(() => {
        cancel = null;
        set(text);
        if (holdMs !== undefined) cancel = schedule(() => set(""), holdMs);
      }, STATUS_REFILL_MS);
    },
    clear() {
      stop();
      set("");
    },
  };
}

/** `Schedule` on the window's timers. */
export const windowSchedule: Schedule = (task, ms) => {
  const id = window.setTimeout(task, ms);
  return () => window.clearTimeout(id);
};
