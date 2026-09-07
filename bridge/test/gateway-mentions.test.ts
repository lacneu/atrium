/**
 * Forwarding a mention to the gateway's own inbox.
 *
 * The person named has ALREADY been told inside Atrium by the time this runs, so
 * everything here is best-effort by construction: a gateway that cannot carry the
 * mention costs a convenience, while a span it refuses costs the whole turn
 * (upstream rejects the send with INVALID_MENTIONS). Every case below is one of
 * the two.
 */

import { describe, expect, it } from "vitest";

import { NO_ANSWER, deviceIdentity, startWsFakeGateway } from "./helpers/ws-fake-gateway.js";
import { OpenClawConnection } from "../src/providers/openclaw/openclaw-client.js";

/** A gateway that answers `users.mentionable` with the given roster. */
const gatewayWith = (
  users: Array<{ profileId: string; displayName: string }>,
  onMentionable?: (params: unknown) => void,
) =>
  startWsFakeGateway({
    version: "2026.9.2",
    onMethod: (method, params) => {
      if (method === "users.mentionable") {
        onMentionable?.(params);
        return { users: users.map((u) => ({ ...u, online: true })), truncated: false };
      }
      if (method === "chat.send") return { ok: true };
      return NO_ANSWER;
    },
  });

/** Reach the module-private resolver through the send path's own contract. */
async function resolve(
  conn: OpenClawConnection,
  body: {
    chatId: string;
    mentions?: Array<{ canonical: string; start: number; end: number }>;
  },
  prefixLength: number,
  authMode: "token" | "trusted-proxy",
) {
  const { __testing } = (await import("../src/server.js")) as unknown as {
    __testing: {
      resolveGatewayMentions: (
        c: unknown,
        k: string,
        b: unknown,
        p: number,
        cfg: unknown,
      ) => Promise<Array<{ profileId: string; start: number; end: number }>>;
    };
  };
  return __testing.resolveGatewayMentions(
    conn,
    "agent:a:atrium:chat:u-x:c1",
    body,
    prefixLength,
    { openclawAuthMode: authMode },
  );
}

describe("who the gateway is told about", () => {
  it("maps a canonical to the profile the gateway minted for it", async () => {
    const gw = gatewayWith([{ profileId: "p-alice", displayName: "u-alice" }]);
    await gw.ready;
    try {
      const conn = await OpenClawConnection.connect(gw.url, "", deviceIdentity());
      const out = await resolve(
        conn,
        { chatId: "c1", mentions: [{ canonical: "u-alice", start: 4, end: 12 }] },
        0,
        "trusted-proxy",
      );
      expect(out).toEqual([{ profileId: "p-alice", start: 4, end: 12 }]);
      conn.close();
    } finally {
      await gw.stop();
    }
  });

  it("shifts the spans past what was prepended to the message", async () => {
    // Re-hydration puts the conversation history in front of what the person
    // typed. An unshifted span points into the history and the gateway refuses
    // the whole send.
    const gw = gatewayWith([{ profileId: "p-alice", displayName: "u-alice" }]);
    await gw.ready;
    try {
      const conn = await OpenClawConnection.connect(gw.url, "", deviceIdentity());
      const out = await resolve(
        conn,
        { chatId: "c1", mentions: [{ canonical: "u-alice", start: 4, end: 12 }] },
        100,
        "trusted-proxy",
      );
      expect(out).toEqual([{ profileId: "p-alice", start: 104, end: 112 }]);
      conn.close();
    } finally {
      await gw.stop();
    }
  });

  it("says nothing on a shared-token instance, and does not even ask", async () => {
    // There is one profile for everybody there: asking could only be refused.
    let asked = false;
    const gw = gatewayWith([], () => {
      asked = true;
    });
    await gw.ready;
    try {
      const conn = await OpenClawConnection.connect(gw.url, "", deviceIdentity());
      const out = await resolve(
        conn,
        { chatId: "c1", mentions: [{ canonical: "u-alice", start: 0, end: 6 }] },
        0,
        "token",
      );
      expect(out).toEqual([]);
      expect(asked, "a token instance must not spend an RPC on this").toBe(false);
      conn.close();
    } finally {
      await gw.stop();
    }
  });

  it("drops a person the gateway has never seen, and keeps the others", async () => {
    // Everyone in the room has an Atrium account; a gateway profile only exists
    // once they have connected to THIS gateway.
    const gw = gatewayWith([{ profileId: "p-alice", displayName: "u-alice" }]);
    await gw.ready;
    try {
      const conn = await OpenClawConnection.connect(gw.url, "", deviceIdentity());
      const out = await resolve(
        conn,
        {
          chatId: "c1",
          mentions: [
            { canonical: "u-ghost", start: 0, end: 7 },
            { canonical: "u-alice", start: 8, end: 16 },
          ],
        },
        0,
        "trusted-proxy",
      );
      expect(out).toEqual([{ profileId: "p-alice", start: 8, end: 16 }]);
      conn.close();
    } finally {
      await gw.stop();
    }
  });

  it("returns the survivors in TEXT order after a middle one is dropped", async () => {
    // Upstream walks the list once, in order. A dropped middle entry must not
    // leave the rest out of order.
    const gw = gatewayWith([
      { profileId: "p-a", displayName: "u-a" },
      { profileId: "p-c", displayName: "u-c" },
    ]);
    await gw.ready;
    try {
      const conn = await OpenClawConnection.connect(gw.url, "", deviceIdentity());
      const out = await resolve(
        conn,
        {
          chatId: "c1",
          mentions: [
            { canonical: "u-c", start: 20, end: 24 },
            { canonical: "u-b", start: 10, end: 14 },
            { canonical: "u-a", start: 0, end: 4 },
          ],
        },
        0,
        "trusted-proxy",
      );
      expect(out.map((m) => m.start)).toEqual([0, 20]);
      conn.close();
    } finally {
      await gw.stop();
    }
  });

  it("names nobody rather than failing the turn when the gateway will not answer", async () => {
    const gw = startWsFakeGateway({ version: "2026.9.2", onMethod: () => NO_ANSWER });
    await gw.ready;
    try {
      const conn = await OpenClawConnection.connect(gw.url, "", deviceIdentity());
      await expect(
        resolve(
          conn,
          { chatId: "c1", mentions: [{ canonical: "u-alice", start: 0, end: 6 }] },
          0,
          "trusted-proxy",
        ),
      ).resolves.toEqual([]);
      conn.close();
    } finally {
      await gw.stop();
    }
  }, 20_000);

  it("costs nothing at all when the turn names nobody", async () => {
    let asked = false;
    const gw = gatewayWith([], () => {
      asked = true;
    });
    await gw.ready;
    try {
      const conn = await OpenClawConnection.connect(gw.url, "", deviceIdentity());
      expect(await resolve(conn, { chatId: "c1" }, 0, "trusted-proxy")).toEqual([]);
      expect(asked).toBe(false);
      conn.close();
    } finally {
      await gw.stop();
    }
  });
});
