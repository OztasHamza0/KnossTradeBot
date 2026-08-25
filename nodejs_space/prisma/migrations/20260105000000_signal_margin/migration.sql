-- Toplam maruziyet hesabi icin: acik kartlarin bagladigi margin.
-- Margin tavani (%50) sinyal BASINA olculuyordu; ayni anda uc acik kart
-- bakiyenin %150'sini baglayabiliyordu.
ALTER TABLE "sent_signals" ADD COLUMN     "margin_usdt" DOUBLE PRECISION;
