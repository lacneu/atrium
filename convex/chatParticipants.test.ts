import { readFileSync } from "node:fs";

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { resolveTargetForChat } from "./routing";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type T = ReturnType<typeof convexTest>;

// GROUP CHATS — a chat with more than one human in it.
//
// The boundary being pinned here is an ACCESS boundary, so every case is written
// from the outside: what a person can reach, not what a helper returns. The rules:
//   - the owner administers, a participant converses, a stranger sees nothing;
//   - the roster is visible to everyone in the room, and to nobody else;
//   - a participant's message is attributed to THEM while the row stays owned by
//     the chat owner, because 48 access checks read that field;
//   - membership is never a grant: it opens a conversation, not an agent.

async function seedUser(
  t: T,
  canonical: string,
  role: "user" | "admin" | "pending" = "user",
): Promise<Id<"users">> {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("profiles", {
      userId,
      role,
      canonical,
      name: canonical,
      email: `${canonical}@example.com`,
    });
    return userId;
  });
}

async function seedChat(t: T, userId: Id<"users">, title = "Sujet"): Promise<Id<"chats">> {
  return t.run(async (ctx) =>
    ctx.db.insert("chats", { userId, updatedAt: 1, title }),
  );
}

async function addParticipantRow(t: T, chatId: Id<"chats">, userId: Id<"users">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("chatParticipants", {
      chatId,
      userId,
      addedBy: userId,
      addedAt: 1,
    });
  });
}

const as = (t: T, userId: Id<"users">) => t.withIdentity({ subject: userId });

describe("who can reach a group chat", () => {
  test("a participant reads the conversation; a stranger is refused", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const stranger = await seedUser(t, "stranger");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);

    await expect(
      as(t, guest).query(api.messages.listByChat, { chatId }),
    ).resolves.toBeInstanceOf(Array);
    // The refusal must stay a refusal, not an empty list: an empty list would tell
    // a stranger the chat exists and is simply quiet.
    await expect(
      as(t, stranger).query(api.messages.listByChat, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a deleted chat reads as introuvable, never as forbidden", async () => {
    // The router renders these two differently, and a chat somebody deleted must
    // not look like a chat somebody is hiding.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const chatId = await seedChat(t, owner);
    await t.run(async (ctx) => ctx.db.delete(chatId));
    await expect(
      as(t, owner).query(api.messages.listByChat, { chatId }),
    ).resolves.toEqual([]);
  });

  test("a participant sees the live stream, not a conversation frozen until the end", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await expect(
      as(t, guest).query(api.messages.getStreamingText, { chatId }),
    ).resolves.toBeInstanceOf(Array);
    const stranger = await seedUser(t, "stranger");
    await expect(
      as(t, stranger).query(api.messages.getStreamingText, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a group chat appears in the participant's sidebar", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner, "Revue de sprint");
    await addParticipantRow(t, chatId, guest);
    const list = await as(t, guest).query(api.messages.listChats, {});
    expect(list.map((c: { _id: Id<"chats"> }) => String(c._id))).toContain(String(chatId));
  });

  test("an archived group chat stays out of the sidebar, like an owned one", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await t.run(async (ctx) => ctx.db.patch(chatId, { archived: true }));
    const list = await as(t, guest).query(api.messages.listChats, {});
    expect(list.map((c: { _id: Id<"chats"> }) => String(c._id))).not.toContain(
      String(chatId),
    );
  });
});

