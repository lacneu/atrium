import { describe, expect, it } from "vitest";
import { errorDetailView, STATUS_NOT_FAILURE_CODES } from "./runStatusView";
import { m } from "@/paraglide/messages.js";

// Phase 6: state contention on a projected conversation is a STATUS to check (warning card,
// its own title), never the red failure card; off/shadow's `gateway_storage_busy` keeps
// 0.97.0's error card and copy.
const SUMMARY =
  "The turn was interrupted while the server was busy. Check its status before trying again.";

describe("gateway_state_contention", () => {
  it("is labelled by its code and rendered as a status, with its own title", () => {
    const view = errorDetailView(SUMMARY, "gateway_state_contention");
    expect(view.code).toBe("gateway_state_contention");
    expect(view.headline).toBe(m.runstatus_error_gateway_state_contention());
    expect(STATUS_NOT_FAILURE_CODES.get("gateway_state_contention")?.()).toBe(
      m.runstatus_status_gateway_state_contention(),
    );
  });

  it("off/shadow's storage-busy class stays a failure card (0.97.0)", () => {
    expect(STATUS_NOT_FAILURE_CODES.has("gateway_storage_busy")).toBe(false);
    expect(errorDetailView("database is locked", "gateway_storage_busy").headline).toBe(
      m.runstatus_error_gateway_storage_busy(),
    );
  });
});
