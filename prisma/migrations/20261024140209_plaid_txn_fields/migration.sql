-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "adjustmentBaseCents" INTEGER,
ADD COLUMN     "paymentChannel" TEXT,
ADD COLUMN     "pfcConfidence" TEXT,
ADD COLUMN     "pfcDetailed" TEXT,
ADD COLUMN     "pfcPrimary" TEXT,
ADD COLUMN     "pfcVersion" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ALTER COLUMN "normalizedMerchant" DROP NOT NULL;
