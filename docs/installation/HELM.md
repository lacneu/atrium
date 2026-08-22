# Installing Atrium on Kubernetes — the Helm chart

The chart in [`deploy/helm/`](../../deploy/helm/) deploys the same four
components as the Compose path, shaped for a cluster. It is provider-portable:
ingress class, storage class, secret source and every image are values. An AKS
example sits beside the defaults as `values-aks.yaml`.

For *what each variable means*, see [../CONFIGURATION.md](../CONFIGURATION.md).
This page is the ordered procedure; that one is the reference.

## What the chart creates

| Resource | Component | Note |
|---|---|---|
| **StatefulSet**, 1 replica + PVC | Convex backend | **Stateful and not horizontally scalable.** Its SQLite data lives on the PVC. This is the stack's main constraint. |
| Deployment | Convex dashboard | **ClusterIP only.** Admin-key-gated and never exposed; reach it by port-forward. |
| Deployment + Service (+ Ingress) | Frontend | The only component with a public route. |
| Deployment | Bridge | ClusterIP. Connects out to **your external gateway** — the chart deploys no gateway. |
| Job (`post-install` / `post-upgrade`) | bootstrap-env | Reconciles the **Convex deployment environment**. Ordered last. |

---

## Step 0 — Preconditions

- A cluster, `kubectl` and `helm` working against it.
- An **IngressClass** and a **StorageClass** you can name, or a router of your own
  wired to the frontend Service.
- The images pullable from the cluster. CI publishes to GHCR **private by
  default**: make the packages public or provide `imagePullSecrets`.
- An agent gateway the bridge can reach from inside the cluster.
- **Egress to the npm registry from the bootstrap Job.** It runs the Convex CLI
  through `npx`. In a cluster with restrictive network policies, either allow that
  egress or pin `bootstrap.convexCliVersion` and point it at a registry mirror —
  otherwise the Job fails and the deployment comes up unconfigured.

---

## Step 1 — Set `CONVEX_INSTANCE_SECRET` before anything else

```bash
openssl rand -hex 32
```

**Leaving it empty produces a deployment that looks healthy and is not.** The
backend self-generates a random secret on first boot, while the bootstrap Job
derives the admin key from the value it was given — so the two disagree and every
`convex env set` fails with `401`. Nothing else reports the mismatch.

This secret **mints the admin key**. Back it up with the same care as a database
password; it cannot be recovered from the cluster.

---

## Step 2 — Choose where the secrets come from

Two sources, and the chart renders a `Secret` only in the second case.

```yaml
secrets:
  existingSecret: "atrium-secrets"   # the chart renders nothing and reads this
```

Point at a pre-existing `Secret` fed by your own store — Azure Key Vault CSI,
external-secrets, sealed-secrets. Its keys must match the names under
`secrets.values`. This is the production shape.

Otherwise fill `secrets.values` and the chart renders the `Secret` for you.
Convenient for a first cluster install; it puts plaintext in your values file.

`BRIDGE_INSTANCE_SECRETS` is **required** — comma-separated, one per Convex
instance this bridge serves, each minted in that instance's Credentials dialog.
Without one the bridge starts and has nothing to serve. The gateway URL and its
credentials are not here: they live encrypted in Convex.

---

## Step 3 — Set the three public origins

They are values, not derived, and a wrong one fails the same way a swapped
environment scope does on Compose — silently.

```yaml
convex:
  cloudOrigin: "https://convex.example.com"       # queries and mutations
  siteOrigin:  "https://convex-site.example.com"  # HTTP actions, OAuth callbacks
app:
  siteUrl:     "https://webchat.example.com"      # the frontend origin
```

The frontend's `CONVEX_URL` and the backend's `CONVEX_CLOUD_ORIGIN` are the same
value: `convex.cloudOrigin`.

---

## Step 4 — Decide the public route

`ingress.enabled` is **`false`** by default, and the Ingress it creates covers the
**frontend only**.

```yaml
ingress:
  enabled: true
  className: nginx          # or traefik, AKS app routing, …
  hosts:
    - host: webchat.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - hosts: [webchat.example.com]
      secretName: webchat-tls
```

Leave it disabled to wire your own router to the frontend Service. Either way the
Convex **cloud** and **site** origins need public HTTPS routing of their own —
they are not part of this Ingress.

The dashboard is never routed. That is deliberate.

---

## Step 5 — Install

```bash
helm install <release> deploy/helm -n <namespace> --create-namespace -f my-values.yaml
```

The bootstrap Job runs last (`hookWeight: 5`). It derives the admin key locally,
waits for the backend `/version` to answer within
`bootstrap.readinessTimeoutSeconds`, then idempotently sets each deployment
variable — **`AUTH_ALLOWED_EMAIL_DOMAINS` first**, because it is the sign-in gate.

Watch it, because a silent failure here is the difference between configured and
merely running:

```bash
kubectl -n <namespace> logs job/<release>-bootstrap-env -f
```

---

## Step 6 — Deploy the Convex functions yourself

**The Job does not do this.** It sets the deployment environment only; the
in-cluster Job has no access to this repository's `convex/` source. A deployment
that stops at step 5 has an empty backend.

```bash
kubectl port-forward svc/<release>-convex-backend 3210:3210 &
ADMIN_KEY=$(kubectl exec <release>-convex-backend-0 -- ./generate_admin_key.sh | tr -d '\r' | tail -n1)
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 \
CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY" \
  npx convex deploy          # from the repo root
```

Re-run it on **every release**, from your checkout or from CI. The code and the
environment are separate deployments: pushing variables does not ship functions.

---

## Step 7 — First sign-in, and the gateway

Open the frontend origin. **The first sign-in from an address in
`AUTH_ALLOWED_EMAIL_DOMAINS` becomes the administrator** — confirm the value is
right *before* anyone signs in, because the door closes on the first person
through it.

Then register your gateway as an instance and mint its credential secret, exactly
as on the Compose path — see
[../INSTANCE_PROVISIONING.md](../INSTANCE_PROVISIONING.md) for the unattended
form.

---

## Verifying the install, rather than assuming it

```bash
helm test <release> -n <namespace>
```

The chart ships a test that exercises the frontend Service. Beyond it, four checks
each prove one thing:

| Check | Proves |
|---|---|
| `kubectl get statefulset,deploy,job -n <ns>` | Every component scheduled, and the Job completed rather than backed off |
| `kubectl logs job/<release>-bootstrap-env` | The environment was reconciled, with no `401` |
| `kubectl port-forward svc/<release>-convex-dashboard <port>:<port>` | The backend answers and holds your data |
| Sign in, then send one turn | The bridge reaches your gateway and the round trip works |

A Job that completed is not proof the functions are deployed — that is step 6, and
nothing in the cluster reports its absence.

---

## Lifecycle — what is stateful and what is not

The Convex PVC holds the database. Redeploy the stateless tier freely:
`helm upgrade` recreates the frontend and bridge Deployments without touching it.

**Never delete the PVC** unless you intend to wipe the database, and take a real
export first:

```bash
npx convex export --include-file-storage --path <snapshot>.zip
```

A volume snapshot is not a substitute — it captures the file, not a consistent
application-level export, and it cannot be restored into a different deployment.

Upgrades re-run the bootstrap Job (`post-upgrade`), so environment changes in your
values reach the deployment on `helm upgrade`. Function changes still need step 6.
