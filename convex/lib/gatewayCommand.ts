// A message the reader typed as a GATEWAY COMMAND (`/knowledge once graph`, `/new`, …).
//
// The gateway decides a command from the trimmed TEXT, and everything after the command
// name is its arguments. Such a message must leave EXACTLY as typed: Convex adds nothing
// to it (the quoted-reply preamble, a chained step's earlier replies) and neither does the
// bridge. Files are refused with it at the send: on a shared-fs instance a file reaches
// the agent only as path text appended to the message, which a command cannot take.
//
// WHAT IS A COMMAND is the gateways' token grammar — `/`, a name of the shape every
// upstream command has (`[a-z0-9][a-z0-9_-]*`, case-insensitive), then whitespace, `:` or
// the end; a first token holding a second `/` is a path, not a command. The upstream
// citations (OpenClaw v2026.9.6 and Hermes) are in the bridge's copy,
// bridge/src/core/gateway-command.ts; the two must stay in step. "Starts with a slash"
// was too broad: a message opening with a path lost its injections and, with a file, was
// refused.

const COMMAND_TOKEN_RE = /^\/[A-Za-z0-9][A-Za-z0-9_-]*(?=$|[\s:])/;

export function isGatewayCommandText(text: unknown): boolean {
  return typeof text === "string" && COMMAND_TOKEN_RE.test(text.trim());
}

/** The error a send refuses a command carrying files with — matched by the composer. */
export const COMMAND_WITH_ATTACHMENTS = "COMMAND_WITH_ATTACHMENTS";
