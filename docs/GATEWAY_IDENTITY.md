# One gateway profile per user

How an instance stops presenting every conversation as the same operator, and
what changes on the gateway when it does. Read this before switching an instance:
two gateway behaviours change with the mode, and one capability is not yet
compatible with full isolation.

## The two modes

An instance authenticates to its gateway in one of two ways. The setting is per
instance — Settings → Instances → *Modifier l'instance* → **Gateway
authentication** — because upstream the two are mutually exclusive on the gateway
side, so a deployment can hold both.

**Shared token** (default). One operator credential for the whole bridge. The
gateway attributes every session to a single owner profile: its user list holds
one entry, `createdActor` names nobody in particular, and any client holding that
token sees every session on the gateway.

**Trusted proxy.** The bridge states who each connection acts for. The gateway
resolves a durable user profile per person, sessions carry the person who had the
conversation, and its user list names them. Atrium's own isolation between users
is unchanged either way and was never based on this — what the mode adds is the
same boundary on the gateway's *own* surfaces: its Control UI, its CLI, any other
client.

## What the bridge sends

Three request headers on the WebSocket upgrade, and on the HTTP media route:

| Header | Value | Why |
|---|---|---|
| `x-forwarded-user` | the person's stable Atrium key, or `atrium-bridge:<instance>` for connections that serve no single person | absent ⇒ the gateway refuses the connect (`trusted_proxy_user_missing`) |
| `x-forwarded-for` | this bridge's own routable address | the gateway rejects the upgrade unless the forwarded headers name a routable client |
| `x-openclaw-scopes` | a ceiling, on a person's connection only | the only way to hand one connection less authority than the paired device carries |

A conversation's connection acts as its owner and is capped below
`operator.admin`, because on the gateway that scope bypasses the session
boundary entirely. Connections that serve no single person — agent discovery,
transcript recovery after a crash, the administrative session settings — act as
the bridge's own actor and keep the full grant, because reading a session created
by somebody else is exactly what they do.

## Gateway-side prerequisites

The gateway must be configured for the same mode. In its own configuration:

- `gateway.auth.mode: "trusted-proxy"`, with
  `gateway.auth.trustedProxy.userHeader` matching the header above.
- `gateway.trustedProxies` listing **the exact address the bridge reaches it
  from**, not a wide range. A range wide enough to also contain the address the
  bridge announces as its client makes the gateway walk past it looking for a
  further hop, find none, and reject every connection as unattributable.
- A gateway in this mode **cannot hold a shared token at all**. Remove it from the
  configuration and from the process environment.

`gateway.auth.password` remains usable from the gateway's own loopback, which is
how a device is approved once from inside the host.

## Two consequences to check before switching

**The Control UI loses its way in.** A gateway in trusted-proxy mode has no shared
token, so anything that opened its Control UI with one needs another route — an
identity proxy in front of it, or its loopback with a password.

**An agent loses the tools that need `operator.admin`.** A conversation's socket is
capped below that scope, because a client holding it reads every session on the
gateway and an identity carrying it is not an identity. But the gateway derives the
AGENT's tool list from the scopes of the connection that asked for the turn — so the
cap reaches past the operator and takes tools away from the model. Measured on
gateway 2026.9.2: `automations` (create or manage a cron from inside a conversation)
and `computer` disappear. Nothing is refused and nothing is logged; the tool is never
offered, and the model quietly reaches for whatever is left — in the bench, the
`openclaw automations` CLI through a shell.

Managing crons from Atrium's own screens is unaffected: that surface does not run
under a person's socket. What is lost is the agent doing it for you mid-conversation.

Worth knowing before you weigh it: this ceiling only BUYS something once
`gateway.roles` defines a boundary for admin to bypass. Without roles, every profile
already sees every session — so on such a deployment the cap costs those tools and
protects nothing. And roles are exactly what breaks sub-agents (below). The three
configurations are not independent.

Which is why the ceiling is a **setting**, not a constant: Settings → Instances →
*Modifier l'instance* → **Authority of a conversation**, per instance, and only shown
under trusted proxy because a token-mode socket presents no identity to cap.

| Choice | A conversation's socket | The agent's tools |
|---|---|---|
| **Capped** (default) | below `operator.admin` | loses `automations`, `computer` |
| **Full** | the device's whole grant | keeps them |

An instance written before this existed reads as capped, and so does one whose
Convex is too old to send the field: the safe side is the default side, and only the
exact word `full` lifts the ceiling.

