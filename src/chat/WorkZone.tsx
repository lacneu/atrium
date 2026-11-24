import { useSyncExternalStore, type ReactNode } from "react";
import { useMessage } from "@assistant-ui/react";
import { Brain } from "lucide-react";
import { m } from "@/paraglide/messages.js";
import { ActivityRow } from "./ActivityRow";
import { useUiPrefs } from "./ConvexChat";
import { thinkingTitle } from "./reasoningView";
import {
  chooseZone,
  subscribeZones,
  zoneChoice,
  zoneExpanded,
  zoneHeadedBy,
  zoneSteps,
  type WorkZoneMark,
} from "./workZoneView";

// THE HEADER OF A WORK ZONE (workZoneView.ts): the one label of the turn's work — a brain
// and the reasoning title at the top of the rail, once per zone, never per thought — so a reader
// tells the reasoning from the result at once. It folds the whole zone; folded, it says
// how many steps it stands for.

function useZoneOpen(key: string | undefined): boolean {
  const chosen = useSyncExternalStore(subscribeZones, () => (key === undefined ? undefined : zoneChoice(key)));
  return zoneExpanded(chosen);
}

function WorkZoneHeader({ zone, open }: { zone: WorkZoneMark; open: boolean }) {
  const { showTools } = useUiPrefs();
  const facts = useMessage((msg) => {
    const custom = msg.metadata?.custom as
      | { generationMs?: number | null; allToolParts?: unknown[]; status?: string }
      | undefined;
    return `${custom?.status ?? ""}|${custom?.generationMs ?? ""}|${(custom?.allToolParts ?? []).length}`;
  });
  const [status, generationMs, toolCount] = facts.split("|");
  const title = thinkingTitle({
    writing: zone.live && status === "streaming",
    generationMs: generationMs === "" ? null : Number(generationMs),
    hasToolActivity: Number(toolCount) > 0,
  });
  const steps = zoneSteps(zone, showTools);
  return (
    <div className="oc-msg__meta oc-work oc-workhead" data-open={open ? "true" : "false"}>
      <ActivityRow
        icon={<Brain size={14} />}
        label={title}
        trailing={
          open ? undefined : (
            <span className="oc-workhead__steps">
              {steps === 1 ? m.reasoning_zone_steps_one() : m.reasoning_zone_steps_many({ count: String(steps) })}
            </span>
          )
        }
        open={open}
        ariaExpanded={open}
        title={open ? m.reasoning_collapse() : m.reasoning_expand()}
        onClick={() => chooseZone(zone.key, !open)}
      />
    </div>
  );
}

/** What a part of the turn's work owes its zone: the header when it is the zone's first
 *  visible part, and whether the reader folded the zone (the part then shows nothing). */
export function useWorkZone(zone: WorkZoneMark | undefined): { header: ReactNode; folded: boolean } {
  const { showTools } = useUiPrefs();
  const open = useZoneOpen(zone?.key);
  return {
    header: zone !== undefined && zoneHeadedBy(zone, showTools) ? <WorkZoneHeader zone={zone} open={open} /> : null,
    folded: zone !== undefined && !open,
  };
}
