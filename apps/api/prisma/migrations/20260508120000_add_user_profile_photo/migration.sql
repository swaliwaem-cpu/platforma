-- AlterTable
ALTER TABLE "users" ADD COLUMN "profile_photo_file_id" UUID;

-- CreateIndex
CREATE INDEX "users_profile_photo_file_id_idx" ON "users"("profile_photo_file_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_profile_photo_file_id_fkey" FOREIGN KEY ("profile_photo_file_id") REFERENCES "files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
