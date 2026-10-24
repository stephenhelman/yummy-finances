-- DropIndex
DROP INDEX "PlaidItem_businessId_idx";

-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN     "environment" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PlaidItem_businessId_environment_key" ON "PlaidItem"("businessId", "environment");

