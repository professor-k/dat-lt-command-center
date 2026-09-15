-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ENGINEER', 'VIEWER');

-- CreateEnum
CREATE TYPE "OperationalStatus" AS ENUM ('ACTIVE', 'AOG', 'MAINTENANCE', 'STORED');

-- CreateEnum
CREATE TYPE "DefectCategory" AS ENUM ('CRITICAL', 'CAT_A', 'CAT_B', 'CAT_C', 'CAT_D');

-- CreateEnum
CREATE TYPE "DefectStatus" AS ENUM ('OPEN', 'DEFERRED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NetworkStatus" AS ENUM ('OPTIMAL', 'DEGRADED', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('PASSED', 'PASSED_MINOR', 'PENDING_REVIEW', 'FAILED');

-- CreateEnum
CREATE TYPE "ImpedimentStatus" AS ENUM ('OPEN', 'MITIGATED', 'RESOLVED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Station" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'Italy',
    "networkStatus" "NetworkStatus" NOT NULL DEFAULT 'OPTIMAL',
    "complianceStatus" "ComplianceStatus" NOT NULL DEFAULT 'PASSED',
    "lastAuditAt" TIMESTAMP(3),
    "requiredAction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Station_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Aircraft" (
    "id" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'ATR 72-600',
    "operationalStatus" "OperationalStatus" NOT NULL DEFAULT 'ACTIVE',
    "flightHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cycles" INTEGER NOT NULL DEFAULT 0,
    "stationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Aircraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Defect" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "aircraftId" TEXT NOT NULL,
    "ataChapter" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "DefectCategory" NOT NULL DEFAULT 'CAT_C',
    "status" "DefectStatus" NOT NULL DEFAULT 'OPEN',
    "repetitive" BOOLEAN NOT NULL DEFAULT false,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "raisedById" TEXT,
    "closedById" TEXT,

    CONSTRAINT "Defect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictiveAlert" (
    "id" TEXT NOT NULL,
    "aircraftId" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "ataChapter" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "dueInDays" INTEGER NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "recommendation" TEXT NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictiveAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Impediment" (
    "id" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ImpedimentStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Impediment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DefectHistory" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "DefectHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Station_code_key" ON "Station"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Aircraft_registration_key" ON "Aircraft"("registration");

-- CreateIndex
CREATE UNIQUE INDEX "Defect_reference_key" ON "Defect"("reference");

-- CreateIndex
CREATE INDEX "Defect_aircraftId_status_idx" ON "Defect"("aircraftId", "status");

-- CreateIndex
CREATE INDEX "Defect_ataChapter_idx" ON "Defect"("ataChapter");

-- CreateIndex
CREATE INDEX "PredictiveAlert_aircraftId_acknowledged_idx" ON "PredictiveAlert"("aircraftId", "acknowledged");

-- CreateIndex
CREATE INDEX "Impediment_stationId_status_idx" ON "Impediment"("stationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DefectHistory_year_month_key" ON "DefectHistory"("year", "month");

-- AddForeignKey
ALTER TABLE "Aircraft" ADD CONSTRAINT "Aircraft_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_raisedById_fkey" FOREIGN KEY ("raisedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Defect" ADD CONSTRAINT "Defect_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PredictiveAlert" ADD CONSTRAINT "PredictiveAlert_aircraftId_fkey" FOREIGN KEY ("aircraftId") REFERENCES "Aircraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Impediment" ADD CONSTRAINT "Impediment_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "Station"("id") ON DELETE CASCADE ON UPDATE CASCADE;
