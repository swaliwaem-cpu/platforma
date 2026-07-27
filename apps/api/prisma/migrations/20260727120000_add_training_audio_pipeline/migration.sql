ALTER TABLE "training_answers"
ADD COLUMN "merged_audio_file_id" UUID,
ADD COLUMN "merged_audio_duration_milliseconds" INTEGER,
ADD COLUMN "audio_prepared_at" TIMESTAMP(3);

ALTER TABLE "training_voice_segments"
ADD COLUMN "original_file_id" UUID,
ADD COLUMN "checksum" VARCHAR(64),
ADD COLUMN "duration_milliseconds" INTEGER,
ADD COLUMN "downloaded_at" TIMESTAMP(3);

ALTER TABLE "training_answers"
ADD CONSTRAINT "training_answers_merged_audio_duration_nonnegative"
CHECK (
  "merged_audio_duration_milliseconds" IS NULL
  OR "merged_audio_duration_milliseconds" >= 0
);

ALTER TABLE "training_voice_segments"
ADD CONSTRAINT "training_voice_segments_duration_milliseconds_nonnegative"
CHECK (
  "duration_milliseconds" IS NULL
  OR "duration_milliseconds" >= 0
);

ALTER TABLE "training_voice_segments"
ADD CONSTRAINT "training_voice_segments_checksum_sha256"
CHECK (
  "checksum" IS NULL
  OR "checksum" ~ '^[0-9a-f]{64}$'
);

CREATE UNIQUE INDEX "training_answers_merged_audio_file_id_key"
ON "training_answers"("merged_audio_file_id");

CREATE UNIQUE INDEX "training_voice_segments_original_file_id_key"
ON "training_voice_segments"("original_file_id");

ALTER TABLE "training_answers"
ADD CONSTRAINT "training_answers_merged_audio_file_id_fkey"
FOREIGN KEY ("merged_audio_file_id")
REFERENCES "files"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "training_voice_segments"
ADD CONSTRAINT "training_voice_segments_original_file_id_fkey"
FOREIGN KEY ("original_file_id")
REFERENCES "files"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
