CREATE TABLE "assistant_rollout_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "stage" VARCHAR(16) NOT NULL,
    "gate_digest" CHAR(64) NOT NULL,
    "approval_json" JSONB NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assistant_rollout_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "assistant_rollout_events_stage_check" CHECK ("stage" IN ('ADMINS', 'PILOT', 'ALL'))
);

CREATE UNIQUE INDEX "assistant_rollout_events_stage_key" ON "assistant_rollout_events"("stage");
CREATE INDEX "assistant_rollout_events_started_at_idx" ON "assistant_rollout_events"("started_at");

INSERT INTO "assistant_rollout_events" ("stage", "gate_digest", "approval_json")
VALUES (
    'ADMINS',
    repeat('0', 64),
    '{"kind":"MIGRATION_BASELINE","passed":true,"targetStage":"ADMINS"}'::jsonb
);

CREATE FUNCTION "prevent_assistant_rollout_event_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'ASSISTANT_ROLLOUT_EVENTS_ARE_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "assistant_rollout_events_immutable"
BEFORE UPDATE OR DELETE ON "assistant_rollout_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_assistant_rollout_event_mutation"();

CREATE FUNCTION "validate_assistant_rollout_event_insert"()
RETURNS TRIGGER AS $$
DECLARE
    previous_started_at TIMESTAMP(3);
BEGIN
    IF NEW."stage" = 'ADMINS' THEN
        RETURN NEW;
    END IF;

    IF NEW."gate_digest" !~ '^[0-9a-f]{64}$'
        OR NEW."gate_digest" = repeat('0', 64)
        OR NEW."approval_json"->>'kind' IS DISTINCT FROM 'ASSISTANT_ROLLOUT_PREFLIGHT'
        OR NEW."approval_json"->>'passed' IS DISTINCT FROM 'true'
        OR NEW."approval_json"->>'currentStage' IS DISTINCT FROM (
            CASE WHEN NEW."stage" = 'PILOT' THEN 'ADMINS' ELSE 'PILOT' END
        )
        OR NEW."approval_json"->>'targetStage' IS DISTINCT FROM NEW."stage"
        OR NEW."approval_json"->'eval'->>'version' IS DISTINCT FROM 'assistant-eval-v1'
        OR NEW."approval_json"->'eval'->>'passed' IS DISTINCT FROM 'true'
        OR NEW."approval_json"->'eval'->>'caseCount' IS DISTINCT FROM '200'
        OR NEW."approval_json"->'sourceHealth'->>'passed' IS DISTINCT FROM 'true'
        OR NEW."approval_json"->'budgets'->>'passed' IS DISTINCT FROM 'true'
        OR NEW."approval_json"->'pilotCohort'->>'passed' IS DISTINCT FROM 'true'
        OR NEW."approval_json"->'observation'->>'passed' IS DISTINCT FROM 'true'
        OR NEW."approval_json"->>'criticalErrorCount' IS DISTINCT FROM '0'
    THEN
        RAISE EXCEPTION 'ASSISTANT_ROLLOUT_STAGE_APPROVAL_INVALID';
    END IF;

    SELECT "started_at" INTO previous_started_at
    FROM "assistant_rollout_events"
    WHERE "stage" = CASE WHEN NEW."stage" = 'PILOT' THEN 'ADMINS' ELSE 'PILOT' END;

    IF previous_started_at IS NULL THEN
        RAISE EXCEPTION 'ASSISTANT_ROLLOUT_PREVIOUS_STAGE_EVENT_REQUIRED';
    END IF;
    IF NEW."started_at" < previous_started_at THEN
        RAISE EXCEPTION 'ASSISTANT_ROLLOUT_STAGE_EVENT_ORDER_INVALID';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "assistant_rollout_events_sequential_insert"
BEFORE INSERT ON "assistant_rollout_events"
FOR EACH ROW EXECUTE FUNCTION "validate_assistant_rollout_event_insert"();
