// @vitest-environment node
//
// The collector's S3 client: SigV4 against AWS's published examples, and the
// ListObjectsV2 parser.

import { describe, expect, test } from "vitest";
import { parseListPage, signV4, uriEncode } from "./s3.ts";

const EXAMPLE = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  now: new Date("2013-05-24T00:00:00Z"),
};

describe("SigV4 (AWS S3 documentation examples)", () => {
  test("GET Object with a Range header", () => {
    const h = signV4({
      ...EXAMPLE,
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      query: {},
      headers: { range: "bytes=0-9" },
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(h["x-amz-date"]).toBe("20130524T000000Z");
  });

  test("GET Bucket (list objects) with a query string", () => {
    const h = signV4({
      ...EXAMPLE,
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/",
      query: { "max-keys": "2", prefix: "J" },
    });
    expect(h.authorization).toMatch(
      /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/,
    );
  });

  test("keys are encoded per RFC 3986, slashes kept in paths", () => {
    expect(uriEncode("inst-1/a b(c)", true)).toBe("inst-1/a%20b%28c%29");
    expect(uriEncode("inst-1/x", false)).toBe("inst-1%2Fx");
  });
});

describe("ListObjectsV2", () => {
  test("entries, sizes, times and the continuation token", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><Name>files</Name><Prefix></Prefix><KeyCount>2</KeyCount>
<IsTruncated>true</IsTruncated><NextContinuationToken>tok&amp;en</NextContinuationToken>
<Contents><Key>inst-9f/1b2c.blob&amp;x</Key><LastModified>2026-09-01T10:00:00.000Z</LastModified><ETag>"e"</ETag><Size>42</Size></Contents>
<Contents><Key>inst-9f/3d4e</Key><LastModified>2026-09-02T10:00:00Z</LastModified><Size>7</Size></Contents>
</ListBucketResult>`;
    const page = parseListPage(xml);
    expect(page.objects).toEqual([
      { key: "inst-9f/1b2c.blob&x", size: 42, mtimeMs: Date.parse("2026-09-01T10:00:00.000Z") },
      { key: "inst-9f/3d4e", size: 7, mtimeMs: Date.parse("2026-09-02T10:00:00Z") },
    ]);
    expect(page.nextToken).toBe("tok&en");
  });

  test("the last page has no token; a truncated page without one is an error", () => {
    expect(parseListPage("<IsTruncated>false</IsTruncated>").nextToken).toBeNull();
    expect(() => parseListPage("<IsTruncated>true</IsTruncated>")).toThrow();
  });
});
