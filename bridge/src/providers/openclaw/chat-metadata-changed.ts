// `chat.metadata.changed` — the gateway's notice that the model facts a chat shows may
// have changed without any config file being written.
//
// Pure reader, the shape of `readConfigChanged` (config-changed.ts). Three upstream
// writers (src/gateway/server-chat-metadata-lifecycle.ts at v2026.9.36): the
// chat-metadata runtime after a prepared-catalogue, auth-profile or skills change
// (`{modelCatalogChanged, authChanged}`), a model-selection policy change
// (`{modelSelectionChanged: true}`), and EVERY session-cost publication
// (`{…usage, modelCatalogChanged: false, authChanged: false}`) — the frequent one,
// which is why the flags are read rather than the mere arrival. From v2026.8.1 through
// v2026.9.6 the payload is `{}`. Sent `dropIfSlow`: a lost one consumes a `seq`, which
// the frame-gap invalidation already covers.
//
// What Atrium keeps of it is the gateway's own Control UI rule for its model catalogue
// (ui/src/lib/model-catalog-cache.ts modelCatalogEventInvalidation): invalidate on
// `modelSelectionChanged === true`, do nothing on `modelCatalogChanged === false`,
// refresh otherwise — an empty payload included. `authChanged` on its own refreshes
// the Control UI's auth-status reads (model-auth-request-state.ts), a surface Atrium
// does not have; it does not touch the catalogue there, and does not here.

import { eventPayload } from "./connection-end.js";

export interface ChatMetadataChangedNotice {
  /** The model roster cached for this connection may no longer be the gateway's. */
  modelCatalogStale: boolean;
}

/** The notice carried by an inbound frame, or null for any other frame. */
export function readChatMetadataChanged(frame: unknown): ChatMetadataChangedNotice | null {
  const payload = eventPayload(frame, "chat.metadata.changed");
  if (payload === null) return null;
  return {
    modelCatalogStale:
      payload.modelSelectionChanged === true || payload.modelCatalogChanged !== false,
  };
}
