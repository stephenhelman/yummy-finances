-- Category template: groups, treatment, discounts table, salesTaxInRevenue.
-- Structure only. Existing categories and rules are NOT moved into the new template here (that is a separate,
-- reviewed step); the one data statement at the end only gives each existing category a treatment consistent with
-- its old section, so nothing reads as the column default by accident.

-- CreateEnum
CREATE TYPE "CategoryTreatment" AS ENUM ('PNL_EXPENSE', 'PNL_INCOME', 'NON_PL', 'PERSONAL');

-- AlterEnum
ALTER TYPE "TransactionKind" ADD VALUE 'DONATION';
ALTER TYPE "TransactionKind" ADD VALUE 'OTHER_INCOME';

-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "salesTaxInRevenue" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "key" TEXT,
ADD COLUMN     "nonPlKind" "TransactionKind",
ADD COLUMN     "quickPickOrder" INTEGER,
ADD COLUMN     "showWhenZero" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "treatment" "CategoryTreatment" NOT NULL DEFAULT 'PNL_EXPENSE';

-- CreateTable
CREATE TABLE "CategoryGroup" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CategoryGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloverOrder" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cloverId" TEXT NOT NULL,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "clientCreatedTime" TIMESTAMP(3),
    "subtotalCents" INTEGER NOT NULL,
    "hasDiscount" BOOLEAN NOT NULL DEFAULT false,
    "discountNames" JSONB,
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloverOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CategoryGroup_businessId_sortOrder_idx" ON "CategoryGroup"("businessId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryGroup_businessId_name_key" ON "CategoryGroup"("businessId", "name");

-- CreateIndex
CREATE INDEX "CloverOrder_businessId_createdTime_idx" ON "CloverOrder"("businessId", "createdTime");

-- CreateIndex
CREATE UNIQUE INDEX "CloverOrder_businessId_cloverId_key" ON "CloverOrder"("businessId", "cloverId");

-- CreateIndex
CREATE INDEX "Category_businessId_groupId_sortOrder_idx" ON "Category"("businessId", "groupId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Category_businessId_key_key" ON "Category"("businessId", "key");

-- AddForeignKey
ALTER TABLE "CategoryGroup" ADD CONSTRAINT "CategoryGroup_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "CategoryGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloverOrder" ADD CONSTRAINT "CloverOrder_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Consistent treatment for the categories that already exist (old section -> treatment).
UPDATE "Category" SET "treatment" = CASE "section"
  WHEN 'NON_PL' THEN 'NON_PL'::"CategoryTreatment"
  WHEN 'REVENUE' THEN 'PNL_INCOME'::"CategoryTreatment"
  ELSE 'PNL_EXPENSE'::"CategoryTreatment" END;
