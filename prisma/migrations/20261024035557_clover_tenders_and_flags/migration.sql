-- AlterTable
ALTER TABLE "CloverPayment" ADD COLUMN     "excluded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isCash" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tenderId" TEXT,
ADD COLUMN     "tenderLabel" TEXT;

-- AlterTable
ALTER TABLE "CloverRefund" ADD COLUMN     "cloverPaymentId" TEXT;

-- CreateTable
CREATE TABLE "CloverTender" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cloverId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "labelKey" TEXT,
    "isCash" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloverTender_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CloverTender_businessId_cloverId_key" ON "CloverTender"("businessId", "cloverId");

-- CreateIndex
CREATE INDEX "CloverRefund_businessId_cloverPaymentId_idx" ON "CloverRefund"("businessId", "cloverPaymentId");

-- AddForeignKey
ALTER TABLE "CloverTender" ADD CONSTRAINT "CloverTender_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
