ALTER TABLE "lot_presentation_collection_items" ADD COLUMN "comment" VARCHAR(1000);

CREATE TABLE "lot_presentation_workspace_items" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "unit_id" UUID NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "comment" VARCHAR(1000),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "lot_presentation_workspace_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lot_presentation_workspace_items_user_id_unit_id_key"
  ON "lot_presentation_workspace_items"("user_id", "unit_id");

CREATE INDEX "lot_presentation_workspace_items_user_id_sort_order_idx"
  ON "lot_presentation_workspace_items"("user_id", "sort_order");

CREATE INDEX "lot_presentation_workspace_items_unit_id_idx"
  ON "lot_presentation_workspace_items"("unit_id");

ALTER TABLE "lot_presentation_workspace_items"
  ADD CONSTRAINT "lot_presentation_workspace_items_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lot_presentation_workspace_items"
  ADD CONSTRAINT "lot_presentation_workspace_items_unit_id_fkey"
  FOREIGN KEY ("unit_id") REFERENCES "feed_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
