-- Assistant v1 was replaced on 2026-09-23 and its code lives in the archive/assistant-v1 branch.
-- Its tables go away except the two metro tables: the walking minutes from every project to
-- the nearest metro entrance were computed there and the new assistant still reads them.
-- The pgvector extension stays for the knowledge base of the next stage.

DROP TABLE
  "assistant_review_items",
  "assistant_feedback",
  "assistant_runs",
  "assistant_messages",
  "assistant_conversations",
  "assistant_rollout_events",
  "assistant_geo_usage_attempts",
  "assistant_geo_operations",
  "assistant_geo_aliases",
  "assistant_geo_landmarks",
  "assistant_geo_cache",
  "assistant_geo_provider_daily_usage",
  "assistant_usage_metrics",
  "assistant_ai_daily_budgets",
  "assistant_ai_execution_fences",
  "assistant_ai_usage_attempts",
  "assistant_source_jobs",
  "assistant_source_chunks",
  "assistant_source_facts",
  "assistant_source_revisions",
  "assistant_knowledge_sources";

-- Owned by assistant_ai_usage_attempts.attempt_ordinal, so normally already gone with the table.
DROP SEQUENCE IF EXISTS "assistant_ai_usage_attempt_compat_ordinal_seq";

-- Trigger functions outlive the tables whose triggers used them.
DROP FUNCTION "prevent_assistant_source_revision_raw_mutation"();
DROP FUNCTION "prevent_assistant_rollout_event_mutation"();
DROP FUNCTION "validate_assistant_rollout_event_insert"();
DROP FUNCTION "assistant_ai_usage_attempts_fill_recovery_fields"();
DROP FUNCTION "assistant_ai_usage_attempts_refresh_legacy_expiry"();

DROP TYPE
  "assistant_message_role",
  "assistant_run_status",
  "assistant_feedback_rating",
  "assistant_feedback_reason",
  "assistant_review_status",
  "assistant_review_classification",
  "assistant_usage_window",
  "assistant_knowledge_source_type",
  "assistant_knowledge_source_state",
  "assistant_source_revision_status",
  "assistant_source_fact_kind",
  "assistant_source_job_status",
  "assistant_source_job_trigger",
  "assistant_geo_landmark_kind",
  "assistant_geo_confirmation_state";

-- Both permissions only guarded v1 screens; admin:access keeps admins in the assistant.
DELETE FROM "role_permissions"
WHERE "permission_id" IN (
  SELECT "id" FROM "permissions" WHERE "key" IN ('assistant:audit:read', 'assistant:sources:manage')
);
DELETE FROM "permissions" WHERE "key" IN ('assistant:audit:read', 'assistant:sources:manage');
