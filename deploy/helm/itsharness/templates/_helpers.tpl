{{/*
itsharness Helm chart — shared template helpers
*/}}

{{/*
Expand the name of the chart.
*/}}
{{- define "itsharness.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "itsharness.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart label.
*/}}
{{- define "itsharness.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels applied to every resource.
*/}}
{{- define "itsharness.labels" -}}
helm.sh/chart: {{ include "itsharness.chart" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Values.global.commonLabels }}
{{ toYaml .Values.global.commonLabels }}
{{- end }}
{{- end }}

{{/*
Selector labels for a named component.
Usage: {{ include "itsharness.selectorLabels" (dict "root" . "component" "adapter") }}
*/}}
{{- define "itsharness.selectorLabels" -}}
app.kubernetes.io/name: {{ include "itsharness.name" .root }}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end }}

{{/*
Image tag — falls back to Chart.AppVersion when .tag is empty.
Usage: {{ include "itsharness.imageTag" (dict "image" .Values.adapter.image "chart" .Chart) }}
*/}}
{{- define "itsharness.imageTag" -}}
{{- default .chart.AppVersion .image.tag }}
{{- end }}

{{/*
Name of the shared secrets Secret.
When secrets.existingSecret is set we use that; otherwise we use the chart-managed secret.
*/}}
{{- define "itsharness.secretName" -}}
{{- if .Values.secrets.existingSecret }}
{{- .Values.secrets.existingSecret }}
{{- else }}
{{- printf "%s-secrets" (include "itsharness.fullname" .) }}
{{- end }}
{{- end }}

{{/*
ServiceAccount name.
*/}}
{{- define "itsharness.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "itsharness.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Postgres host — returns the in-cluster service name when postgres.enabled=true,
otherwise externalPostgres.host.
*/}}
{{- define "itsharness.postgresHost" -}}
{{- if .Values.postgres.enabled }}
{{- printf "%s-postgresql" .Release.Name }}
{{- else }}
{{- .Values.externalPostgres.host }}
{{- end }}
{{- end }}

{{/*
Postgres port.
*/}}
{{- define "itsharness.postgresPort" -}}
{{- if .Values.postgres.enabled }}5432
{{- else }}{{ .Values.externalPostgres.port }}
{{- end }}
{{- end }}

{{/*
Redis host — returns the in-cluster service name when redis.enabled=true.
*/}}
{{- define "itsharness.redisHost" -}}
{{- if .Values.redis.enabled }}
{{- printf "%s-redis-master" .Release.Name }}
{{- else }}
{{- .Values.externalRedis.host }}
{{- end }}
{{- end }}

{{/*
Redis database index.
*/}}
{{- define "itsharness.redisDb" -}}
{{- if .Values.redis.enabled }}1
{{- else }}{{ .Values.externalRedis.database }}
{{- end }}
{{- end }}

{{/*
ClickHouse host — always in-cluster (no external option yet).
*/}}
{{- define "itsharness.clickhouseHost" -}}
{{- printf "%s-clickhouse" (include "itsharness.fullname" .) }}
{{- end }}

{{/*
Langfuse internal service URL (used by the adapter for traces).
*/}}
{{- define "itsharness.langfuseInternalUrl" -}}
{{- printf "http://%s-langfuse:3000" (include "itsharness.fullname" .) }}
{{- end }}

{{/*
LiteLLM internal service URL (used by the adapter for LLM calls).
*/}}
{{- define "itsharness.litellmInternalUrl" -}}
{{- printf "http://%s-litellm:4000" (include "itsharness.fullname" .) }}
{{- end }}

{{/*
Mastra runner internal service URL.
*/}}
{{- define "itsharness.mastraRunnerUrl" -}}
{{- printf "http://%s-mastra-runner:8001" (include "itsharness.fullname" .) }}
{{- end }}

{{/*
Common imagePullSecrets block.
*/}}
{{- define "itsharness.imagePullSecrets" -}}
{{- if .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range .Values.global.imagePullSecrets }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end }}
