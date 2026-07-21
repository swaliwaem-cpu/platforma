ALTER TABLE "project_presentation_drafts"
ADD COLUMN "cover_file_id" UUID;

CREATE INDEX "project_presentation_drafts_cover_file_id_idx"
ON "project_presentation_drafts"("cover_file_id");

ALTER TABLE "project_presentation_drafts"
ADD CONSTRAINT "project_presentation_drafts_cover_file_id_fkey"
FOREIGN KEY ("cover_file_id") REFERENCES "files"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
