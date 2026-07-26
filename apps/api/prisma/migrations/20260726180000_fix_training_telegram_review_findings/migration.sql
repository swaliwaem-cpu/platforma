CREATE UNIQUE INDEX "training_voice_segments_answer_id_file_unique_id_key"
ON "training_voice_segments"("answer_id", "file_unique_id");
