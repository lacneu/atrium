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
import {
  DEFAULT_GATEWAY_MAX_PAYLOAD,
  maxRawInboundBytes,
} from "../../convex/lib/attachmentLimits";

const DEFAULT_CAP = maxRawInboundBytes(DEFAULT_GATEWAY_MAX_PAYLOAD);
const MiB = 1024 * 1024;

function fakeFile(size: number, type = "application/pdf", name = "f.pdf"): File {
  // The adapter only reads size/type/name — a real (huge) File buffer is wasteful.
  return { size, type, name } as unknown as File;
}

// Mock ConvexReactClient.query for the two queries add() calls. The convex `api`
// proxy is NOT === comparable, so discriminate by getFunctionName (a known trap).
const AVAIL = getFunctionName(api.bridgeHealth.getBridgeAvailability);
const POLICY = getFunctionName(api.bridge.getChatInboundPolicy);

function mockConvex(opts: {
  // undefined -> the availability query THROWS; null/number -> maxInboundBytes value.
  maxInboundBytes?: number | null;
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
