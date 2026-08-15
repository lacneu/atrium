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

## Enrolling provider credentials

Provisioning creates the instance and its one-time bridge credential; it does
not make provider credentials appear. Before starting the bridge, the same
provisioner identity must enroll the exact provider bundle:

```http
POST /api/v1/instances/credentials
Authorization: Bearer <api-key>
Content-Type: application/json

{"name":"compta","kind":"openclaw","credentials":{"token":"…"}}
```

Hermes uses `{"apiKey":"…"}` instead of `{"token":"…"}`. The request
accepts exactly `name`, `kind`, and `credentials`; the credential object must
also be exact for its provider. Partial bundles and unknown fields are refused.

For OpenClaw, Atrium mints the Ed25519 device identity in its action runtime,
stores its private half only as an AES-256-GCM envelope bound to
`<instanceId>:deviceIdentity`, and returns only the public pairing material:

```json
{
  "ok": true,
  "name": "compta",
  "outcome": "stored",
  "fields": ["deviceIdentity", "token"],
  "deviceIdentity": {"id": "…", "publicKey": "…"}
}
```

The caller never supplies or receives the private key. An identical replay
decrypts the current envelopes only long enough to compare them, returns
`outcome: "unchanged"`, preserves the existing device identity, and writes
nothing. A changed OpenClaw bootstrap token updates that encrypted field only
until the bridge has promoted a paired device token; subsequent provisioner
replays cannot downgrade it. A changed Hermes key updates only its encrypted
field. A provider switch removes stale provider fields in the same optimistic mutation.
Duplicate instance names, kind drift, duplicate secret rows, concurrent changes,
and malformed stored identities fail closed.

**A token of UNKNOWN provenance is refused, not overwritten.** The no-downgrade
rule above reads `instanceSecrets.source`, which is OPTIONAL and which nothing
backfills — so a token row written before this field existed carries no
provenance at all, and "not marked device" does not mean "not promoted". Writing
over it could cut a gateway that works. Such a row therefore yields
`409 credential_provenance_unknown`, and the remedy is a deliberate human act:
clear the credential from the admin interface, then enroll again. An identical
value is still reported `unchanged` — there is nothing to write, so nothing to
refuse. This applies to OpenClaw tokens only: a Hermes `apiKey` has no second
writer, so an absent provenance there carries no ambiguity and updates normally.

The plaintext provider credential exists only in the authenticated action call.
It is never returned, traced, or stored unencrypted. The trace records the
instance, outcome, and field names only.

### OpenClaw device-token promotion and rotation

The enrolled OpenClaw token is an installation bootstrap credential, not the
steady-state bridge credential. On the first successful handshake, OpenClaw
returns a token bound to the bridge's Ed25519 device identity. The bridge sends
that value to `POST /bridge/device-token` with its instance-bound bridge secret.
Atrium verifies the exact stored public identity, encrypts the device token, and
only then lets the client reconnect with it. The first connection returned to a
turn is therefore already authenticated by `device-token`; a failed persistence
or proof reconnect fails closed.

This ordering separates routine shared-secret rotation from live clients:

1. every bridge persists and proves its device token;
2. every other connected OpenClaw device must report `device-token` in the
   sanitized `system-presence` authentication field;
3. the control plane refuses rotation while any live client still reports
   shared `token` or `password` authentication;
4. only after that drain proof may the shared gateway secret be replaced.

No plaintext token is returned by Atrium, logged, traced, or written to a
temporary file. The promotion trace contains only the instance name and the
`stored`, `unchanged`, or `rejected` outcome.

## Removing an instance

The same narrow provisioner identity can remove a gateway after the host
reconciler has stopped its bridge and gateway services:

```http
POST /api/v1/instances/deprovision
Authorization: Bearer <api-key>
Content-Type: application/json

{"name":"compta"}
```

The request accepts exactly `name`; unknown fields are refused. The response is
idempotent:

```json
{
  "ok": true,
  "instance": "compta",
  "outcome": "deleted"
}
```

`outcome` is `deleted` on the first successful call and `absent` on a replay.
Two pre-existing rows sharing the requested name return
`409 instance_name_ambiguous` and neither row is touched.

Deletion revokes the bridge credential and removes the instance's encrypted
credentials, discovery and usage rows, agents, and direct/group grants through
the same cascade used by the authenticated admin UI. Chats remain so their next
dispatch can rebind safely while preserving history. The API call trace records
the service principal, instance name, and outcome, never a credential.

The endpoint does not stop containers. The external control plane must prove
that both bridge and gateway services are absent before calling it; this ordering
prevents a still-running bridge from entering an unauthorized retry loop.

### Failures

| Status | Error                                        | Meaning                                                                                                                                       |
| ------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `name is required`, `gatewayUrl is required` | Missing mandatory field.                                                                                                                      |
| 400    | `invalid_instance_name`                      | Charset rejected at creation.                                                                                                                 |
| 400    | `<field> applies to kind '<k>' only`         | Field/kind mismatch.                                                                                                                          |
| 403    | `missing permission: instances.provision`    | Key lacks the permission.                                                                                                                     |
| 409    | `instance_name_ambiguous`                    | Two rows already share this name. Nothing is written — a guess would configure one row while the bridge routes to the other. Resolve by hand. |
| 409    | `credential_state_changed`                   | A concurrent writer changed credentials. The caller must restart from a fresh read.                                                          |
| 409    | `credential_state_invalid`                   | An existing OpenClaw identity cannot be validated. Repair it explicitly; Atrium does not overwrite it.                                      |
| 409    | `credential_provenance_unknown`              | The stored OpenClaw token predates provenance tracking and may already be a promoted device token. Clear it from the admin interface first. |

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

`POST /api/v1/instances/sync` pokes the bridge and pulls the instance's agents,
returning a specific status. Running it after provisioning turns the sequence into
an end-to-end proof rather than an assumption. **The same key does it** — the
route accepts `instances.provision` as well as `selfheal`.

That second acceptance exists so an installer never has to carry a broader key.
Outside `admin`, `selfheal` lives only in the `agent` role, which also grants
`openclaw.query`, trace and KPI reads, `feedback.respond` and reconcile-chat —
none of which belongs on a machine that installs VPSs. It widens nothing: a
provisioning key can already create and update any instance by name and mint its
bridge secret, so syncing one reaches strictly less than it already commands.

## Attribution

A minted credential records the API-key principal in `bridgeAuth.createdByPrincipal`.
The `auditLog` table cannot hold this path — it requires two `Id<"users">` and an
API key has no user identity — so the trail is the `api.call` trace event, which
carries the principal, the instance name and both outcomes. Never the credential.
