-- CreateEnum
CREATE TYPE "PlaidItemStatus" AS ENUM ('OK', 'LOGIN_REQUIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "CategorySection" AS ENUM ('REVENUE', 'COGS', 'OPEX', 'OTHER', 'NON_PL');

-- CreateEnum
CREATE TYPE "RuleMatchType" AS ENUM ('EXACT', 'CONTAINS', 'REGEX');

-- CreateEnum
CREATE TYPE "TransactionKind" AS ENUM ('EXPENSE', 'CLOVER_SETTLEMENT', 'TRANSFER', 'OWNER_DRAW', 'IGNORE');

-- CreateEnum
CREATE TYPE "CategorySource" AS ENUM ('NONE', 'RULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "SettlementMatchStatus" AS ENUM ('MATCHED', 'NEEDS_REVIEW', 'UNMATCHED');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('DRAFT', 'LOCKED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "PlaidItem" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "accessTokenEnc" TEXT NOT NULL,
    "institutionName" TEXT,
    "status" "PlaidItemStatus" NOT NULL DEFAULT 'OK',
    "lastError" TEXT,
    "cursor" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlaidItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "plaidItemId" TEXT NOT NULL,
    "plaidAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mask" TEXT,
    "type" TEXT,
    "subtype" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "section" "CategorySection" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "matchType" "RuleMatchType" NOT NULL DEFAULT 'EXACT',
    "categoryId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "amountMinCents" INTEGER,
    "amountMaxCents" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "plaidTransactionId" TEXT NOT NULL,
    "pendingTransactionId" TEXT,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "date" DATE NOT NULL,
    "authorizedDate" DATE,
    "amountCents" INTEGER NOT NULL,
    "rawDescription" TEXT NOT NULL,
    "merchantName" TEXT,
    "normalizedMerchant" TEXT NOT NULL,
    "kind" "TransactionKind" NOT NULL DEFAULT 'EXPENSE',
    "categoryId" TEXT,
    "categorySource" "CategorySource" NOT NULL DEFAULT 'NONE',
    "ruleId" TEXT,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "adjustmentMonth" TEXT,
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloverPayment" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cloverId" TEXT NOT NULL,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT NOT NULL,
    "orderId" TEXT,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "adjustmentMonth" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloverPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CloverRefund" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "cloverId" TEXT NOT NULL,
    "paymentId" TEXT,
    "createdTime" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "tipCents" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "isLate" BOOLEAN NOT NULL DEFAULT false,
    "adjustmentMonth" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloverRefund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "bankTransactionId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "depositCents" INTEGER NOT NULL,
    "cloverGrossCents" INTEGER NOT NULL,
    "impliedFeeCents" INTEGER NOT NULL,
    "matchStatus" "SettlementMatchStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthSnapshot" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'DRAFT',
    "dataJson" JSONB NOT NULL,
    "inputsHash" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "pdfBlobKey" TEXT,
    "emailSentAt" TIMESTAMP(3),
    "emailId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MonthSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginToken" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlaidItem_plaidItemId_key" ON "PlaidItem"("plaidItemId");

-- CreateIndex
CREATE INDEX "PlaidItem_businessId_idx" ON "PlaidItem"("businessId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_plaidAccountId_key" ON "BankAccount"("plaidAccountId");

-- CreateIndex
CREATE INDEX "BankAccount_businessId_idx" ON "BankAccount"("businessId");

-- CreateIndex
CREATE INDEX "Category_businessId_section_idx" ON "Category"("businessId", "section");

-- CreateIndex
CREATE UNIQUE INDEX "Category_businessId_name_key" ON "Category"("businessId", "name");

-- CreateIndex
CREATE INDEX "Rule_businessId_active_priority_idx" ON "Rule"("businessId", "active", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_businessId_matchType_pattern_key" ON "Rule"("businessId", "matchType", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_plaidTransactionId_key" ON "BankTransaction"("plaidTransactionId");

-- CreateIndex
CREATE INDEX "BankTransaction_businessId_date_idx" ON "BankTransaction"("businessId", "date");

-- CreateIndex
CREATE INDEX "BankTransaction_businessId_categoryId_idx" ON "BankTransaction"("businessId", "categoryId");

-- CreateIndex
CREATE INDEX "BankTransaction_businessId_kind_categoryId_idx" ON "BankTransaction"("businessId", "kind", "categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "CloverPayment_cloverId_key" ON "CloverPayment"("cloverId");

-- CreateIndex
CREATE INDEX "CloverPayment_businessId_createdTime_idx" ON "CloverPayment"("businessId", "createdTime");

-- CreateIndex
CREATE UNIQUE INDEX "CloverRefund_cloverId_key" ON "CloverRefund"("cloverId");

-- CreateIndex
CREATE INDEX "CloverRefund_businessId_createdTime_idx" ON "CloverRefund"("businessId", "createdTime");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_bankTransactionId_key" ON "Settlement"("bankTransactionId");

-- CreateIndex
CREATE INDEX "Settlement_businessId_periodEnd_idx" ON "Settlement"("businessId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "MonthSnapshot_businessId_month_key" ON "MonthSnapshot"("businessId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "LoginToken_tokenHash_key" ON "LoginToken"("tokenHash");

-- CreateIndex
CREATE INDEX "LoginToken_businessId_email_idx" ON "LoginToken"("businessId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "JobRun_businessId_job_period_key" ON "JobRun"("businessId", "job", "period");

-- CreateIndex
CREATE INDEX "AuditLog_businessId_createdAt_idx" ON "AuditLog"("businessId", "createdAt");

-- AddForeignKey
ALTER TABLE "PlaidItem" ADD CONSTRAINT "PlaidItem_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_plaidItemId_fkey" FOREIGN KEY ("plaidItemId") REFERENCES "PlaidItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloverPayment" ADD CONSTRAINT "CloverPayment_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloverRefund" ADD CONSTRAINT "CloverRefund_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CloverRefund" ADD CONSTRAINT "CloverRefund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "CloverPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonthSnapshot" ADD CONSTRAINT "MonthSnapshot_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginToken" ADD CONSTRAINT "LoginToken_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

