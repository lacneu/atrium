// The gateway's STATUS NOTICES for a reply — a usage line, a diagnostic — as notice lines
// under the reply body.
//
// The gateway sends them beside the answer and says of them that they "do not define the
// terminal reply they accompany": they are its own words, not the agent's. So they are
// shown as plain text, apart from the answer (no markdown, never copied with it), and
// labelled for what they are.

import { useMessage } from "@assistant-ui/react";
import { m } from "@/paraglide/messages.js";

export function GatewayNotices() {
  const notices = useMessage(
    (msg) => (msg.metadata?.custom as { gatewayNotices?: string[] } | undefined)?.gatewayNotices,
  );
  if (!Array.isArray(notices) || notices.length === 0) return null;
  return (
    <div className="oc-gateway-notices" role="note" aria-label={m.gateway_notice_label()}>
      {notices.map((text, index) => (
        <p key={index} className="oc-gateway-notices__line">
          {text}
        </p>
      ))}
    </div>
  );
}
