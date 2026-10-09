// THE COMPOSER WHILE THE AGENT WORKS (transcript projection `on`, phase 3) — pure
// decisions, tested without a DOM.
//
// Mirrors the Control UI's primary action (ui/src/pages/chat/components/
// chat-composer-controls.ts:500-510 at v2026.9.8): with a run in progress the button
// says what Enter will do — "Steer" or "Queue" — and plain "Send" when the mode is the
// gateway's own and not known as one of those; the modifier+Enter shortcut does the
// alternate of the two (chat-composer.ts:207-217).

export type FollowUpPreference = "queue" | "steer";
export type FollowUpSendMode = "queue" | "steer" | "interrupt";
export type GatewayQueueMode = "steer" | "followup" | "collect" | "interrupt";

export type PrimaryFollowUp = {
  /** What the label says. */
  kind: "steer" | "queue" | "send";
  /** What the send carries (undefined = the gateway's own mode). */
  mode: FollowUpSendMode | undefined;
};

/** The primary action: the person's preference, else the gateway's mode as a label. */
export function primaryFollowUp(
  preference: FollowUpPreference | null,
  serverMode: GatewayQueueMode | null,
): PrimaryFollowUp {
  if (preference !== null) return { kind: preference, mode: preference };
  return { kind: serverMode === "steer" ? "steer" : "send", mode: undefined };
}

/** The modifier+Enter alternate: the other of queue/steer. */
export function alternateFollowUp(primary: PrimaryFollowUp): FollowUpSendMode {
  return primary.kind === "queue" ? "steer" : "queue";
}

/** Which badge a user bubble shows for the gateway's custody of its input (null = none:
 *  `accepted` and `persisted` are the ordinary life of a message, not news). */
export function custodyBadge(
  custody: string | null | undefined,
): "queued" | "steered" | "cancelled" | "interrupted" | null {
  switch (custody) {
    case "queued":
    case "steered":
    case "cancelled":
    case "interrupted":
      return custody;
    default:
      return null;
  }
}

/**
 * PROJECTION `on` (phase 4): does the composer say the agent works? A sent turn's bubble is
 * born at its run's first content; until then the gateway's fact does, until its deadline
 * (`followUpState.workingUntil`). Only while the conversation still ends on the reader's
 * message: once an answer is there, the short lag before the next read must not show a
 * second "thinking" under it.
 */
export function isProjectedWorking(
  workingUntil: number | null,
  lastRole: string | null,
  now: number,
): boolean {
  return workingUntil !== null && workingUntil > now && lastRole === "user";
}