Pick **Full** when the gateway defines no roles — there the ceiling bounds nothing
and only costs tools. Keep **Capped** the moment roles exist, or the identity is
decorative: an admin client lists, reads and patches every session whatever
`sessions.others` says.

Stated rather than inferred, deliberately. The bridge cannot discover the posture:
the gateway announces no role policy at connect (its hello carries `maxPayload`,
`maxBufferedBytes`, `tickIntervalMs`, `attachments`, `allowedSessionVisibilities`
and `hasMultipleSessionSharingIdentities`, and nothing about roles — verified in
upstream `connect-hello.ts` at v2026.9.2), and the ceiling is an upgrade HEADER,
chosen before the socket exists. Anything else would be a cached guess about a
security boundary, failing open exactly when an operator has just configured roles.

## One thing that used to break here, and no longer does

Outbound media — a reply handing back a host file through the `MEDIA:<path>`
convention — used to arrive with its text and without its file, reported as nothing
at all. The cause was on our side: the bridge fetches such a file in two steps, and
the second one, the ticketed download, went out naming nobody. The ticket authorizes
the READ; it does not attribute the CLIENT, and a trusted-proxy gateway refuses any
request to that route that names none. The download now carries the same identity as
the probe before it, and goes out bare in token mode exactly as it always did.

It is written here rather than dropped because the shape recurs: anything the bridge
reaches over the gateway's HTTP surface must state an identity on EVERY request, not
only on the one that authenticates.

## Session isolation and sub-agents do not yet coexist

Isolating one person's sessions from another's on the gateway needs
`gateway.roles` with a default role whose `sessions.others` is `"none"` and whose
scopes exclude `operator.admin`. With that boundary in place, and measured on the
live bench:

- a person no longer lists, reads or patches another person's sessions, and
  receives none of their events — the isolation works;
- **but a sub-agent's session is created by the agent, not by the person who asked
  for it**, so the parent is not its creator, receives none of its events, and
  delegated work stops appearing in the conversation.

Per-user identity *on its own* — without the role boundary — is unaffected: the
whole live catalogue passes with it, sub-agents included.

Until upstream changes, an instance chooses one of:

| Choice | Effect |
|---|---|
| Identity, no role boundary | Everything works. The gateway attributes sessions per person; Atrium keeps isolating conversations between users itself. |
| Identity + role boundary + `sandbox: "required"` on the role | Isolation holds and the parent–child link is restored, because a required sandbox makes the whole descendance inherit the person's identity — at the cost of forcing sandbox isolation on every session that role creates. |
| Identity + role boundary alone | Isolation holds; delegated work stops being visible. Not recommended. |

## What the mode turns on

Some capabilities need more than a gateway version. They are listed in the
bridge's own capability table and reported per instance on `/capabilities`, so a
client never has to know how an instance authenticates to work out what it may
offer.

| Capability | Needs | Why |
|---|---|---|
| `gatewayMentions` | `trusted-proxy` | A mention names a gateway user PROFILE. A shared-token gateway has one profile for everybody, so there is nobody to name. |

Naming somebody inside Atrium works on BOTH modes — the person is notified in the
app either way. What the mode adds is forwarding the mention to the gateway's own
inbox, which only matters to somebody who also uses OpenClaw's own interface.

## Seeing which mode a conversation ran under

The mode is not a silent property. Three read-only surfaces state it, so an
attribution question is answered by reading, never by reproducing a turn:

- **`diagnose_chat`** (obs MCP) reports the chat's `authMode` and its
  `participantCount` alongside the assessment — the first place to look when a
  session appears attributed to the bridge rather than to a person.
- **`list_traces`** returns, on every `openclaw.dispatch` event: `authMode`, the
  `gatewayIdentity` the turn ran under (always the chat OWNER's stable key, since
  a conversation has one gateway session), `participantCount`, and
  `fromParticipant` when the turn came from somebody who does not own the chat.
  Metadata only — counts, enums and a slug, never message text.
- **`get_compat`** / `GET /capabilities` carries `authMode` per instance target,
  which is what the live bench records in its attestation so a GO names the mode
  it covers.

## Related settings

The bridge reads `OPENCLAW_AUTH_MODE`, `OPENCLAW_SYSTEM_IDENTITY`,
`BRIDGE_FORWARDED_CLIENT_IP` and `OPENCLAW_TRUSTED_PROXY_USER_HEADER` on its
single-instance legacy path only; a deployed container resolves the mode per
instance from Atrium. See [CONFIGURATION.md](CONFIGURATION.md) for each.
