// A tiny module counter for "an attachment is being ADDED right now". EVERY
// attachment path — the native ComposerPrimitive.AddAttachment button, a paste
// carrying files, the routed large-paste, the document viewer's "use in prompt"
// — funnels through the AttachmentAdapter's async add() (policy checks before the
// file lands in composer state). The detached-composer pin must be refused
// during that window: attachments.length is still 0 mid-add, so a pin would slip
// past the guard and then strand the file on the hidden runtime (codex
// re-review P1). Wrapping add() here catches all callers, not just the paste
// ones a component-level counter could see.

let inFlight = 0;

export function beginAttachmentAdd(): void {
  inFlight += 1;
}

export function endAttachmentAdd(): void {
  inFlight = Math.max(0, inFlight - 1);
}

/** True while at least one adapter.add() is running. */
export function attachmentAddInFlight(): boolean {
  return inFlight > 0;
}