describe("who may change the roster", () => {
  test("the owner adds; the participant cannot", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const third = await seedUser(t, "third");
    const chatId = await seedChat(t, owner);

    await expect(
      as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest }),
    ).resolves.toEqual({ added: true });
    await expect(
      as(t, guest).mutation(api.chatParticipants.addMember, { chatId, memberId: third }),
    ).rejects.toThrow(/only the chat owner/);
  });

  test("adding twice is not an error and does not duplicate the roster", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest });
    await expect(
      as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest }),
    ).resolves.toEqual({ added: false, reason: "already-member" });
    const roster = await as(t, owner).query(api.chatParticipants.listMembers, { chatId });
    expect(roster).toHaveLength(2);
  });

  test("adding the owner is a no-op, never a second roster row", async () => {
    // A duplicate would show the owner twice AND expose a "remove" affordance that
    // strips the owner from their own conversation.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const chatId = await seedChat(t, owner);
    await expect(
      as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: owner }),
    ).resolves.toEqual({ added: false, reason: "already-owner" });
    expect(await as(t, owner).query(api.chatParticipants.listMembers, { chatId })).toHaveLength(1);
  });

  test("a pending user cannot be invited", async () => {
    // They are blocked from the app: the roster row would name someone who can
    // never open the conversation.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const blocked = await seedUser(t, "blocked", "pending");
    const chatId = await seedChat(t, owner);
    await expect(
      as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: blocked }),
    ).rejects.toThrow(/not approved/);
  });

  test("a participant may leave, but may not remove anyone else", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const other = await seedUser(t, "other");
    const chatId = await seedChat(t, owner);
    await as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest });
    await as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: other });

    await expect(
      as(t, guest).mutation(api.chatParticipants.removeMember, { chatId, memberId: other }),
    ).rejects.toThrow(/only the chat owner/);
    await expect(
      as(t, guest).mutation(api.chatParticipants.removeMember, { chatId, memberId: guest }),
    ).resolves.toEqual({ removed: true });
    // And leaving really closes the door.
    await expect(
      as(t, guest).query(api.messages.listByChat, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("the owner cannot be removed from their own chat", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const chatId = await seedChat(t, owner);
    await expect(
      as(t, owner).mutation(api.chatParticipants.removeMember, { chatId, memberId: owner }),
    ).rejects.toThrow(/owner cannot be removed/);
  });

  test("the roster is visible inside the room and blank outside it", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const stranger = await seedUser(t, "stranger");
    const chatId = await seedChat(t, owner);
    await as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest });

    const seenByGuest = await as(t, guest).query(api.chatParticipants.listMembers, { chatId });
    expect(seenByGuest.map((m) => m.role)).toEqual(["owner", "participant"]);
    expect(seenByGuest[0]?.name).toBe("owner");
    // A stranger learns nothing — not even that the chat has members.
    expect(await as(t, stranger).query(api.chatParticipants.listMembers, { chatId })).toEqual([]);
  });

  test("only the owner is offered candidates, and never someone already in the room", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const free = await seedUser(t, "free");
    await seedUser(t, "blocked", "pending");
    const chatId = await seedChat(t, owner);
    await as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest });

    const candidates = await as(t, owner).query(api.chatParticipants.listInvitable, { chatId });
    const ids = candidates.map((c) => String(c.userId));
    expect(ids).toContain(String(free));
    expect(ids).not.toContain(String(guest));
    expect(ids).not.toContain(String(owner));
    // A pending profile is not a candidate: addMember would refuse it anyway.
    expect(candidates.map((c) => c.name)).not.toContain("blocked");
    // A participant is not offered the roster tools at all.
    expect(await as(t, guest).query(api.chatParticipants.listInvitable, { chatId })).toEqual([]);
  });
});

