/// <reference types="vite/client" />
//
// The COMPOSER's upfront over-size gate (attachmentAdapter.add) — previously
// UNTESTED, and it FAILED OPEN when the gateway cap was not yet known, letting an
// oversize upload sail past to be rejected downstream with no upfront
// "trop volumineuse". These pin: it rejects over the cap, NEVER fails open (falls
// back to OpenClaw's default frame limit, the SAME value the Convex dispatch uses),
// and a shared-fs tool-read file bypasses the inline cap while an image does not.

import type { PendingAttachment } from "@assistant-ui/react";
import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import { createConvexAttachmentAdapter } from "./attachmentAdapter";
import { api } from "./convexApi";
import { formatFileSize } from "./fileMetaView";
import { m } from "@/paraglide/messages.js";
import { getLocale } from "@/paraglide/runtime.js";
import {
  DEFAULT_GATEWAY_MAX_PAYLOAD,
  maxRawInboundBytes,
} from "../../convex/lib/attachmentLimits";

const DEFAULT_CAP = maxRawInboundBytes(DEFAULT_GATEWAY_MAX_PAYLOAD);
const MiB = 1024 * 1024;

/** Leading bytes of real files: the gateway sniffs them, and so does the composer. */
const MAGIC: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1],
  caf: [0x63, 0x61, 0x66, 0x66, 0, 1, 0, 0, 0x64, 0x65, 0x73, 0x63],
};

function fakeFile(
  size: number,
  type = "application/pdf",
  name = "f.pdf",
  // What the bytes really are; by default what the declared type names.
  format: string = type.split("/")[1] ?? "",
): File {
  // The adapter reads size/type/name and the file's first bytes — a real (huge) File
  // buffer is wasteful.
  const head = Uint8Array.from(MAGIC[format] ?? []);
  return {
    size,
    type,
    name,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => head.slice(start, end).buffer,
    }),
  } as unknown as File;
}

// Mock ConvexReactClient.query for the two queries add() calls. The convex `api`
// proxy is NOT === comparable, so discriminate by getFunctionName (a known trap).
const AVAIL = getFunctionName(api.bridgeHealth.getBridgeAvailability);
const POLICY = getFunctionName(api.bridge.getChatInboundPolicy);

function mockConvex(opts: {
  // undefined -> the availability query THROWS; null/number -> maxInboundBytes value.
  maxInboundBytes?: number | null;
  // The gateway's per-attachment IMAGE ceiling (policy.attachments.maxImageBytes).
  maxInboundImageBytes?: number | null;
  inboundPolicy?: { inboundMediaMode: string; sharedFsMaxBytes: number } | null;
}): Parameters<typeof createConvexAttachmentAdapter>[0] {
  return {
    query: vi.fn(async (fn: unknown) => {
      const name = getFunctionName(fn as Parameters<typeof getFunctionName>[0]);
      if (name === AVAIL) {
        if (opts.maxInboundBytes === undefined) throw new Error("unavailable");
        return {
          known: true,
          available: true,
          degraded: false,
          reason: null,
          checkedAt: 1,
          maxInboundBytes: opts.maxInboundBytes,
          maxInboundImageBytes: opts.maxInboundImageBytes ?? null,
        };
      }
      if (name === POLICY) return opts.inboundPolicy ?? null;
      throw new Error(`unexpected query ${name}`);
    }),
  } as unknown as Parameters<typeof createConvexAttachmentAdapter>[0];
}

