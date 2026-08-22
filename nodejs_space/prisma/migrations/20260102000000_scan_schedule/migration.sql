-- AlterTable
ALTER TABLE "user_state" ADD COLUMN     "last_scan_at" TIMESTAMP(3),
ADD COLUMN     "scan_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "scan_interval_minutes" INTEGER NOT NULL DEFAULT 60;

