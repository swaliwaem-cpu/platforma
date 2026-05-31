ALTER TABLE "feed_units" ADD COLUMN "discount_price" DECIMAL(14,2);
ALTER TABLE "feed_units" ADD COLUMN "effective_price" DECIMAL(14,2);
ALTER TABLE "feed_units" ADD COLUMN "discount_price_per_meter" DECIMAL(14,2);
ALTER TABLE "feed_units" ADD COLUMN "effective_price_per_meter" DECIMAL(14,2);

UPDATE "feed_units" SET "effective_price" = "price", "effective_price_per_meter" = "price_per_meter";

CREATE INDEX "feed_units_discount_price_idx" ON "feed_units"("discount_price");
CREATE INDEX "feed_units_effective_price_idx" ON "feed_units"("effective_price");
CREATE INDEX "feed_units_discount_price_per_meter_idx" ON "feed_units"("discount_price_per_meter");
CREATE INDEX "feed_units_effective_price_per_meter_idx" ON "feed_units"("effective_price_per_meter");
