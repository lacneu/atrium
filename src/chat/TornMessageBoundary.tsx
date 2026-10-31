// CONFINES A TORN THREAD-STORE READ TO THE BUBBLE THAT MADE IT.
//
// assistant-ui resolves a message (and a message's parts) BY INDEX through its store.
// ConvexChat is reused across conversations, and one runtime serves them all: when the
// thread is swapped under a mounted bubble — switching conversation while a turn streams,
// a stream settling while the tab is in the background — the store can shrink before
// React unmounts the bubbles past its new end. A bubble that renders in that window reads
// an index that no longer exists and assistant-ui throws ("useClientLookup: Index 11 out
// of bounds (length: 1)"). Uncaught, that reached the ROUTE boundary: the whole page was
// replaced by "Une erreur est survenue" and only a retry/reload brought the conversation
// back (0.103.1).
//
// The bubble is on its way out, so rendering nothing for it is correct. If it is NOT on
// its way out (the store tore for a frame and came back), it must reappear on its own:
// the boundary retries on the next task, and gives up after a few consecutive tears so a
// read that keeps failing still reaches the route boundary instead of hiding a bubble
// forever. Any other error is rethrown untouched.

import { Component, type ReactNode } from "react";

/** The two lookup failures assistant-ui throws for a message/part read through a store
 *  that no longer holds it (@assistant-ui/store useClientLookup). Pure. */
export function isTornLookupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return /^useClientLookup: (Index -?\d+ out of bounds|Key ".*" not found)/.test(message);
}

/** Consecutive tears a bubble may absorb before the error is let through: a read that
 *  still fails after this many retries is not a transient swap. */
export const TORN_RETRY_LIMIT = 3;

export type TornState = { error: unknown; tears: number };

/** What the boundary does with a caught error: hide the bubble and retry (`retry`), or
 *  let the error through to the next boundary (`rethrow`). Pure. */
export function tornDecision(error: unknown, tears: number): "retry" | "rethrow" {
  return isTornLookupError(error) && tears <= TORN_RETRY_LIMIT ? "retry" : "rethrow";
}

export class TornMessageBoundary extends Component<{ children: ReactNode }, TornState> {
  state: TornState = { error: null, tears: 0 };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private calmTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: unknown): Partial<TornState> {
    return { error };
  }

  componentDidCatch(error: unknown) {
    // A tear is not calm: the count that was about to be forgotten stands.
    if (this.calmTimer !== null) clearTimeout(this.calmTimer);
    this.calmTimer = null;
    const tears = this.state.tears + 1;
    // Counted either way: past the budget, the next render rethrows it.
    this.setState({ tears });
    if (tornDecision(error, tears) === "rethrow") return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState({ error: null });
    }, 0);
  }

  componentDidUpdate(_prev: unknown, prevState: TornState) {
    // A render that went through after a tear: the count starts over once it holds.
    if (prevState.error !== null && this.state.error === null && this.state.tears > 0) {
      if (this.calmTimer !== null) clearTimeout(this.calmTimer);
      this.calmTimer = setTimeout(() => {
        this.calmTimer = null;
        if (this.state.error === null) this.setState({ tears: 0 });
      }, 1_000);
    }
  }

  componentWillUnmount() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.calmTimer !== null) clearTimeout(this.calmTimer);
  }

  render() {
    const { error, tears } = this.state;
    if (error === null) return this.props.children;
    if (tornDecision(error, tears) === "rethrow") throw error;
    return null;
  }
}
