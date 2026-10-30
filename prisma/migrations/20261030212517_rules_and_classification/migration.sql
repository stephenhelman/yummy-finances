/*
  Warnings:

  - A unique constraint covering the columns `[businessId,key]` on the table `Rule` will be added. If there are existing duplicate values, this will fail.
  - The required column `key` was added to the `Rule` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- CreateEnum
CREATE TYPE "RuleTarget" AS ENUM ('NORMALIZED', 'RAW');

-- CreateEnum
CREATE TYPE "RuleDirection" AS ENUM ('IN', 'OUT', 'ANY');

-- CreateEnum
CREATE TYPE "RuleSource" AS ENUM ('SEED', 'USER');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('NEEDS_REVIEW', 'AUTO', 'REVIEWED');

-- AlterEnum
ALTER TYPE "CategorySource" ADD VALUE 'PAIR';

-- AlterEnum
ALTER TYPE "RuleMatchType" ADD VALUE 'STARTS_WITH';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionKind" ADD VALUE 'CASH_DEPOSIT';
ALTER TYPE "TransactionKind" ADD VALUE 'INTERNAL_TRANSFER';
ALTER TYPE "TransactionKind" ADD VALUE 'CARD_PAYMENT';
ALTER TYPE "TransactionKind" ADD VALUE 'OWNER_CONTRIBUTION';
ALTER TYPE "TransactionKind" ADD VALUE 'SALES_TAX_REMITTANCE';
ALTER TYPE "TransactionKind" ADD VALUE 'LOAN_PAYMENT';
ALTER TYPE "TransactionKind" ADD VALUE 'VENDOR_REFUND';
ALTER TYPE "TransactionKind" ADD VALUE 'OTHER_INFLOW';

-- DropForeignKey
ALTER TABLE "Rule" DROP CONSTRAINT "Rule_categoryId_fkey";

-- DropIndex
DROP INDEX "Rule_businessId_matchType_pattern_key";

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "confirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pairId" TEXT,
ADD COLUMN     "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'NEEDS_REVIEW',
ALTER COLUMN "kind" DROP NOT NULL,
ALTER COLUMN "kind" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Rule" ADD COLUMN     "accounts" JSONB,
ADD COLUMN     "confirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "direction" "RuleDirection" NOT NULL DEFAULT 'ANY',
ADD COLUMN     "key" TEXT NOT NULL,
ADD COLUMN     "kind" "TransactionKind" NOT NULL DEFAULT 'EXPENSE',
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "source" "RuleSource" NOT NULL DEFAULT 'USER',
ADD COLUMN     "target" "RuleTarget" NOT NULL DEFAULT 'NORMALIZED',
ALTER COLUMN "categoryId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "BankTransaction_businessId_pairId_idx" ON "BankTransaction"("businessId", "pairId");

-- CreateIndex
CREATE INDEX "BankTransaction_businessId_reviewStatus_idx" ON "BankTransaction"("businessId", "reviewStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_businessId_key_key" ON "Rule"("businessId", "key");

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
