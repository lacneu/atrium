/**
 * `HermesFilesFetcher.readAgentFile` — decoded vs UNDECODABLE (W10).
 *
 * The post-write confirmation on the Hermes side is built from this read, and Convex
 * decides whether an agent-file write landed from that confirmation. So the read has to
 * distinguish three outcomes that all used to arrive as `content: ""`:
 *   - the file is absent (404),
 *   - the response carried no parsable data URL, or an INVALID base64 payload
 *     (`Buffer.from` accepts garbage silently and yields an empty string),
 *   - the file is genuinely empty.
 * Conflating the second with the third let a write of "" confirm itself against a
 * malformed response, which marked the save as landed and purged a curation proposal.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { HermesFilesFetcher } from "../src/providers/hermes/files-fetcher.js";

const fetcher = () =>
  new HermesFilesFetcher({
    baseUrl: "http://hermes.test",
    credential: "tok",
    maxBytes: 1_000_000,
  });

/** Answers the root lookup, then the read, with the given body. */
function stub(readBody: unknown, status = 200) {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/files/read")) {
      return new Response(JSON.stringify(readBody), { status });
    }
    return new Response(JSON.stringify({ path: "/data" }), { status: 200 });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("readAgentFile", () => {
  it("decodes a well-formed payload", async () => {
    stub({ data_url: `data:text/plain;base64,${Buffer.from("hello").toString("base64")}` });
    expect(await fetcher().readAgentFile("A.md")).toEqual({
      content: "hello",
      missing: false,
      decoded: true,
    });
  });

  it("an EMPTY payload is a genuinely empty file, and stays decoded", async () => {
    stub({ data_url: "data:text/plain;base64," });
    expect(await fetcher().readAgentFile("A.md")).toEqual({
      content: "",
      missing: false,
      decoded: true,
    });
  });

  it("INVALID base64 is undecodable, not an empty file", async () => {
    // `Buffer.from("%%%%", "base64")` returns an empty buffer without complaining, so
    // matching the data-URL prefix was never proof the payload was readable.
    for (const payload of ["%%%%", "a", "abc", "***", "ab=c"]) {
      stub({ data_url: `data:text/plain;base64,${payload}` });
      expect(await fetcher().readAgentFile("A.md"), payload).toEqual({
        content: "",
        missing: false,
        decoded: false,
      });
    }
  });

  it("a LOSSY decode is undecodable: bytes that are not text are not content", async () => {
    // `toString("utf8")` replaces invalid sequences with U+FFFD without complaining, so
    // arbitrary bytes came back as a plausible string — and a post-write comparison
    // against that string can "match" content the file does not hold.
    stub({ data_url: "data:application/octet-stream;base64,wA==" }); // 0xC0, invalid UTF-8
    expect(await fetcher().readAgentFile("A.md")).toEqual({
      content: "",
      missing: false,
      decoded: false,
    });
    // …and a real multi-byte character still round-trips.
    stub({ data_url: `data:text/plain;base64,${Buffer.from("héllo ✅").toString("base64")}` });
    expect(await fetcher().readAgentFile("A.md")).toEqual({
      content: "héllo ✅",
      missing: false,
      decoded: true,
    });
  });

  it("no data URL at all is undecodable", async () => {
    for (const body of [{}, { data_url: "" }, { data_url: "not-a-data-url" }]) {
      stub(body);
      expect(await fetcher().readAgentFile("A.md")).toEqual({
        content: "",
        missing: false,
        decoded: false,
      });
    }
  });

  it("404 is missing", async () => {
    stub({}, 404);
    expect(await fetcher().readAgentFile("A.md")).toEqual({
      content: "",
      missing: true,
      decoded: false,
    });
  });
});
