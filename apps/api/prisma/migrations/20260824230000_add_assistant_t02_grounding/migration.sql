ALTER TABLE "assistant_messages"
  ADD COLUMN "answer_json" JSONB;

ALTER TABLE "assistant_runs"
  ADD COLUMN "intent_json" JSONB,
  ADD COLUMN "evidence_json" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "telemetry_json" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "assistant_messages"
  ADD CONSTRAINT "assistant_messages_answer_json_check" CHECK (
    "answer_json" IS NULL OR jsonb_typeof("answer_json") = 'object'
  );

ALTER TABLE "assistant_runs"
  ADD CONSTRAINT "assistant_runs_grounding_json_check" CHECK (
    ("intent_json" IS NULL OR jsonb_typeof("intent_json") = 'object')
    AND jsonb_typeof("evidence_json") = 'array'
    AND jsonb_typeof("telemetry_json") = 'array'
  );
