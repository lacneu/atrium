# `deploy/helm` — the Atrium Helm chart

The chart that deploys Atrium on Kubernetes: the Convex backend as a
single-replica StatefulSet with a PVC, the Convex dashboard, the frontend and the
bridge as Deployments, and a bootstrap Job that reconciles the Convex deployment
environment as an ordered `post-install` / `post-upgrade` hook.

**The installation procedure is
[`docs/installation/HELM.md`](../../docs/installation/HELM.md)** — ordered steps,
what to set before installing, and the post-install step the chart deliberately
does not perform. This page is only the map of what is in this directory.

## What is here

| File | What it is |
|---|---|
| `Chart.yaml` | Chart metadata. `version` is the chart's own; `appVersion` is the lockstep frontend + bridge release. |
| `values.yaml` | Every knob, commented. Read it as the reference for what the chart can do. |
| `values-aks.yaml` | A worked example for AKS — an illustration of the provider-portable values, not a second default. |
| `templates/statefulset-convex.yaml` | The stateful component. One replica, one PVC. |
| `templates/deployment-{frontend,bridge,dashboard}.yaml` | The stateless tier. |
| `templates/bootstrap-job.yaml` | The env-reconciliation hook. Runs last. |
| `templates/{secret,services,ingress,serviceaccount}.yaml` | Supporting resources. |
| `templates/tests/` | `helm test <release>` — exercises the frontend Service. |
| `templates/NOTES.txt` | What the operator sees after `helm install`. |

## Portability

`ingressClassName`, `storageClassName`, the secret source and every image are
values, so the chart is not tied to a provider. Secrets come from a Kubernetes
`Secret` — either one you already manage (`secrets.existingSecret`, the
production shape, fed by Key Vault CSI, external-secrets or sealed-secrets) or one
the chart renders from `secrets.values`.

## Working on the chart

```bash
helm lint .
helm template test-render . | less          # what a default install renders
helm template test-render . -f values-aks.yaml
```

Both run offline and need no cluster. Render before you push a template change:
the bootstrap Job's ordering and the secret wiring are the two places where a
mistake produces a deployment that comes up looking healthy and is not
configured.
