-- DropIndex
DROP INDEX "PlaidItem_businessId_environment_key";

-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN     "institutionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PlaidItem_businessId_environment_institutionId_key" ON "PlaidItem"("businessId", "environment", "institutionId");
