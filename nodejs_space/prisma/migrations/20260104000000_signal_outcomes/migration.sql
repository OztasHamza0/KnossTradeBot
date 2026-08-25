-- AlterTable
ALTER TABLE "sent_signals" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "closed_price" DOUBLE PRECISION,
ADD COLUMN     "leverage" DOUBLE PRECISION,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'open',
ADD COLUMN     "stop_loss" DOUBLE PRECISION,
ADD COLUMN     "take_profit" DOUBLE PRECISION;

-- CreateIndex
CREATE INDEX "sent_signals_status_created_at_idx" ON "sent_signals"("status", "created_at");

