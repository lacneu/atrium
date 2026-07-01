import { createContext } from "react";

// True when the LAST user turn is parked in the mid-turn QUEUE (its outbox is
// `queued`), waiting BEHIND the in-flight turn. Lives in its own module (not
// ConvexChat) so RunStatus can consume it without a circular import back into
// ConvexChat. RunStatus reads it to label the synthetic upcoming-message placeholder
// that assistant-ui shows after a queued turn "En attente", not "processing".
export const QueuedTurnContext = createContext<boolean>(false);
