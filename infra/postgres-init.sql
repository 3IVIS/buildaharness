-- itsharness postgres init script
-- Runs automatically on first container start (only when data dir is empty).
-- The 'itsharness' database is already created via POSTGRES_DB env var.

-- Langfuse gets its own isolated database (separate from the adapter schema).
CREATE DATABASE langfuse OWNER itsharness;

-- Fix #45: LiteLLM also gets its own database, not the 'itsharness' one.
-- Sharing the adapter DB caused LiteLLM migrations to potentially shadow
-- or conflict with adapter tables.
CREATE DATABASE litellm OWNER itsharness;
