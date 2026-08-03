// CONFINES A FAILING SIDE PANEL TO ITS OWN BODY.
//
// The four side-panel contents (sources, sub-agent, scheduled task, document)
// render from data that can go stale under them: the conversation deleted, a
// document whose file is gone, a sub-agent that no longer exists. Uncaught,
// their exception reaches the ROUTE boundary and the whole page goes — sidebar
// included.
//
// A PINNED panel makes that worse in both of its homes. In the floating dock it
// is mounted in the persistent chrome, so it follows the reader everywhere and
// one throwing panel would make every page unusable. Back in the origin
// conversation the dock stands down and the same content is rehydrated into the
// in-chat column — same stale data, same throw, and no boundary there either.
// So both homes wrap their body in this, and both keep their controls (unpin,
// go to source, close) OUTSIDE it: whatever the content does, the reader keeps
// the way out.

import { Component, type ReactNode } from "react";

import { m } from "@/paraglide/messages.js";

export class PanelBodyBoundary extends Component<
  {
    children: ReactNode;
    /** THE WAY OUT. The failing content takes its own close button down with it,
     *  so the panel would sit there, unclosable, until the reader navigated away
     *  — a broken panel holding a third of the screen. The boundary offers the
     *  close itself. */
    onClose?: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // Nothing actionable here: the content owns its own reporting, and this
    // boundary exists to keep the app navigable, not to diagnose.
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="oc-panel-failed">
        <p>{m.pinned_panel_failed()}</p>
        {this.props.onClose !== undefined ? (
          <button
            type="button"
            className="oc-panel-failed__close"
            onClick={this.props.onClose}
          >
            {m.panel_close()}
          </button>
        ) : null}
      </div>
    );
  }
}
