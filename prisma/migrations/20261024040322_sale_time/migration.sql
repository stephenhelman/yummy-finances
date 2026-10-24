-- saleTime: the timestamp used for all month assignment of Clover rows.
-- Existing rows are backfilled from createdTime (source SERVER); a re-sync
-- corrects any row whose device time (clientCreatedTime) should win.

-- CreateEnum
CREATE TYPE "SaleTimeSource" AS ENUM ('CLIENT', 'SERVER');

-- AlterTable (nullable first so existing rows can be backfilled)
ALTER TABLE "CloverPayment" ADD COLUMN     "clientCreatedTime" TIMESTAMP(3),
ADD COLUMN     "saleTime" TIMESTAMP(3),
ADD COLUMN     "saleTimeSource" "SaleTimeSource";

ALTER TABLE "CloverRefund" ADD COLUMN     "clientCreatedTime" TIMESTAMP(3),
ADD COLUMN     "isCash" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "saleTime" TIMESTAMP(3),
ADD COLUMN     "saleTimeSource" "SaleTimeSource",
ADD COLUMN     "tenderId" TEXT,
ADD COLUMN     "tenderLabel" TEXT;

-- Backfill
UPDATE "CloverPayment" SET "saleTime" = "createdTime", "saleTimeSource" = 'SERVER' WHERE "saleTime" IS NULL;
UPDATE "CloverRefund" SET "saleTime" = "createdTime", "saleTimeSource" = 'SERVER' WHERE "saleTime" IS NULL;

-- Enforce
ALTER TABLE "CloverPayment" ALTER COLUMN "saleTime" SET NOT NULL, ALTER COLUMN "saleTimeSource" SET NOT NULL;
ALTER TABLE "CloverRefund" ALTER COLUMN "saleTime" SET NOT NULL, ALTER COLUMN "saleTimeSource" SET NOT NULL;

-- CreateIndex
CREATE INDEX "CloverPayment_businessId_saleTime_idx" ON "CloverPayment"("businessId", "saleTime");

-- CreateIndex
CREATE INDEX "CloverRefund_businessId_saleTime_idx" ON "CloverRefund"("businessId", "saleTime");
