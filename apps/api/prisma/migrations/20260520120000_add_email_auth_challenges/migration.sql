CREATE TABLE "email_auth_challenges" (
    "id" UUID NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),

    CONSTRAINT "email_auth_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "email_auth_challenges_token_hash_key" ON "email_auth_challenges"("token_hash");
CREATE INDEX "email_auth_challenges_email_code_hash_idx" ON "email_auth_challenges"("email", "code_hash");
CREATE INDEX "email_auth_challenges_user_id_idx" ON "email_auth_challenges"("user_id");
CREATE INDEX "email_auth_challenges_expires_at_idx" ON "email_auth_challenges"("expires_at");

ALTER TABLE "email_auth_challenges" ADD CONSTRAINT "email_auth_challenges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