describe("a participant posting into the conversation", () => {
  /** Grant a user an agent on an instance, the way the admin surfaces do. */
  async function grantAgent(
    t: T,
    userId: Id<"users">,
    instanceName: string,
    agentId: string,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: instanceName, gatewayUrl: "ws://gw" });
      await ctx.db.insert("agents", {
        instanceName,
        agentId,
        displayName: agentId,
        enabled: true,
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId,
        instanceName,
        agentId,
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    });
  }

  /** Grant only — the instance and agent rows already exist. */
  async function grantAgent2(
    t: T,
    userId: Id<"users">,
    instanceName: string,
    agentId: string,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId,
        instanceName,
        agentId,
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    });
  }

  test("the message is OWNED by the chat owner and AUTHORED by the sender", async () => {
    // The single most dangerous field in this feature: `messages.userId` is the
    // denormalized owner that access checks across the codebase read. If the
    // sender landed there, a participant's message would silently re-point every
    // one of those checks at the participant.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await grantAgent(t, guest, "alpha", "alice");
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });

    await as(t, guest).mutation(api.send.sendMessage, {
      chatId,
      text: "bonjour tout le monde",
      clientMessageId: "c1",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .filter((q) => q.eq(q.field("chatId"), chatId))
        .collect(),
    );
    const user = rows.find((r) => r.role === "user");
    expect(user?.text).toBe("bonjour tout le monde");
    expect(String(user?.userId)).toBe(String(owner));
    expect(String(user?.authorUserId)).toBe(String(guest));
  });

  test("the owner's own message carries no author stamp", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const chatId = await seedChat(t, owner);
    await grantAgent(t, owner, "alpha", "alice");
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });
    await as(t, owner).mutation(api.send.sendMessage, {
      chatId,
      text: "seul",
      clientMessageId: "c1",
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .filter((q) => q.eq(q.field("chatId"), chatId))
        .collect(),
    );
    expect(rows.find((r) => r.role === "user")?.authorUserId).toBeUndefined();
  });

  test("a stranger cannot post, even knowing the chat id", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const stranger = await seedUser(t, "stranger");
    const chatId = await seedChat(t, owner);
    await grantAgent(t, stranger, "alpha", "alice");
    await expect(
      as(t, stranger).mutation(api.send.sendMessage, {
        chatId,
        text: "intrusion",
        clientMessageId: "c1",
      }),
    ).rejects.toThrow(/Forbidden|Not found/);
  });

  test("the gateway session follows the OWNER, not whoever is speaking", async () => {
    // The session key carries a canonical. Resolving the SENDER's would open a
    // SECOND gateway session for the same conversation, and the group would
    // silently split in two — each half unaware of the other's messages.
    //
    // Asserted on the RESOLVER's own output. An earlier version of this test read
    // an `outbox` field that does not exist, so it passed with the defect
    // deliberately reintroduced: a test that cannot fail proves nothing.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await grantAgent(t, guest, "alpha", "alice");
    await grantAgent2(t, owner, "alpha", "alice");
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });

    const resolved = await t.run(async (ctx) => {
      const chat = await ctx.db.get(chatId);
      return await resolveTargetForChat(ctx, chat!, guest);
    });
    expect(resolved.target?.canonical).toBe("owner");
    expect(resolved.target?.canonical).not.toBe("guest");
  });
});

