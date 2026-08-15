import { describe, expect, test } from "vitest";
import type { Id } from "./convexApi";
import { notifText } from "./NotificationBell";

function announcement(
  messageKey: string,
  params: Record<string, string>,
): Parameters<typeof notifText>[0] {
  return {
    _id: "notification-id" as Id<"notifications">,
    kind: "operator_announcement",
    title: "fallback title",
    body: "fallback body",
    messageKey,
    params,
    href: null,
    createdAt: 0,
    creationTime: 0,
    unread: true,
  };
}

describe("operator announcement localization", () => {
  test("renders a closed message key in the reader's locale", () => {
    const rendered = notifText(
      announcement("notif_operator_incident_update", {
        service: "platform",
        status: "monitoring",
        reference: "INC-123",
      }),
    );

    // The test environment uses the French base locale. English parity is a
    // hard gate in npm test, so both reader locales share this renderer.
    expect(rendered).toEqual({
      title: "Mise à jour d'incident de service",
      body: "la plateforme : sous surveillance (INC-123).",
    });
    expect(rendered.title).not.toContain("fallback");
    expect(rendered.body).not.toContain("fallback");
  });

  test("does not render an unrecognized service or status value", () => {
    expect(
      notifText(
        announcement("notif_operator_incident_update", {
          service: "network text",
          status: "network text",
          reference: "INC-123",
        }),
      ).body,
    ).toBe("? : ? (INC-123).");
  });
});
