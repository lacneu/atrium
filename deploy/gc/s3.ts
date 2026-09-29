// A minimal S3 client for the collector: ListObjectsV2, GetObject (streamed),
// DeleteObject — signed with AWS Signature Version 4, no dependency. The same
// environment the backend reads (self-hosted/advanced/s3_storage.md):
// AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, [AWS_SESSION_TOKEN],
// S3_ENDPOINT_URL (unset = AWS), AWS_S3_FORCE_PATH_STYLE.

import { createHash, createHmac } from "node:crypto";
import type { StoredObject } from "./gc-core.ts";

export type S3Config = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** e.g. https://s3.fr-par.scw.cloud; default AWS regional endpoint. */
  endpoint?: string;
  forcePathStyle: boolean;
  bucket: string;
};

export function s3ConfigFromEnv(env: NodeJS.ProcessEnv, bucket: string): S3Config {
  const region = env.AWS_REGION;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!region || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 mode needs AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
  }
  return {
    region,
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    ...(env.S3_ENDPOINT_URL ? { endpoint: env.S3_ENDPOINT_URL.replace(/\/+$/, "") } : {}),
    forcePathStyle: /^(1|true|yes)$/i.test(env.AWS_S3_FORCE_PATH_STYLE ?? ""),
    bucket,
  };
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC 3986 encoding, as SigV4 wants it (`/` kept in paths only). */
export function uriEncode(s: string, keepSlash: boolean): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? "/" : "%2F");
}

const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
const sha256Hex = (data: string) => createHash("sha256").update(data).digest("hex");

/**
 * SigV4 headers for one request. `path` is already URI-encoded; `query` is the raw
 * parameter map. Returns the headers to send (host excluded — fetch sets it).
 */
export function signV4(args: {
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash?: string;
  region: string;
  service?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now: Date;
}): Record<string, string> {
  const service = args.service ?? "s3";
  const amzDate = args.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = args.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...(args.headers ?? {}),
    host: args.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(args.sessionToken ? { "x-amz-security-token": args.sessionToken } : {}),
  };
  const names = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(args.query)
    .sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(args.query[k]!, false)}`)
    .join("&");
  const canonicalRequest = [
    args.method,
    args.path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${day}/${args.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${args.secretAccessKey}`, day);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (k !== "host") out[k] = v;
  out.authorization =
    `AWS4-HMAC-SHA256 Credential=${args.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m === null ? null : decodeXml(m[1]!);
};

/** One ListObjectsV2 page, parsed. */
export function parseListPage(xml: string): {
  objects: StoredObject[];
  nextToken: string | null;
} {
  const objects: StoredObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1]!;
    const key = tag(block, "Key");
    const size = tag(block, "Size");
    const modified = tag(block, "LastModified");
    if (key === null || size === null || modified === null) {
      throw new Error("ListObjectsV2: an entry lacks Key, Size or LastModified");
    }
    const mtimeMs = Date.parse(modified);
    if (!Number.isFinite(mtimeMs)) throw new Error(`ListObjectsV2: bad LastModified ${modified}`);
    objects.push({ key, size: Number(size), mtimeMs });
  }
  const truncated = tag(xml, "IsTruncated") === "true";
  const nextToken = truncated ? tag(xml, "NextContinuationToken") : null;
  if (truncated && nextToken === null) throw new Error("ListObjectsV2: truncated without a token");
  return { objects, nextToken };
}

export class S3Client {
  private readonly cfg: S3Config;
  constructor(cfg: S3Config) {
    this.cfg = cfg;
  }

  /** The URL and signing path for `key` ("" = the bucket itself). */
  private locate(key: string): { url: string; host: string; path: string } {
    const endpoint = this.cfg.endpoint ?? `https://s3.${this.cfg.region}.amazonaws.com`;
    const base = new URL(endpoint);
    const encodedKey = uriEncode(key, true);
    if (this.cfg.forcePathStyle) {
      const path = `${base.pathname.replace(/\/$/, "")}/${uriEncode(this.cfg.bucket, false)}${key === "" ? "" : `/${encodedKey}`}`;
      return { url: `${base.protocol}//${base.host}${path}`, host: base.host, path };
    }
    const host = `${this.cfg.bucket}.${base.host}`;
    const path = `/${encodedKey}`;
    return { url: `${base.protocol}//${host}${path}`, host, path };
  }

  private async request(
    method: "GET" | "DELETE",
    key: string,
    query: Record<string, string> = {},
  ): Promise<Response> {
    const { url, host, path } = this.locate(key);
    const headers = signV4({
      method,
      host,
      path,
      query,
      region: this.cfg.region,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      ...(this.cfg.sessionToken ? { sessionToken: this.cfg.sessionToken } : {}),
      now: new Date(),
    });
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k]!, false)}`)
      .join("&");
    return fetch(qs ? `${url}?${qs}` : url, {
      method,
      headers,
      signal: AbortSignal.timeout(120_000),
    });
  }

  /** Every object under `prefix`, following continuation tokens. */
  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | null = null;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token !== null) query["continuation-token"] = token;
      const res = await this.request("GET", "", query);
      const body = await res.text();
      if (!res.ok) throw new Error(`ListObjectsV2 ${res.status}: ${body.slice(0, 300)}`);
      const page = parseListPage(body);
      out.push(...page.objects);
      token = page.nextToken;
    } while (token !== null);
    return out;
  }

  /** The object's bytes, streamed. */
  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request("GET", key);
    if (!res.ok || res.body === null) {
      throw new Error(`GetObject ${res.status} for ${key}`);
    }
    return res.body;
  }

  async delete(key: string): Promise<void> {
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) {
      throw new Error(`DeleteObject ${res.status} for ${key}: ${(await res.text()).slice(0, 300)}`);
    }
  }
}
