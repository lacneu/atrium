# Installing Atrium, a gateway and an identity provider together

What an installer has to set, on each of the three sides, for a deployment where
people sign in through their organisation's own single sign-on and the gateway
attributes each conversation to the person who had it.

Everything here is measured against **OpenClaw 2026.9.2** and Atrium 0.84.x — the
release that adds the per-instance naming this procedure relies on. Where
something is a decision rather than a value, it says so; where something is not yet
solved, it says that too — the last section is as load-bearing as the first.

This is the ADVANCED arrangement. A deployment that wants neither SSO nor per-user
gateway identity sets none of it and is unaffected: providers are chosen by which
credentials exist, and an instance's authentication mode defaults to a shared token.

---

## The three pieces, and what each one is responsible for

| Piece | Answers | To whom |
|---|---|---|
| Identity provider (Authelia, Keycloak, Authentik, Zitadel) | who is this person | Atrium, over OIDC |
| Atrium bridge | who is this conversation for | the gateway, in a header |
| Gateway | what may that person's session see | itself |

Two of those are separate doors into the gateway and they do not chain: a browser
reaching the gateway's own Control UI goes through the proxy; the bridge goes
straight to the gateway's operator port and states an identity itself. Both must be
listed as trusted sources.

**The security property, stated plainly.** The gateway does not verify the human. It
verifies that a request came from an address it was told to trust, then believes the
name that request carries. Everything rests on two things being true at once: that
Atrium authenticated the person, and that nothing else can reach the gateway from the
bridge's address. `gateway.trustedProxies` therefore names single hosts, never a
range: `/32` for an IPv4 address, `/128` for an IPv6 one. `/32` on an IPv6 address
is not a host — it is 2^96 of them.

---

## 1 — Identity provider

### 1.1 An OIDC client for Atrium

| Setting | Value |
|---|---|
| Redirect URI | `<VITE_CONVEX_SITE_URL>/api/auth/callback/authelia` |
| Scopes | `openid profile email` |
| Client type | confidential (a secret is issued) |

Two mistakes cost an afternoon each:

- The redirect URI lives on the **HTTP-actions** origin, not the API one. They are
  different hosts on a self-hosted deployment; using the API origin yields
  `redirect_uri_mismatch`.
- The `email` claim must be **emitted and marked verified**. Atrium refuses a
  sign-in whose issuer does not state `email_verified`, because that claim is what
  decides which existing account a sign-in reaches. Atrium reads both claims from
  the **UserInfo** endpoint, so a minimal ID token is fine.

The provider id in that URI is `authelia` whatever the product actually is — it is
the id Atrium registers, not a brand name. Keycloak, Authentik and Zitadel use the
same entry.

### 1.2 Forward-auth in front of the gateway

Only needed for people who open the gateway's own Control UI. Configure the proxy to
authenticate them and to inject the identity header the gateway is configured to
read — and to **overwrite or strip** any such header a client supplied.

---

## 2 — Gateway

```json5
{
  gateway: {
    bind: "lan",
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-forwarded-host"],
      },
    },
    // ONE HOST per entry, never a range. Substitute the addresses and KEEP the
    // suffix: /32 for IPv4, /128 for IPv6 (on an IPv6 address /32 is 2^96 hosts).
    trustedProxies: ["203.0.113.10/32", "203.0.113.11/32"],
    // IPv6 form: ["2001:db8::a/128", "2001:db8::b/128"]
    controlUi: { allowedOrigins: ["https://<the Control UI host>"] },
  },
}
```

Then, in a **separate** write:

```json5
{ gateway: { auth: { password: "<a strong local password>" } } }
```

### What each line is for, and what it costs to get wrong

- **`mode: "trusted-proxy"` erases the shared token, and the gateway refuses to
  start if one is still configured** — including in the process environment. Remove
  `OPENCLAW_GATEWAY_TOKEN` from the unit file or compose file, not only from the
  config.
- **`userHeader` is ONE name for everybody.** The proxy and the bridge must use the
  same one. Atrium sends `x-forwarded-user` by default and can be told otherwise
  with `OPENCLAW_TRUSTED_PROXY_USER_HEADER` — one value for the whole bridge, so
  pick the name once, here.
- **`requiredHeaders` is enforced on the HTTP surface, not on the WebSocket
  upgrade.** Measured: a client missing them connects and runs turns normally, and
  the media route answers 401 — so it loses every outbound file, silently. Atrium
  sends `x-forwarded-proto` and `x-forwarded-host` on every trusted-proxy
  connection, so this list is safe to require.
- **`trustedProxies` must be narrow.** A range wide enough to also contain the
  address a client announces as its own makes the gateway walk past it looking for a
  further hop, find none, and reject every connection as unattributable. Both
  entries name exactly one host: `/32` for IPv4, `/128` for IPv6 — on an IPv6
  address `/32` is a 2^96-address network, which is the opposite of what this line
  is for, and some parsers reject it outright.
- **The password is a SEPARATE write.** Any command that sets `auth.mode` prunes
  `auth.token` *and* `auth.password` in the same operation, so a password set
  alongside the mode is erased by the same write. It is not a network door — it is
  accepted only from the gateway's own loopback — and it is what lets an operator
  administer the host without a token.

