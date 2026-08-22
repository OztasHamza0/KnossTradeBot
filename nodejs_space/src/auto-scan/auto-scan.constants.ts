/**
 * Otomatik nobet araligi sinirlari (dakika).
 *
 * Ayri dosyada, cunku hem AutoScanService hem TelegramService kullaniyor;
 * servisten import etmek dairesel bagimlilik yaratirdi
 * (auto-scan.service -> telegram.service -> auto-scan.service).
 */

/** Her tarama bir LLM cagrisi; daha sik olursa token maliyeti hizla artar. */
export const MIN_SCAN_INTERVAL = 5;
export const MAX_SCAN_INTERVAL = 1440;
export const DEFAULT_SCAN_INTERVAL = 60;
