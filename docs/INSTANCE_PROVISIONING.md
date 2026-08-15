# Non-interactive instance provisioning

How an external control plane registers a gateway with Atrium without an
administrator in a browser. The counterpart of the admin "Ajouter une instance"
form, for an installer that runs unattended.

## Scope

This registers an instance and issues its bridge credential. It does **not**
install anything: the host, the gateway process and the bridge process are put in
place by the caller's own installation scripts. What it removes is the manual step
between "the gateway exists" and "Atrium can reach it".

It grants nothing. Discovered agents arrive with `enabled: false` (stamped by
`applyDiscovery`, which never enables), and the availability resolver drops
non-enabled agents from every pool — so a provisioned instance is invisible to
everyone until an administrator acts. That parity with a hand-created instance is
the isolation property, and provisioning must never write an `agents.enabled`,
`userAgents` or `groupAgents` row.

> **Enabling alone exposes an agent. Grant first, then enable.**
> Visibility is default-ALLOW: a user holding no grant at all — neither direct nor
> through a group — falls into the whole pool
> (`convex/agents.ts`: `effective = direct.length > 0 ? direct : allPoolKeys`),
> and the only filter applied afterwards is `enabled`. So the moment an agent is
> enabled, every ungranted user in the deployment sees it, whether or not anyone
> has been assigned to it. Enabling and assigning are **not** two gates; only the
> first one holds. When a gateway exists precisely so a department's data is not
> shared, write its `groupAgents` grants **before** enabling its agents.

## Access

| | |
|---|---|
| Route | `POST /api/v1/instances/provision` |
| Authentication | `Authorization: Bearer <api-key>` |
| Permission | `instances.provision` |
| Built-in role | `provisioner` — this permission and nothing else |

The `provisioner` role cannot read traces, KPIs, anomalies or conversations. A key
holding this permission can mint a bridge credential, which unlocks that
instance's encrypted gateway credentials, so the permission is excluded from those
an administrator can delegate to a user.

An existing deployment gains the role automatically: `seedBuiltinRoles` inserts
any built-in role missing from the `roles` table on the next seed pass (triggered
by listing roles or minting a key). No migration is required.

## Request

```json
{
  "name": "compta",
  "gatewayUrl": "ws://compta.internal:8080",
  "kind": "openclaw",
  "bridgeUrl": "http://compta.internal:8787",
  "displayName": "Comptabilité"
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | The routing key. Immutable once created; `agents`, `userAgents`, `chats` and `instanceDiscovery` all reference it. Charset `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, checked at creation. |
| `gatewayUrl` | yes | Where the bridge reaches the gateway. |
| `kind` | no | `openclaw` (default) or `hermes`. |
| `bridgeUrl` | no | Per-instance bridge endpoint. Unset falls back to the deployment's `BRIDGE_URL`. |
| `displayName` | no | Shown in the UI. |
| `gatewayVersion`, `gatewayHttpUrl` | no | `openclaw` only — refused for `hermes`. |
| `transport` | no | `hermes` only (`ws` or `rest`) — refused for `openclaw`. |
| `rotateBridgeSecret` | no | See *Replacing a credential*. |

A field that does not apply to the declared `kind` is **refused**, not ignored: a
caller believing a setting took effect while nothing reads it is a defect that
survives for months.

**Omitting a field leaves it alone; sending `null` clears it.** A partial
declaration therefore never wipes a value an administrator set in the UI, and a
control plane can still unset one deliberately. Settings the admin UI owns
(`config`, `capabilities`, `streamTransport`, `defaultAgentId`) are never touched.

## Response

```json
{
  "ok": true,
  "instance": "compta",
  "outcome": "created",
  "bridgeSecret": "minted",
  "secret": "oc_…",
  "prefix": "oc_…",
  "lastFour": "…"
}
```

| Field | Values |
|---|---|
| `outcome` | `created` \| `updated` \| `unchanged` |
| `bridgeSecret` | `minted` \| `rotated` \| `existing` |
| `secret` | Present **only** when this call minted or rotated. |

`secret` is the bridge credential, returned exactly once — only its hash is
stored, so it is never recoverable afterwards. It is the single value the
installer must place on the new host: the bridge presents it and reads its whole
gateway configuration back from Atrium
(`bridgeAuth.resolveBridgeInstanceBySecretHash`).

Everything except `secret` is safe to log verbatim, which is what makes the
response usable as a qualification record.

### Failures

| Status | Error | Meaning |
|---|---|---|
| 400 | `name is required`, `gatewayUrl is required` | Missing mandatory field. |
| 400 | `invalid_instance_name` | Charset rejected at creation. |
| 400 | `<field> applies to kind '<k>' only` | Field/kind mismatch. |
| 403 | `missing permission: instances.provision` | Key lacks the permission. |
| 409 | `instance_name_ambiguous` | Two rows already share this name. Nothing is written — a guess would configure one row while the bridge routes to the other. Resolve by hand. |

## Running it twice

A second run with the same payload reports `outcome: "unchanged"` and
`bridgeSecret: "existing"`, and writes nothing — no patch, no new credential. A
qualification pass that requires no persistent change on the second run is
satisfied without special handling.

The instance is resolved **by name** and patched, never blind-inserted: a retried
creation cannot fork the routing key.

### Replacing a credential

A replay deliberately does not return the credential — the installed bridge
already holds it, and only the hash is stored. For the one case a replay cannot
serve (the installer lost the plaintext before writing it to the host), send
`"rotateBridgeSecret": true`. This issues a new credential and **invalidates the
old one**, disconnecting the running bridge until the new value is deployed. It is
explicit precisely so a plain replay can never reach it.

## Verifying

`POST /api/v1/instances/sync` (permission `selfheal`) pokes the bridge and pulls
the instance's agents, returning a specific status. Running it after provisioning
turns the sequence into an end-to-end proof rather than an assumption.

## Attribution

A minted credential records the API-key principal in `bridgeAuth.createdByPrincipal`.
The `auditLog` table cannot hold this path — it requires two `Id<"users">` and an
API key has no user identity — so the trail is the `api.call` trace event, which
carries the principal, the instance name and both outcomes. Never the credential.