### Do not configure `gateway.roles` yet

It is what makes one person's sessions invisible to another. It also, today,
**breaks sub-agents** — a sub-agent's session is created by the agent, not by the
person, so the person receives none of its events and delegated work stops appearing
in the conversation — and it stops identity-authenticated connections from receiving
reusable device tokens. Measured on the live bench. Without roles, per-user identity
still gives every person their own gateway profile and their own attribution.

---

## 3 — Atrium

### 3.1 Deployment environment

| Variable | Value |
|---|---|
| `AUTH_AUTHELIA_ISSUER` | the issuer URL |
| `AUTH_AUTHELIA_ID` | the OIDC client id |
| `AUTH_AUTHELIA_SECRET` | the OIDC client secret |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | the domains allowed to sign in |

All three of the first group are required together: with any one missing the
provider disables itself and names the missing variable in the deployment log. They
are pushed to Convex by the deployment's own env path — the compose scripts and the
Helm bootstrap job already carry them.

`AUTH_ALLOWED_EMAIL_DOMAINS` defaults to a placeholder that matches nobody real.
Set it.

Google and Microsoft can stay configured alongside; providers are a list.

### 3.2 The instance

| Field | Value | Why |
|---|---|---|
| `authMode` | `trusted-proxy` | the bridge names the person behind each connection |
| `gatewayUrl` | the gateway's operator URL | its scheme and host become the forwarded headers |
| `personScopes` | `full` while no roles exist, `capped` once they do | see below |
| `identitySource` | `email` when the proxy in front of the gateway injects the address — set it BEFORE conversations accumulate | one person, one gateway profile |
| `systemIdentity` | leave unset | derives `atrium-bridge:<instance>` |

**`personScopes` is a real decision, not a default to accept.** `capped` keeps a
conversation's socket below the gateway's admin scope. But the gateway builds the
AGENT's tool list from that socket's scopes, so the ceiling also removes
admin-scoped tools from the model — creating a cron from inside a conversation stops
working, and the agent quietly does something else instead of saying so. And the
ceiling only bounds anything once `gateway.roles` exists: without roles every profile
already sees every session, so it costs those tools and protects nothing.

**`identitySource` is what makes the two views agree.** The gateway keys a profile
by the exact string in `x-forwarded-user`. Your proxy puts the person's address
there when they open the gateway's Control UI; Atrium puts its own stable key there
when they write in a conversation. Left at the default, that is the same human as
two profiles with two session lists — silently, and per profile is exactly how
`gateway.roles` draws its boundary. Set `identitySource: "email"` on an instance
whose gateway sits behind such a proxy, and both doors name them the same way.

Prerequisites, both already true if you followed section 1: the address must be a
claim the provider emits and marks verified, and the proxy must inject THAT address
— not a username — into the same header the gateway reads. Check the two match
before switching; a mismatch is not an error anywhere, it is a second profile.

Conversations do not move when you set it: the gateway session key is built from
Atrium's key either way. A profile with no address falls back to the key rather
than naming nobody.

### 3.3 Order of operations

1. Deploy Atrium **0.84.0 or later**. Earlier releases have no per-instance
   naming: they name every person by Atrium's own key, silently, so the two
   profiles this procedure exists to merge stay two.
2. If the deployment already had accounts, run the one-time backfill **before**
   enabling the new provider — repeatedly, passing back the cursor it returns, until
   it answers `isDone: true`:

   ```bash
   npx convex run admin:backfillProfileEmailLowerCli '{}'
   ```

   The `Cli` suffix matters: `npx convex run` establishes no signed-in user, so the
   admin-gated function of the same name answers `Unauthorized: authentication
   required` from a terminal.

   It gives every existing profile the normalized address the duplicate-account
   guard compares. Skipping it means the first person arriving through the new door
   is neither recognized nor refused: they get a second account beside their first,
   and nothing says so.
3. Set the `AUTH_AUTHELIA_*` variables.
4. Switch the instance to trusted proxy.

---

## What this arrangement does NOT solve yet

**Setting `identitySource` late does not converge the conversations you already
have.** A gateway stamps a session's creator when it creates the session and keeps
that stamp for the session's life, so conversations that predate the switch stay
attributed to the profile they were created under. New ones use the new name. This
matters once `gateway.roles` exists, because the boundary is per profile: those older
conversations become invisible to the person who had them until somebody
re-attributes them (upstream `sessions.assignOwner`, which Atrium does not call
today). Decide the naming while the deployment is young.

**The two views agree only if the proxy injects the address.** `identitySource:
"email"` makes Atrium name people the way an address-injecting proxy does, which is
the common case. A proxy that injects a USERNAME instead still ends up with two
profiles per person: Atrium has no setting that names people by a directory
username, because it holds no such field. If that is your deployment, configure the
proxy to inject the email.

**Two functions are unavailable under per-user identity**, both understood, neither
fatal:

- Forwarding a mention to the gateway's own inbox. The gateway accepts human
  mentions only from a signed-in Control UI chat, which a bridge is not under any
  configuration — so Atrium does not attempt it. Naming somebody inside Atrium is
  unaffected: they are notified and the name is highlighted either way.
- The agent's admin-scoped tools under `personScopes: "capped"`, which is what the
  setting exists to let an operator weigh.
