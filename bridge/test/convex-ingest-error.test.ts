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

  it("…and the reader-exception sensor names it", () => {
    protocolDrift.observeException(
      { type: "event", event: "agent" },
      new ConvexIngestError("addPart", 500, "Convex ingest addPart -> HTTP 500"),
      "feed",
    );
    const shapes = protocolDrift.report().map((e) => e.shape);
    expect(shapes.some((s) => s.startsWith("«exception».ConvexIngestError@feed.agent"))).toBe(true);
  });
});
