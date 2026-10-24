-- AlterEnum
ALTER TYPE "PlaidItemStatus" ADD VALUE 'PENDING_EXPIRATION';

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN     "included" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "includedSetByUser" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PlaidItem" ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "lastErrorCode" TEXT;
