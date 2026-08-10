ALTER TABLE "training_answers"
  ADD COLUMN "audio_duration_seconds" INTEGER,
  ADD COLUMN "audio_input_bytes" BIGINT,
  ADD COLUMN "audio_output_bytes" BIGINT,
  ADD COLUMN "audio_ffmpeg_latency_ms" INTEGER;

ALTER TABLE "training_answers"
  ADD CONSTRAINT "training_answers_audio_duration_check"
    CHECK ("audio_duration_seconds" IS NULL OR "audio_duration_seconds" >= 0),
  ADD CONSTRAINT "training_answers_audio_input_bytes_check"
    CHECK ("audio_input_bytes" IS NULL OR "audio_input_bytes" >= 0),
  ADD CONSTRAINT "training_answers_audio_output_bytes_check"
    CHECK ("audio_output_bytes" IS NULL OR "audio_output_bytes" >= 0),
  ADD CONSTRAINT "training_answers_audio_ffmpeg_latency_check"
    CHECK ("audio_ffmpeg_latency_ms" IS NULL OR "audio_ffmpeg_latency_ms" >= 0);
