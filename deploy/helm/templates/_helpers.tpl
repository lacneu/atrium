{{/*
Expand the name of the chart.
*/}}
{{- define "atrium.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Truncated at 63 chars (k8s DNS name limit) so the
per-component suffixed names (e.g. "-convex-backend") still fit comfortably.
*/}}
{{- define "atrium.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "atrium.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every object.
*/}}
{{- define "atrium.labels" -}}
helm.sh/chart: {{ include "atrium.chart" . }}
{{ include "atrium.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
Base selector labels (no component).
*/}}
{{- define "atrium.selectorLabels" -}}
app.kubernetes.io/name: {{ include "atrium.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Per-component object name. Usage: {{ include "atrium.componentName" (dict "ctx" . "component" "convex-backend") }}
*/}}
{{- define "atrium.componentName" -}}
{{- printf "%s-%s" (include "atrium.fullname" .ctx) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
The name of the Secret the workloads read from: either an externally-managed
existing Secret, or the one this chart renders.
*/}}
{{- define "atrium.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "atrium.componentName" (dict "ctx" . "component" "secrets") -}}
{{- end -}}
{{- end -}}

{{/*
In-cluster service DNS for the Convex backend Service. Derived from the release
name — NEVER a value. The bridge, dashboard and bootstrap Job reach Convex here.
*/}}
{{- define "atrium.convexBackendService" -}}
{{- include "atrium.componentName" (dict "ctx" . "component" "convex-backend") -}}
{{- end -}}

{{/*
Convex cloud (admin / env-set / readiness) in-cluster URL — port 3210.
Mirrors bootstrap-env.sh's CONVEX_SELF_HOSTED_URL (uses the cloud port).
*/}}
{{- define "atrium.convexCloudInClusterUrl" -}}
{{- printf "http://%s:%d" (include "atrium.convexBackendService" .) (int .Values.convexBackend.cloudPort) -}}
{{- end -}}

{{/*
Convex site (HTTP actions / .site) in-cluster URL — port 3211. The bridge
posts ingest events here (CONVEX_HTTP_ACTIONS_URL).
*/}}
{{- define "atrium.convexSiteInClusterUrl" -}}
{{- printf "http://%s:%d" (include "atrium.convexBackendService" .) (int .Values.convexBackend.sitePort) -}}
{{- end -}}

{{/*
In-cluster bridge URL (Convex functions call this; pushed into Convex env by
the bootstrap Job as BRIDGE_URL). Derived from the release name.
*/}}
{{- define "atrium.bridgeInClusterUrl" -}}
{{- printf "http://%s:%d" (include "atrium.componentName" (dict "ctx" . "component" "bridge")) (int .Values.bridge.port) -}}
{{- end -}}

{{/*
Image reference helper. Usage:
  {{ include "atrium.image" (dict "repository" .Values.x.image "tag" .Values.x.tag "defaultTag" .Chart.AppVersion) }}
*/}}
{{- define "atrium.image" -}}
{{- $tag := .tag | default .defaultTag -}}
{{- printf "%s:%s" .repository $tag -}}
{{- end -}}

{{/*
ServiceAccount name used by the bootstrap Job (and any workload that opts in).
*/}}
{{- define "atrium.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "atrium.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
