-- AlterTable
ALTER TABLE "users" ADD COLUMN     "refresh_token_expires_at" TIMESTAMP(3),
ADD COLUMN     "refresh_token_hash" TEXT;
