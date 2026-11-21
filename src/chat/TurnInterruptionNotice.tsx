// A turn the gateway cut, said under the bubble's work as a notice line (the same flat
// line as the gateway's own notices): what happened, and that the agent resumed the turn
// by itself when it did (turnInterruptionView.ts holds the rule).

import { useMessage } from "@assistant-ui/react";
import { m } from "@/paraglide/messages.js";
import { turnInterruptionText, type TurnInterruption } from "./turnInterruptionView";

type Meta = { interruption?: TurnInterruption; status?: string };

export function TurnInterruptionNotice() {
  const text = useMessage((msg) => {
    const meta = msg.metadata?.custom as Meta | undefined;
    return turnInterruptionText(meta?.interruption, meta?.status);
  });
  if (text === null) return null;
  return (
    <div className="oc-gateway-notices" role="note" aria-label={m.turn_interrupted_label()}>
      <p className="oc-gateway-notices__line">{text}</p>
    </div>
  );
}