describe("what the lot must not leave behind", () => {
  test("deleting a chat takes its roster with it", async () => {
    // A surviving roster row is not cosmetic: it keeps a seat in the person's
    // bounded participation scan, and it would hand back access if the id were
    // ever reused.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest });
    await as(t, owner).mutation(api.chats.deleteChat, { chatId });
    const left = await t.run(async (ctx) => ctx.db.query("chatParticipants").collect());
    expect(left).toEqual([]);
  });

  test("the roster names people without handing out their addresses", async () => {
    // Before this feature the only profile directory in the app was admin-gated.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await as(t, owner).mutation(api.chatParticipants.addMember, { chatId, memberId: guest });
    const roster = await as(t, guest).query(api.chatParticipants.listMembers, { chatId });
    for (const m of roster) expect(JSON.stringify(m)).not.toContain("@example.com");
    const candidates = await as(t, owner).query(api.chatParticipants.listInvitable, { chatId });
    expect(JSON.stringify(candidates)).not.toContain("@example.com");
  });

  test("a participant can mark a group chat seen", async () => {
    // The read marker is per viewer. Refusing them threw on every arrival in an
    // open group chat, and the unread dot could never clear.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const stranger = await seedUser(t, "stranger");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await expect(
      as(t, guest).mutation(api.chatReads.markChatSeen, { chatId }),
    ).resolves.not.toThrow();
    await expect(
      as(t, stranger).mutation(api.chatReads.markChatSeen, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("a participant sees the conversation's sub-agent work", async () => {
    // Half the thread's content lives there; the owner-only query threw on open.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const stranger = await seedUser(t, "stranger");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await expect(
      as(t, guest).query(api.subAgents.listSubAgents, { chatId }),
    ).resolves.toBeDefined();
    await expect(
      as(t, stranger).query(api.subAgents.listSubAgents, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("every query the chat view opens with", () => {
  // Found by OPENING the chat as a participant, not by reading the code: the view
  // subscribes to several owner-scoped queries at once, and one throw takes the
  // whole route to the error boundary before a message renders. This test names
  // them, so adding a fifth owner-only subscription fails here instead of in a
  // browser.
  const OPENING_QUERIES = ["listByChat", "getStreamingText", "getSessionMeta"] as const;

  test("a participant can run all of them", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    for (const name of OPENING_QUERIES) {
      await expect(
        as(t, guest).query(api.messages[name], { chatId }),
        name,
      ).resolves.not.toThrow();
    }
    await expect(
      as(t, guest).query(api.agents.getChatAgent, { chatId }),
    ).resolves.not.toThrow();
    await expect(
      as(t, guest).query(api.subAgents.listSubAgents, { chatId }),
    ).resolves.not.toThrow();
    await expect(
      as(t, guest).query(api.voice.voiceConfigForChat, { chatId }),
    ).resolves.not.toThrow();
  });

  test("and a stranger can run none of them", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const stranger = await seedUser(t, "stranger");
    const chatId = await seedChat(t, owner);
    for (const name of OPENING_QUERIES) {
      await expect(
        as(t, stranger).query(api.messages[name], { chatId }),
        name,
      ).rejects.toThrow(/Forbidden/);
    }
    await expect(
      as(t, stranger).query(api.agents.getChatAgent, { chatId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      as(t, stranger).query(api.voice.voiceConfigForChat, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("membership never routes around an administrator", () => {
  /** Grant only — the instance and agent rows already exist. */
  async function grantOnly(
    t: T,
    userId: Id<"users">,
    instanceName: string,
    agentId: string,
  ) {
    await t.run(async (ctx) => {
      await ctx.db.insert("userAgents", {
        userId,
        instanceName,
        agentId,
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
    });
  }

  async function seedInstanceAgent(t: T, instanceName: string, agentId: string) {
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: instanceName, gatewayUrl: "ws://gw" });
      await ctx.db.insert("agents", {
        instanceName,
        agentId,
        displayName: agentId,
        enabled: true,
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
    });
  }

  /**
   * Put a person in a group that grants exactly `agents`.
   *
   * Load-bearing detail found while writing this: a user in NO group holds the
   * WHOLE pool of enabled agents (the groupless-user fallback), so "revoked" cannot
   * be expressed by omitting a row — the person has to be in a group that does not
   * grant the agent. That is also how a real deployment revokes.
   */
  async function seedGroup(
    t: T,
    key: string,
    members: Id<"users">[],
    agents: Array<{ instanceName: string; agentId: string }>,
  ) {
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("groups", {
        key,
        name: key,
        createdBy: members[0]!,
        createdAt: 1,
      });
      for (const a of agents) {
        await ctx.db.insert("groupAgents", {
          groupId,
          instanceName: a.instanceName,
          agentId: a.agentId,
          createdAt: 1,
        });
      }
      for (const userId of members) {
        await ctx.db.insert("groupMembers", { groupId, userId, joinedAt: 1 });
      }
    });
  }

  test("a chat whose OWNER lost the agent stays read-only, whoever is speaking", async () => {
    // The bypass this guards: an admin revokes the owner's access, so her chat is
    // read-only for her. A participant who still holds that agent must NOT be able
    // to keep the conversation alive — the dispatch runs under the OWNER's
    // canonical, in the OWNER's gateway session, and she would read the answers to
    // a turn she is no longer entitled to make. The dispatch therefore resolves the
    // routing on the OWNER (convex/bridge.ts), which is what this asserts.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await seedInstanceAgent(t, "alpha", "alice");
    await seedInstanceAgent(t, "alpha", "bob");
    // The GUEST's group grants alice; the OWNER's group does not (revoked).
    await seedGroup(t, "with-alice", [guest], [
      { instanceName: "alpha", agentId: "alice" },
    ]);
    await seedGroup(t, "without-alice", [owner], [
      { instanceName: "alpha", agentId: "bob" },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });

    const [asOwner, asGuest] = await t.run(async (ctx) => {
      const chat = await ctx.db.get(chatId);
      return [
        await resolveTargetForChat(ctx, chat!, owner),
        await resolveTargetForChat(ctx, chat!, guest),
      ];
    });
    // The guest COULD run it — and that is exactly why the dispatch must not ask.
    expect(asGuest.target?.agentId).toBe("alice");
    expect(asOwner.target).toBeNull();
    expect(asOwner.failReason).toBe("agent_restricted");
  });

  test("with the owner still granted, the conversation runs on the owner's binding", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await seedInstanceAgent(t, "alpha", "alice");
    await grantOnly(t, owner, "alpha", "alice");
    await grantOnly(t, guest, "alpha", "alice");
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });
    const asOwner = await t.run(async (ctx) => {
      const chat = await ctx.db.get(chatId);
      return await resolveTargetForChat(ctx, chat!, owner);
    });
    expect(asOwner.target?.agentId).toBe("alice");
    expect(asOwner.target?.canonical).toBe("owner");
  });

  test("a participant with NO grant cannot send at all", async () => {
    // Checked at the source: being invited into a conversation is not a grant.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await seedInstanceAgent(t, "alpha", "alice");
    await seedInstanceAgent(t, "alpha", "bob");
    // Groups, or the guest would hold the whole pool by default (see seedGroup).
    await seedGroup(t, "with-alice", [owner], [
      { instanceName: "alpha", agentId: "alice" },
    ]);
    await seedGroup(t, "without-alice", [guest], [
      { instanceName: "alpha", agentId: "bob" },
    ]);
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });
    await expect(
      as(t, guest).mutation(api.send.sendMessage, {
        chatId,
        text: "sans droit",
        clientMessageId: "c9",
        routedAgent: { instanceName: "alpha", agentId: "alice" },
      }),
    ).rejects.toThrow();
  });
});

describe("the dispatch asks about the OWNER, in the source", () => {
  // WHY A SOURCE CHECK. The behavioural test above proves the RESOLVER refuses a
  // revoked owner — but it calls the resolver directly, so it stays green if the
  // dispatch goes back to passing the sender. Neutralizing the fix did not fail a
  // single test, which is the definition of a guard that does not guard. The
  // dispatch itself is an internalAction that POSTs to the bridge, so the wiring is
  // what has to be asserted, and it is asserted where it lives.
  const dispatchRegion = (): string => {
    const src = readFileSync(new URL("./bridge.ts", import.meta.url), "utf8");
    const start = src.indexOf("export const dispatch = internalAction(");
    const end = src.indexOf("export const dispatchPatch = internalAction(");
    expect(start, "the dispatch action moved — this gate sweeps nothing").toBeGreaterThan(-1);
    expect(end, "dispatchPatch moved").toBeGreaterThan(start);
    // Comments stripped: prose ABOUT a call is not a call, and this file explains
    // the rule at length right beside the code that applies it.
    return src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
  };

  test("the two routing resolutions take the chat owner", () => {
    const region = dispatchRegion();
    for (const call of ["getChatRouting", "beginTurnRouting"]) {
      const at = region.indexOf(call);
      expect(at, call).toBeGreaterThan(-1);
      // The `userId:` that belongs to this call is the first one after it.
      const args = region.slice(at, at + 900);
      const userIdArg = /userId:\s*([A-Za-z_.]+)/.exec(args)?.[1];
      expect(userIdArg, `${call} must resolve on the chat owner`).toBe("chatOwnerId");
    }
  });

  test("the failed-assistant message is written for the chat owner", () => {
    // `messages.userId` is the denormalized owner that access checks read; the
    // sender's id there would silently re-point them.
    const src = readFileSync(new URL("./bridge.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    const at = src.indexOf('insert("messages"');
    expect(at).toBeGreaterThan(-1);
    const args = src.slice(at, at + 400);
    expect(/userId:\s*([A-Za-z_.]+)/.exec(args)?.[1]).toBe("chat.userId");
  });
});

describe("what a participant is NOT told", () => {
  test("the owner's folder is not disclosed", async () => {
    // Folders are the owner's private tree; a participant's own `listProjects`
    // resolves nothing from it, so the id would be an opaque leak and nothing more.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    const projectId = await t.run(async (ctx) =>
      ctx.db.insert("projects", { userId: owner, name: "Client ACME" }),
    );
    await t.run(async (ctx) => ctx.db.patch(chatId, { projectId }));

    const asOwner = await as(t, owner).query(api.messages.getSessionMeta, { chatId });
    const asGuest = await as(t, guest).query(api.messages.getSessionMeta, { chatId });
    expect(String(asOwner?.projectId)).toBe(String(projectId));
    expect(asGuest?.projectId).toBeNull();
    // And the viewer's own standing IS told, because the UI decides on it.
    expect(asOwner?.viewerRole).toBe("owner");
    expect(asGuest?.viewerRole).toBe("participant");
  });
});

describe("the sidebar is each person's own", () => {
  test("a participant hides a group chat for THEMSELVES, not for the room", async () => {
    // The chat's own `sidebarHidden` is per CHAT. Writing a participant's choice
    // there would take the conversation off the owner's sidebar — and off every
    // other participant's — because one person tidied up.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const other = await seedUser(t, "other");
    const chatId = await seedChat(t, owner, "Revue");
    await addParticipantRow(t, chatId, guest);
    await addParticipantRow(t, chatId, other);

    await as(t, guest).mutation(api.chats.setChatSidebar, { chatId, hidden: true });

    const inSidebar = async (u: Id<"users">) =>
      (await as(t, u).query(api.messages.listChats, {})).map((c: { _id: Id<"chats"> }) =>
        String(c._id),
      );
    expect(await inSidebar(guest)).not.toContain(String(chatId));
    expect(await inSidebar(owner)).toContain(String(chatId));
    expect(await inSidebar(other)).toContain(String(chatId));
    // And the chat itself was not touched.
    const chat = await t.run(async (ctx) => ctx.db.get(chatId));
    expect(chat?.sidebarHidden).toBeUndefined();
  });

  test("the OWNER hiding it does not clear it from the participants' sidebars", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner, "Revue");
    await addParticipantRow(t, chatId, guest);

    await as(t, owner).mutation(api.chats.setChatSidebar, { chatId, hidden: true });

    const ownerSidebar = (await as(t, owner).query(api.messages.listChats, {})).map(
      (c: { _id: Id<"chats"> }) => String(c._id),
    );
    const guestSidebar = (await as(t, guest).query(api.messages.listChats, {})).map(
      (c: { _id: Id<"chats"> }) => String(c._id),
    );
    expect(ownerSidebar).not.toContain(String(chatId));
    expect(guestSidebar).toContain(String(chatId));
  });

  test("a stranger cannot touch anybody's sidebar", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const stranger = await seedUser(t, "stranger");
    const chatId = await seedChat(t, owner);
    await expect(
      as(t, stranger).mutation(api.chats.setChatSidebar, { chatId, hidden: true }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("what a trace has to say about a group turn", () => {
  // The operator question this answers, without reproducing anything anyone wrote:
  // "the gateway attributed this session to the bridge / to somebody else — why?"
  // The turn's own trace states the mode, the identity it ran under, and whether
  // the person who typed it was the owner.
  test("the routing reports the instance's authentication mode", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const chatId = await seedChat(t, owner);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "alpha",
        gatewayUrl: "ws://gw",
        bridgeUrl: "http://bridge",
        authMode: "trusted-proxy" as const,
      });
      await ctx.db.insert("agents", {
        instanceName: "alpha",
        agentId: "alice",
        displayName: "alice",
        enabled: true,
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.insert("userAgents", {
        userId: owner,
        instanceName: "alpha",
        agentId: "alice",
        isDefault: true,
        source: "manual" as const,
        createdAt: 1,
      });
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });

    const routing = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: owner,
    });
    expect(routing?.authMode).toBe("trusted-proxy");
    // The identity the turn runs under is the OWNER's key, whoever typed it.
    expect(routing?.target?.canonical).toBe("owner");
  });

  test("an instance with no mode recorded reads as the shared token", async () => {
    // Every instance written before per-user identity existed, and the default.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const chatId = await seedChat(t, owner);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", { name: "alpha", gatewayUrl: "ws://gw" });
      await ctx.db.insert("agents", {
        instanceName: "alpha",
        agentId: "alice",
        displayName: "alice",
        enabled: true,
        source: "discovered" as const,
        presentInLastOk: true,
        firstSeenAt: 1,
        lastSeenAt: 1,
      });
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });
    const routing = await t.query(internal.bridge.getChatRouting, {
      chatId,
      userId: owner,
    });
    expect(routing?.authMode).toBe("token");
  });

  test("the dispatch reads the room's size in the same query as its owner", async () => {
    // One bounded read, not a second round-trip: the trace states the count on
    // every dispatch, so it must not cost one.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const other = await seedUser(t, "other");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await addParticipantRow(t, chatId, other);

    const facts = await t.query(internal.bridge.getChatOwner, { chatId });
    expect(String(facts?.ownerId)).toBe(String(owner));
    expect(facts?.participantCount).toBe(2);
    expect(await t.query(internal.bridge.getChatOwner, { chatId: chatId })).not.toBeNull();
  });

  test("the trace states the identity facts on every dispatch, not only on failures", () => {
    // Asserted in the SOURCE: the dispatch is an action that POSTs to the bridge,
    // so the only way to pin what it puts on the trace is where it puts it. An
    // attribution question must be answerable from the turn that raised it.
    const src = readFileSync(new URL("./bridge.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^[ \t]*\/\/.*$/gm, " ");
    const at = src.lastIndexOf("await traceDispatch(ctx, {");
    expect(at).toBeGreaterThan(-1);
    const call = src.slice(at, at + 900);
    for (const field of [
      "authMode:",
      "gatewayIdentity:",
      "participantCount:",
      "fromParticipant:",
    ]) {
      expect(call, field).toContain(field);
    }
  });
});

describe("the assessment answers the attribution question on its own", () => {
  test("it states the room's size and the gateway's authentication mode", async () => {
    // The MCP entry point for a user report is diagnose_chat, which reads this.
    // Without these two facts an operator asking "why is this session attributed
    // to the bridge?" has to correlate traces by hand before they can even start.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    await t.run(async (ctx) => {
      await ctx.db.insert("instances", {
        name: "alpha",
        gatewayUrl: "ws://gw",
        authMode: "trusted-proxy" as const,
      });
      await ctx.db.patch(chatId, { instanceName: "alpha", agentId: "alice" });
    });

    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.participantCount).toBe(1);
    expect(state.authMode).toBe("trusted-proxy");
  });

  test("a solo chat on a token instance reads as 0 and token", async () => {
    // The overwhelming majority, and the shape must not change for them.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const chatId = await seedChat(t, owner);
    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.participantCount).toBe(0);
    expect(state.authMode).toBe("token");
  });

  test("it never carries a participant's name or address", async () => {
    // SOC2: the observability surfaces state counts, buckets and enums — never
    // who somebody is. A roster belongs to the conversation, not to a trace.
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "owner");
    const guest = await seedUser(t, "guest");
    const chatId = await seedChat(t, owner);
    await addParticipantRow(t, chatId, guest);
    const state = await t.query(internal.messages.chatStateInternal, { chatId });
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("guest@example.com");
    expect(serialized).not.toContain("@example.com");
  });
});
