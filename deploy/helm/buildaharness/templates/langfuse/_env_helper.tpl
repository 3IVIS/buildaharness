{{/*
Shared Langfuse environment variables — used by both the web and worker deployments.
Call as: {{- include "itsharness.langfuseEnv" . | nindent 12 }}
*/}}
{{- define "itsharness.langfuseEnv" -}}
- name: POSTGRES_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: postgres-password
- name: DATABASE_URL
  value: "postgresql://itsharness:$(POSTGRES_PASSWORD)@{{ include "itsharness.postgresHost" . }}:{{ include "itsharness.postgresPort" . }}/langfuse"
- name: CLICKHOUSE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: clickhouse-password
- name: CLICKHOUSE_MIGRATION_URL
  value: "clickhouse://default:$(CLICKHOUSE_PASSWORD)@{{ include "itsharness.clickhouseHost" . }}:9000"
- name: CLICKHOUSE_URL
  value: "http://default:$(CLICKHOUSE_PASSWORD)@{{ include "itsharness.clickhouseHost" . }}:8123"
- name: CLICKHOUSE_USER
  value: default
- name: REDIS_AUTH
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: redis-password
- name: REDIS_HOST
  value: {{ include "itsharness.redisHost" . | quote }}
- name: REDIS_PORT
  value: "6379"
- name: NEXTAUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: langfuse-nextauth-secret
- name: SALT
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: langfuse-salt
- name: ENCRYPTION_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: langfuse-encryption-key
- name: LANGFUSE_INIT_ORG_ID
  value: {{ .Values.langfuse.initOrgId | quote }}
- name: LANGFUSE_INIT_ORG_NAME
  value: {{ .Values.langfuse.initOrgName | quote }}
- name: LANGFUSE_INIT_PROJECT_ID
  value: {{ .Values.langfuse.initProjectId | quote }}
- name: LANGFUSE_INIT_PROJECT_NAME
  value: {{ .Values.langfuse.initProjectName | quote }}
- name: LANGFUSE_INIT_PROJECT_PUBLIC_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: langfuse-public-key
- name: LANGFUSE_INIT_PROJECT_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: langfuse-secret-key
- name: LANGFUSE_INIT_USER_EMAIL
  value: {{ .Values.secrets.langfuse.adminEmail | quote }}
- name: LANGFUSE_INIT_USER_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "itsharness.secretName" . }}
      key: langfuse-admin-password
      optional: true
- name: LANGFUSE_INIT_USER_NAME
  value: Admin
- name: TELEMETRY_ENABLED
  value: "false"
- name: LANGFUSE_ENABLE_EXPERIMENTAL_FEATURES
  value: "true"
# Fix #50 equivalent: Langfuse v3 requires this env var even when S3 is not used.
- name: LANGFUSE_S3_EVENT_UPLOAD_ENABLED
  value: "false"
- name: LANGFUSE_S3_EVENT_UPLOAD_BUCKET
  value: placeholder
{{- end }}
