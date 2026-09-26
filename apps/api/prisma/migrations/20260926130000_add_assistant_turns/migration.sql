-- Assistant v2 turn log: one row per question, masked, kept 90 days (the api deletes older rows daily).

-- CreateEnum
CREATE TYPE "assistant_turn_status" AS ENUM ('completed', 'failed');

-- CreateEnum
CREATE TYPE "assistant_turn_rating" AS ENUM ('up', 'down');

-- CreateTable
CREATE TABLE "assistant_turns" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "conversation_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "question" TEXT NOT NULL,
    "answer_text" TEXT,
    "lots_json" JSONB NOT NULL DEFAULT '[]',
    "sources_json" JSONB NOT NULL DEFAULT '[]',
    "trace_json" JSONB NOT NULL DEFAULT '[]',
    "model" VARCHAR(160) NOT NULL,
    "model_calls" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_usd" DECIMAL(18,8),
    "pricing_version" VARCHAR(120),
    "duration_ms" INTEGER NOT NULL,
    "status" "assistant_turn_status" NOT NULL,
    "error_code" VARCHAR(120),
    "rating" "assistant_turn_rating",
    "rating_comment" VARCHAR(1000),
    "rated_at" TIMESTAMP(3),

    CONSTRAINT "assistant_turns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "assistant_turns_created_at_idx" ON "assistant_turns"("created_at");

-- CreateIndex
CREATE INDEX "assistant_turns_rating_created_at_idx" ON "assistant_turns"("rating", "created_at");

-- CreateIndex
CREATE INDEX "assistant_turns_user_id_idx" ON "assistant_turns"("user_id");

-- AddForeignKey
ALTER TABLE "assistant_turns" ADD CONSTRAINT "assistant_turns_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

