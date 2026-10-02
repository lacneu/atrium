// A message the reader typed as a GATEWAY COMMAND (`/knowledge once graph`, `/new`, …).
//
// The gateway decides a command from the TEXT, and everything after the command name is
// its arguments. Atrium appended its own blocks to every outgoing message — the media
// delivery instruction, the received-files block — and prepended re-hydrated history, so
// a command reached the gateway with dozens of extra words as arguments (prod 2026-09-27:
// `/knowledge` answered "unknown subcommand: [livraison]"), or, behind history, not as a
// command at all.
//
// WHAT IS A COMMAND is the gateways' own token grammar, not "starts with a slash" — that
// also caught every message opening with a path (`/tmp/x.txt regarde ce fichier`), which
// lost its injections and, carrying a file, was refused outright. Read in the sources:
//  - OpenClaw v2026.9.6: the text is trimmed, the first token is `/<name>` up to
//    whitespace or `:` (src/auto-reply/commands-registry-normalize.ts
//    `normalizeCommandBody`: `/^\/[^\s@:]+/`, and `/cmd: value` is read as `/cmd value`);
//    a handler matches only when the character after the name is whitespace, `:` or the
//    end (src/auto-reply/reply/commands-slash-parse.ts `parseSlashCommandActionArgs`).
//    Every name upstream can register fits `[a-z0-9][a-z0-9_-]*`, case-insensitively:
//    plugin commands `^[a-z][a-z0-9_-]*$` (src/plugins/command-registration.ts
//    `validateCommandName`), skill commands `[a-z0-9_]` (src/skills/discovery/
//    command-name.ts `sanitizeSkillCommandName`), built-ins the same shape
//    (src/auto-reply/commands-registry.shared.ts `defineBuiltinCommand` keys).
//  - Hermes: "a command name has no slashes" — a first word with another `/` is a path
//    (cli.py `_looks_like_slash_command`).
// So: the trimmed text opens with `/`, a name of that shape, then whitespace, `:` or the
// end. `/tmp/x.txt …` (a second `/` in the first token) is an ordinary message. A bare
// `/word` is command-SHAPED either way: the gateway alone knows whether it names one, and
// an unknown one is answered as an ordinary message — sent bare, it loses only Atrium's
// additions. Mirrored in Convex (convex/lib/gatewayCommand.ts); the two must stay in step.

const COMMAND_TOKEN_RE = /^\/[A-Za-z0-9][A-Za-z0-9_-]*(?=$|[\s:])/;

export function isGatewayCommandText(text: unknown): boolean {
  return typeof text === "string" && COMMAND_TOKEN_RE.test(text.trim());
}
