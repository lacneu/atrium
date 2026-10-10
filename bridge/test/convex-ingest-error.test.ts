/**
 * A write Convex refused, while processing a frame, must not read as a bug in the
 * bridge's own reader: the exception sensor records the error CLASS only, and a plain
 * `Error` made the two indistinguishable in production (`«exception».Error@feed.agent`).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { ConvexIngestError, HttpConvexWriter } from "../src/convex-writer.js";
import { protocolDrift } from "../src/providers/openclaw/protocol-drift.js";

describe("a refused Convex write has a class of its own", () => {
  beforeEach(() => protocolDrift.resetForTests());

  it("the writer throws ConvexIngestError, carrying the op and the status", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 500, text: async () => "Document is too nested" }) as unknown as Response) as typeof fetch;
    const w = new HttpConvexWriter({
      convexHttpActionsUrl: "http://test.invalid",
      ingestSecret: "s",
      fetchImpl,
    });
    const err = await w.addToolPart("m1", { kind: "tool", name: "exec", phase: "result" } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexIngestError);
    expect((err as ConvexIngestError).status).toBe(500);
    expect((err as ConvexIngestError).op).toBe("addPart");
  });

  it("…and the reader-exception sensor names it — WHICH write, and how it failed", () => {
    // The bare class said only "some ingest failed" (prod 2026-10-01: a drift sample
    // nobody could attribute). The op and the status are structural; the message is not.
    protocolDrift.observeException(
      { type: "event", event: "agent" },
      new ConvexIngestError("addPart", 500, "Convex ingest addPart -> HTTP 500: Document is too nested"),
      "feed",
    );
    protocolDrift.observeException(
      { type: "event", event: "agent" },
      new ConvexIngestError("recordSubAgentInteractionReply", null, "timed out after 15000ms"),
      "feed",
    );
    const shapes = protocolDrift.report().map((e) => e.shape);
    expect(shapes.some((s) => s.startsWith("«exception».ConvexIngestError.addPart.500@feed.agent"))).toBe(true);
    expect(
      shapes.some((s) =>
        s.startsWith("«exception».ConvexIngestError.recordSubAgentInteractionReply.timeout@feed.agent"),
      ),
    ).toBe(true);
    // Never the message.
    expect(JSON.stringify(shapes)).not.toMatch(/nested|HTTP|15000/);
  });

  it("an op that is not an identifier falls back to the plain class name", () => {
    protocolDrift.observeException(
      { type: "event", event: "agent" },
      new ConvexIngestError("bad op; drop" as never, 400, "x"),
      "feed",
    );
    const shapes = protocolDrift.report().map((e) => e.shape);
    expect(shapes.some((s) => s.startsWith("«exception».ConvexIngestError@feed.agent"))).toBe(true);
    expect(JSON.stringify(shapes)).not.toContain("drop");
  });

  it("each shape says when it was first and last seen", () => {
    let now = 1_000;
    protocolDrift.resetForTests(() => now);
    const frame = { type: "event", event: "agent" };
    protocolDrift.observeException(frame, new ConvexIngestError("addPart", 500, "a"), "feed");
    now = 5_000;
    protocolDrift.observeException(frame, new ConvexIngestError("addPart", 500, "b"), "feed");
    const entry = protocolDrift
      .report()
      .find((e) => e.shape.startsWith("«exception».ConvexIngestError.addPart.500"));
    expect(entry).toMatchObject({ count: 2, firstAt: 1_000, lastAt: 5_000 });
  });
});
