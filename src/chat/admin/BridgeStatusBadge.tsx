import { useQuery } from "convex/react";
import { api } from "../convexApi";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages.js";
import { formatTime } from "@/lib/format";

// Live health dot on the "Bridge" settings tab: green when up, red when down,
// grey before the first poll. Hover shows a one-line summary; the full detail
// lives in the tab itself (BridgeTab). Reads the light, non-admin availability
// projection (getBridgeAvailability) so it never throws on the tab strip.

export function BridgeStatusBadge() {
  const a = useQuery(api.bridgeHealth.getBridgeAvailability, {});
  if (a === undefined) return null; // loading — no dot yet

  // Amber when the bridge is up but configured gateways are transport-down
  // (backup/maintenance) — a green "operational" dot would contradict the
  // gateway-unreachable banners on every affected chat.
  const gatewaysDown = a.gatewaysUnreachable ?? 0;
  const tone = !a.known
    ? "idle"
    : !a.available
      ? "error"
      : gatewaysDown > 0
        ? "warn"
        : "ok";
  const summary = !a.known
    ? m.bridgebadge_no_reading_yet()
    : !a.available
      ? m.bridgebadge_unavailable({ reason: a.reason ?? "?" })
      : gatewaysDown > 0
        ? m.bridge_gateways_unreachable({ count: gatewaysDown })
        : `${m.bridgebadge_operational()}${
            a.checkedAt
              ? m.bridgebadge_verified_at({
                  time: formatTime(a.checkedAt),
                })
              : ""
          }`;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`oc-bridge-dot oc-bridge-dot--${tone}`}
            role="img"
            aria-label={summary}
          />
        </TooltipTrigger>
        <TooltipContent>{summary}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
