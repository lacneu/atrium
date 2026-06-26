import { describe, expect, test } from "vitest";
import {
  parseSseBuffer,
  applySseEvent,
  EMPTY_SSE_ACCUM,
  type SseEvent,
} from "./sseStream";
import { deriveSiteUrl } from "@/lib/runtimeConfig";

describe("deriveSiteUrl (SSE endpoint origin)", () => {
  test("cloud .convex.cloud -> .convex.site", () => {
    expect(deriveSiteUrl("https://happy-animal-123.convex.cloud")).toBe(
      "https://happy-animal-123.convex.site",
    );
  });
  test("local convex-local-backend api port -> site-proxy port (+1)", () => {
    expect(deriveSiteUrl("http://127.0.0.1:3212")).toBe(
      "http://127.0.0.1:3213",
    );
  });
});

describe("parseSseBuffer", () => {
  test("splits complete events and carries the incomplete trailing block as rest", () => {
    const buf =
      'id: 1\ndata: {"kind":"append","text":"He"}\n\n' +
      'id: 2\ndata: {"kind":"append","text":"llo"}\n\n' +
      "id: 3\ndata: {"; // incomplete
    const { events, rest } = parseSseBuffer(buf);
    expect(events.map((e) => ({ id: e.id, data: e.data }))).toEqual([
      { id: 1, data: '{"kind":"append","text":"He"}' },
      { id: 2, data: '{"kind":"append","text":"llo"}' },
    ]);
    expect(rest).toBe("id: 3\ndata: {");
  });

  test("parses event-typed blocks (final, done)", () => {
    const { events } = parseSseBuffer(
      'event: final\ndata: {"text":"done text"}\n\nevent: done\ndata: {}\n\n',
    );
    expect(events[0]).toEqual({ event: "final", data: '{"text":"done text"}' });
    expect(events[1]).toEqual({ event: "done", data: "{}" });
  });

  test("is CRLF-tolerant", () => {
    const { events } = parseSseBuffer('id: 1\r\ndata: {"text":"x"}\r\n\r\n');
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(1);
  });
});

describe("applySseEvent", () => {
  const ev = (e: Partial<SseEvent> & { data: string }): SseEvent => ({ ...e });

  test("append concatenates; replace resets; tracks lastSeq", () => {
    let s = EMPTY_SSE_ACCUM;
    s = applySseEvent(s, ev({ id: 1, data: '{"kind":"append","text":"He"}' }));
    s = applySseEvent(s, ev({ id: 2, data: '{"kind":"append","text":"llo"}' }));
    expect(s.text).toBe("Hello");
    expect(s.lastSeq).toBe(2);
    s = applySseEvent(s, ev({ id: 3, data: '{"kind":"replace","text":"Hi"}' }));
    expect(s.text).toBe("Hi"); // replace resets
    expect(s.lastSeq).toBe(3);
    expect(s.done).toBe(false);
  });

  test("final sets the authoritative text; done ends", () => {
    let s = applySseEvent(EMPTY_SSE_ACCUM, ev({ id: 1, data: '{"kind":"append","text":"partial"}' }));
    s = applySseEvent(s, ev({ event: "final", data: '{"text":"the full final"}' }));
    expect(s.text).toBe("the full final");
    expect(s.done).toBe(false);
    s = applySseEvent(s, ev({ event: "done", data: "{}" }));
    expect(s.done).toBe(true);
  });

  test("ignores malformed/empty data without throwing", () => {
    let s = applySseEvent(EMPTY_SSE_ACCUM, ev({ id: 1, data: "not json" }));
    expect(s).toEqual(EMPTY_SSE_ACCUM);
    s = applySseEvent(s, ev({ id: 1, data: "" }));
    expect(s).toEqual(EMPTY_SSE_ACCUM);
  });

  test("end-to-end: a parsed stream accumulates to the final text", () => {
    const raw =
      'id: 1\ndata: {"kind":"append","text":"Once "}\n\n' +
      'id: 2\ndata: {"kind":"append","text":"upon"}\n\n' +
      'event: final\ndata: {"text":"Once upon a time"}\n\n' +
      "event: done\ndata: {}\n\n";
    const { events } = parseSseBuffer(raw);
    const final = events.reduce(applySseEvent, EMPTY_SSE_ACCUM);
    expect(final.text).toBe("Once upon a time");
    expect(final.done).toBe(true);
  });
});