describe("attachmentAdapter.add — upfront over-size gate", () => {
  test("rejects a file OVER the known cap (toast + throw, with the size + max)", async () => {
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(
      mockConvex({ maxInboundBytes: 5 * MiB }),
      onReject,
    );
    await expect(adapter.add({ file: fakeFile(10 * MiB) })).rejects.toThrow();
    expect(onReject).toHaveBeenCalledOnce();
    const msg = onReject.mock.calls[0][0] as string;
    expect(msg).toContain("10"); // the file size (MB)
    expect(msg).toContain("5"); // the max (MB)
  });

  test("accepts a file UNDER the known cap", async () => {
    const adapter = createConvexAttachmentAdapter(
      mockConvex({ maxInboundBytes: 5 * MiB }),
    );
    const pending = (await adapter.add({
      file: fakeFile(1 * MiB),
    })) as PendingAttachment;
    expect(pending.name).toBe("f.pdf");
    expect(pending.status.type).toBe("running");
  });

  test("does NOT fail open when the cap is UNKNOWN (null) — falls back to the default cap and STILL rejects oversize", async () => {
    // THE regression this closes: a cold-poll null cap used to accept ANY size.
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(
      mockConvex({ maxInboundBytes: null }),
      onReject,
    );
    await expect(
      adapter.add({ file: fakeFile(DEFAULT_CAP + 1) }),
    ).rejects.toThrow();
    expect(onReject).toHaveBeenCalledOnce();
  });

  test("does NOT fail open when the availability query THROWS — same default fallback", async () => {
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(
      mockConvex({ maxInboundBytes: undefined }),
      onReject,
    );
    await expect(
      adapter.add({ file: fakeFile(DEFAULT_CAP + 1) }),
    ).rejects.toThrow();
    expect(onReject).toHaveBeenCalledOnce();
  });

  test("a file UNDER the default cap is accepted while the cap is unknown (no over-blocking)", async () => {
    const adapter = createConvexAttachmentAdapter(
      mockConvex({ maxInboundBytes: null }),
    );
    const pending = (await adapter.add({
      file: fakeFile(1024),
    })) as PendingAttachment;
    expect(pending.name).toBe("f.pdf");
  });

  test("a shared-fs TOOL-READ file bypasses the inline cap (rides by reference)", async () => {
    // A large non-image file on a shared-fs instance must NOT be blocked by the
    // inline default cap — it streams by reference up to the shared-fs cap.
    const adapter = createConvexAttachmentAdapter(
      mockConvex({
        maxInboundBytes: null,
        inboundPolicy: {
          inboundMediaMode: "shared-fs",
          sharedFsMaxBytes: 500 * MiB,
        },
      }),
      undefined,
      "chat123",
    );
    const big = fakeFile(DEFAULT_CAP + 100 * MiB, "video/mp4", "clip.mp4");
    const pending = (await adapter.add({ file: big })) as PendingAttachment;
    expect(pending.name).toBe("clip.mp4");
  });

  test("a model-native IMAGE stays capped even on a shared-fs instance (Vision rides inline)", async () => {
    // The reference bypass is for TOOL-READ files only; an image feeds Vision inline,
    // so the inline cap must still hold even on a shared-fs instance.
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(
      mockConvex({
        maxInboundBytes: 5 * MiB,
        inboundPolicy: {
          inboundMediaMode: "shared-fs",
          sharedFsMaxBytes: 500 * MiB,
        },
      }),
      onReject,
      "chat123",
    );
    await expect(
      adapter.add({ file: fakeFile(10 * MiB, "image/png", "pic.png") }),
    ).rejects.toThrow();
    expect(onReject).toHaveBeenCalledOnce();
  });
});

