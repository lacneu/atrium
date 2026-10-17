// THE IP LITERAL POLICY a remote `MEDIA:` reference is judged by (codex review 3, the
// reduced ports re-examined): port AS IS of the functions src/media/parse-output.ts:2-11
// imports from packages/net-policy/src/ip.ts at v2026.9.33, on the library and version the
// upstream package pins (ipaddr.js 2.5.0). The verdict decides whether a `MEDIA:` line is a
// file block or stays text — what the row shows — so the ranges are the library's, never a
// hand-written subset. Atrium never fetches a remote reference either way.

import ipaddr from "ipaddr.js";

type ParsedIpAddress = ipaddr.IPv4 | ipaddr.IPv6;
type Ipv4Range = ReturnType<ipaddr.IPv4["range"]>;
type Ipv6Range = ReturnType<ipaddr.IPv6["range"]>;
/** ip.ts:13. */
type BlockedIpv6Range = Ipv6Range | "benchmarking" | "discard" | "orchid2";
type Ipv6Hextets = readonly [number, number, number, number, number, number, number, number];

/** string-coerce.ts `normalizeOptionalString`. */
function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** ip.ts:18. */
function expectIpv6Hextets(parts: readonly number[]): Ipv6Hextets {
  const [a, b, c, d, e, f, g, h] = parts;
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined ||
    g === undefined ||
    h === undefined
  ) {
    throw new Error("expected IPv6 address to expose 8 hextets");
  }
  return [a, b, c, d, e, f, g, h];
}

/** ip.ts:35. */
const BLOCKED_IPV4_SPECIAL_USE_RANGES = new Set<Ipv4Range>([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "carrierGradeNat",
  "private",
  "reserved",
]);

/** ip.ts:53. */
const BLOCKED_IPV6_SPECIAL_USE_RANGES = new Set<BlockedIpv6Range>([
  "unspecified",
  "loopback",
  "linkLocal",
  "uniqueLocal",
  "multicast",
  "reserved",
  "benchmarking",
  "discard",
  "orchid2",
]);
/** ip.ts:64-65. */
const RFC2544_BENCHMARK_PREFIX: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse("198.18.0.0"), 15];
const CLOUD_METADATA_IP_ADDRESSES = new Set(["100.100.100.200", "fd00:ec2::254"]);

/** ip.ts:89. */
function stripIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}

/** ip.ts:96. */
function isNumericIpv4LiteralPart(value: string): boolean {
  return /^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}

/** ip.ts:101. */
export function isIpv4Address(address: ParsedIpAddress): address is ipaddr.IPv4 {
  return address.kind() === "ipv4";
}

/** ip.ts:106. */
function isIpv6Address(address: ParsedIpAddress): address is ipaddr.IPv6 {
  return address.kind() === "ipv6";
}

/** ip.ts:110. */
function normalizeIpv4MappedAddress(address: ParsedIpAddress): ParsedIpAddress {
  return isIpv6Address(address) && address.isIPv4MappedAddress() ? address.toIPv4Address() : address;
}

/** ip.ts:116. */
function normalizeIpParseInput(raw: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(raw);
  if (!trimmed) return undefined;
  return stripIpv6Brackets(trimmed);
}

/** ip.ts:125. */
export function parseCanonicalIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) return undefined;
  const isCanonical = ipaddr.IPv4.isValidFourPartDecimal(normalized) || ipaddr.IPv6.isValid(normalized);
  return isCanonical ? ipaddr.parse(normalized) : undefined;
}

/** ip.ts:136. */
export function parseLooseIpAddress(raw: string | undefined): ParsedIpAddress | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized) return undefined;
  return ipaddr.isValid(normalized) ? ipaddr.parse(normalized) : undefined;
}

/** ip.ts:155. */
export function isCanonicalDottedDecimalIPv4(raw: string | undefined): boolean {
  const normalized = normalizeIpParseInput(raw);
  return normalized !== undefined && ipaddr.IPv4.isValidFourPartDecimal(normalized);
}

/** ip.ts:161. */
export function isLegacyIpv4Literal(raw: string | undefined): boolean {
  const normalized = normalizeIpParseInput(raw);
  if (!normalized || normalized.includes(":")) return false;
  if (isCanonicalDottedDecimalIPv4(normalized)) return false;
  const parts = normalized.split(".");
  return parts.length <= 4 && parts.every(isNumericIpv4LiteralPart);
}

/** ip.ts:213. */
function isCloudMetadataIpAddress(raw: string | undefined): boolean {
  const parsed = parseLooseIpAddress(raw);
  if (!parsed) return false;
  const normalized = normalizeIpv4MappedAddress(parsed);
  if (isIpv6Address(normalized)) {
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(normalized);
    if (embeddedIpv4 && CLOUD_METADATA_IP_ADDRESSES.has(embeddedIpv4.toString())) return true;
  }
  return CLOUD_METADATA_IP_ADDRESSES.has(normalized.toString());
}

/** ip.ts:252 (no per-call exemption: parse-output.ts passes none). */
export function isBlockedSpecialUseIpv6Address(address: ipaddr.IPv6): boolean {
  const range = address.range() as BlockedIpv6Range;
  if (isRfc8215Nat64LocalUseAddress(address)) return true;
  if (isCloudMetadataIpAddress(address.toString())) return true;
  if (BLOCKED_IPV6_SPECIAL_USE_RANGES.has(range)) return true;
  const [firstPart] = expectIpv6Hextets(address.parts);
  return (firstPart & 0xffc0) === 0xfec0;
}

/** ip.ts:295 (no per-call exemption). */
export function isBlockedSpecialUseIpv4Address(address: ipaddr.IPv4): boolean {
  const inRfc2544BenchmarkRange = address.match(RFC2544_BENCHMARK_PREFIX);
  return BLOCKED_IPV4_SPECIAL_USE_RANGES.has(address.range()) || inRfc2544BenchmarkRange;
}

/** ip.ts:306. */
function decodeIpv4FromHextets(high: number, low: number): ipaddr.IPv4 {
  const octets: [number, number, number, number] = [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];
  return ipaddr.IPv4.parse(octets.join("."));
}

/** ip.ts:316. */
function isRfc8215Nat64LocalUsePrefix(parts: Ipv6Hextets): boolean {
  return parts[0] === 0x0064 && parts[1] === 0xff9b && parts[2] === 0x0001;
}

/** ip.ts:320. */
function isRfc8215Nat64LocalUseAddress(address: ipaddr.IPv6): boolean {
  return isRfc8215Nat64LocalUsePrefix(expectIpv6Hextets(address.parts));
}

/** ip.ts:325. */
export function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  const parts = expectIpv6Hextets(address.parts);
  switch (address.range()) {
    case "ipv4Mapped":
      return address.toIPv4Address();
    case "rfc6145":
      return decodeIpv4FromHextets(parts[6], parts[7]);
    case "rfc6052":
      if (isRfc8215Nat64LocalUseAddress(address)) return undefined;
      return decodeIpv4FromHextets(parts[6], parts[7]);
    case "6to4":
      return decodeIpv4FromHextets(parts[1], parts[2]);
    case "teredo":
      return decodeIpv4FromHextets(parts[6] ^ 0xffff, parts[7] ^ 0xffff);
    default:
      break;
  }
  const isIpv4Compatible =
    parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0;
  const isIsatap = (parts[4] & 0xfcff) === 0 && parts[5] === 0x5efe;
  if (isIpv4Compatible || isIsatap) return decodeIpv4FromHextets(parts[6], parts[7]);
  return undefined;
}
