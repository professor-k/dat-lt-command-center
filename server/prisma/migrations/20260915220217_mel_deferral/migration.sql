-- AlterTable
ALTER TABLE "Defect" ADD COLUMN     "deferralExpiresAt" TIMESTAMP(3),
ADD COLUMN     "deferralNote" TEXT,
ADD COLUMN     "deferralRef" TEXT,
ADD COLUMN     "deferredAt" TIMESTAMP(3),
ADD COLUMN     "deferredById" TEXT;

-- CreateIndex
CREATE INDEX "Defect_status_dueAt_idx" ON "Defect"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_deferredById_fkey" FOREIGN KEY ("deferredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