describe("attachmentAdapter.add — the gateway's per-image ceiling", () => {
  // OpenClaw bounds each attachment's decoded size and an IMAGE more tightly (6 MiB by
  // default — hello-ok policy.attachments.maxImageBytes). An image under the file cap
  // and over that ceiling used to be uploaded, sent, then refused by the gateway.
  const CAPS = { maxInboundBytes: 19464192, maxInboundImageBytes: 6291456 };

  test("rejects an image over the image ceiling though it is under the file cap, saying it is the IMAGE limit", async () => {
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(mockConvex(CAPS), onReject);
    await expect(
      adapter.add({ file: fakeFile(8 * MiB, "image/png", "photo.png") }),
    ).rejects.toThrow();
    expect(onReject).toHaveBeenCalledOnce();
    const msg = onReject.mock.calls[0][0] as string;
    expect(msg).toBe(
      m.attach_image_too_large({
        size: formatFileSize(8 * MiB, getLocale()),
        max: formatFileSize(6291456, getLocale()),
      }),
    );
    // Not the generic "file too large" sentence: the limit named is the image one.
    expect(msg).not.toBe(m.attach_too_large({ size: 8, max: 6 }));
  });

  test("the message exists in every locale and names the image limit", () => {
    for (const locale of ["en", "fr"] as const) {
      const text = m.attach_image_too_large({ size: "8.4 MB", max: "6.3 MB" }, { locale });
      expect(text, locale).toContain("8.4 MB");
      expect(text, locale).toContain("6.3 MB");
      expect(text, locale).toMatch(/image/i);
    }
  });

  test("accepts an image AT the ceiling (the gateway refuses only above it)", async () => {
    const adapter = createConvexAttachmentAdapter(mockConvex(CAPS));
    const pending = (await adapter.add({
      file: fakeFile(6291456, "image/jpeg", "p.jpg"),
    })) as PendingAttachment;
    expect(pending.name).toBe("p.jpg");
  });

  test("a non-image of the same size is accepted: the image ceiling is for images", async () => {
    const adapter = createConvexAttachmentAdapter(mockConvex(CAPS));
    const pending = (await adapter.add({ file: fakeFile(8 * MiB) })) as PendingAttachment;
    expect(pending.name).toBe("f.pdf");
  });

  test("no image ceiling known (an older gateway): an image faces the file cap alone", async () => {
    const adapter = createConvexAttachmentAdapter(
      mockConvex({ maxInboundBytes: 19464192, maxInboundImageBytes: null }),
    );
    const pending = (await adapter.add({
      file: fakeFile(8 * MiB, "image/png", "photo.png"),
    })) as PendingAttachment;
    expect(pending.name).toBe("photo.png");
  });

  test("an image that rides BY REFERENCE (shared-fs, not model-native) is not held to the gateway's image ceiling", async () => {
    // An SVG/HEIC on a shared-fs instance is streamed to the shared volume: it never
    // becomes a gateway attachment, so the gateway's per-attachment ceiling is moot.
    const adapter = createConvexAttachmentAdapter(
      mockConvex({
        ...CAPS,
        inboundPolicy: { inboundMediaMode: "shared-fs", sharedFsMaxBytes: 500 * MiB },
      }),
      undefined,
      "chat123",
    );
    const pending = (await adapter.add({
      file: fakeFile(8 * MiB, "image/heic", "p.heic"),
    })) as PendingAttachment;
    expect(pending.name).toBe("p.heic");
  });

  test("a model-native image on a shared-fs instance still rides inline: the image ceiling holds", async () => {
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(
      mockConvex({
        ...CAPS,
        inboundPolicy: { inboundMediaMode: "shared-fs", sharedFsMaxBytes: 500 * MiB },
      }),
      onReject,
      "chat123",
    );
    await expect(
      adapter.add({ file: fakeFile(8 * MiB, "image/png", "p.png") }),
    ).rejects.toThrow();
    expect(onReject).toHaveBeenCalledOnce();
  });

  test("a NON-image declared image/png is not refused on the image ceiling (the gateway sniffs the bytes)", async () => {
    // A 8 MiB CAF voice memo declared image/png: audio to the gateway, which applies
    // its FILE ceiling. The composer reads the first bytes and lets it through.
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(mockConvex(CAPS), onReject);
    const pending = (await adapter.add({
      file: fakeFile(8 * MiB, "image/png", "memo.png", "caf"),
    })) as PendingAttachment;
    expect(pending.name).toBe("memo.png");
    expect(onReject).not.toHaveBeenCalled();
  });

  test("a real image declared application/octet-stream is refused on the image ceiling: the bytes decide", async () => {
    const onReject = vi.fn();
    const adapter = createConvexAttachmentAdapter(mockConvex(CAPS), onReject);
    await expect(
      adapter.add({ file: fakeFile(8 * MiB, "application/octet-stream", "photo.bin", "png") }),
    ).rejects.toThrow();
    expect(onReject).toHaveBeenCalledOnce();
  });

  test("an image format outside the known signatures (SVG, HEIC…) is not refused early: the gateway decides", async () => {
    const adapter = createConvexAttachmentAdapter(mockConvex(CAPS), undefined, "chat123");
    const pending = (await adapter.add({
      file: fakeFile(8 * MiB, "image/svg+xml", "logo.svg"),
    })) as PendingAttachment;
    expect(pending.name).toBe("logo.svg");
  });

  test("a file whose bytes cannot be read is not known to be an image", async () => {
    const adapter = createConvexAttachmentAdapter(mockConvex(CAPS));
    const unreadable = { size: 8 * MiB, type: "image/png", name: "p.png" } as unknown as File;
    const pending = (await adapter.add({ file: unreadable })) as PendingAttachment;
    expect(pending.name).toBe("p.png");
  });
});

describe("attachmentAdapter.add — the policy of the agent the composer targets", () => {
  test("the current selection is sent to the inbound-policy query", async () => {
    const convex = mockConvex({
      maxInboundBytes: null,
      inboundPolicy: { inboundMediaMode: "shared-fs", sharedFsMaxBytes: 500 * MiB },
    });
    const target = { instanceName: "beta", agentId: "hermes" };
    const adapter = createConvexAttachmentAdapter(convex, undefined, "chat123", () => target);
    await adapter.add({ file: fakeFile(DEFAULT_CAP + MiB, "video/mp4", "clip.mp4") });
    const policyCall = (convex.query as unknown as { mock: { calls: unknown[][] } }).mock.calls.find(
      ([fn]) => getFunctionName(fn as Parameters<typeof getFunctionName>[0]) === POLICY,
    );
    expect(policyCall?.[1]).toMatchObject({ chatId: "chat123", routedAgent: target });
  });
});
