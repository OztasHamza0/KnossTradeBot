# Kripto Trading Bot — Deploy Talimatları

Telegram üzerinden çalışan Binance Futures trading **asistanı**. Sinyal ve analiz
üretir; **borsada emir açmaz**, işlemleri kullanıcı elle girer. Bu yüzden
uygulamanın hiçbir borsa API anahtarına ihtiyacı yoktur.

- Backend: NestJS 11 (TypeScript)
- Veritabanı: PostgreSQL (Prisma 6)
- LLM: Abacus AI (`apps.abacus.ai/v1/chat/completions`), varsayılan model `claude-fable-5`
- Piyasa verisi: Binance Futures (birincil) → CoinGecko (yedek) + alternative.me Fear & Greed

---

## 1. Gerekli ortam değişkenleri

`nodejs_space/.env.example` dosyasının tam listesi var. Zorunlu olanlar:

| Değişken | Açıklama |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather'dan alınan token |
| `DATABASE_URL` | PostgreSQL bağlantı adresi |
| `ABACUSAI_API_KEY` | Abacus AI API anahtarı |
| `PUBLIC_URL` | **Uygulamanın canlı HTTPS adresi.** Bot açılışta Telegram webhook'unu buraya kaydeder. Boşsa bota mesaj gelmez. |

Önerilenler: `CRON_API_KEY`, `TELEGRAM_WEBHOOK_SECRET` (ikisi de rastgele uzun değer).
Opsiyonel: `LLM_MODEL` (varsayılan `claude-fable-5`), `DISABLE_INTERNAL_CRON`.

`PORT` platform tarafından enjekte edilir; elle ayarlama.

---

## 2. Deploy adımları

Çalışma dizini `nodejs_space/`.

```bash
npm install          # postinstall otomatik `prisma generate` çalıştırır
npm run build        # prisma generate + nest build
npm run start:prod   # prisma migrate deploy + node dist/main
```

Alternatif olarak `nodejs_space/Dockerfile` hazır — multi-stage, Alpine, migration'ı
açılışta kendisi uygular.

**Veritabanı:** `prisma/migrations/` içinde başlangıç migration'ı hazır.
`start:prod` bunu otomatik uygular; ayrıca elle çalıştırmaya gerek yok.
Migration geçmişi tutulmayan bir ortamda `npm run db:push` da kullanılabilir.

---

## 3. Deploy sonrası doğrulama

Sırayla:

1. **Sağlık kontrolü** — `GET {PUBLIC_URL}/webhook/health` → `{"status":"ok","uptime":N}`
2. **Webhook kurulmuş mu** — açılış loglarında
   `Telegram webhook kuruldu: {PUBLIC_URL}/webhook/telegram` satırı görünmeli.
   Görünmüyorsa `PUBLIC_URL` eksik veya yanlış.
   Telegram tarafından teyit: `https://api.telegram.org/bot<TOKEN>/getWebhookInfo`
   → `url` dolu ve `last_error_message` boş olmalı.
3. **Bota `/start` yaz** — karşılama mesajı gelmeli.
4. **`bakiye 100` yaz** — bakiye kaydedilmeli (kill switch bunu kullanır).
5. **`tara` yaz** — 30-90 saniye içinde analiz gelmeli.
6. **Saatlik nöbet** — uygulama içi cron her saat başı çalışır, ek kurulum gerekmez.
   Elle tetiklemek için:
   `POST {PUBLIC_URL}/auto-scan/execute` + `x-api-key: {CRON_API_KEY}` header'ı.

---

## 4. Mimari notlar

- **Webhook önce 200 döner**, işlemi arka planda yapar. Telegram, geç yanıtlanan
  update'i tekrar gönderir; LLM turu o pencereden uzun sürer.
- **Saatlik nöbet uygulama içindedir** (`@nestjs/schedule`). Platformun kendi
  cron'unu kullanmak istersen `DISABLE_INTERNAL_CRON=true` yapıp
  `/auto-scan/execute` endpoint'ini tetikle. İkisi aynı anda çalışırsa
  servis içi kilit çakışmayı engeller.
- **Tek instance çalıştır.** Cron uygulama içinde olduğu için birden fazla
  replica aynı saatte aynı taramayı yapar ve kullanıcıya mükerrer mesaj gider.
- **Demir kurallar kodda zorlanır**, sadece prompt'a bırakılmaz:
  `TradeEngineService.validateSignal` stop-loss/take-profit yönünü, kaldıraç
  aralığını, margin oranını ve kill switch'i kontrol eder; geçmeyen sinyal
  kullanıcıya hiç ulaşmaz.
- **Model 50 pariteyi görür.** Liste Binance Futures'tan geldiğinde sinyal
  yalnızca o listedeki paritelerden kabul edilir.

---

## 5. Bilinen sınırlar

- Binance Futures API bazı barındırma bölgelerinden **HTTP 451** ile engellenir.
  Bu durumda otomatik olarak CoinGecko'ya düşülür; sinyal kalitesi düşer ve
  model "pariteler Futures'ta olmayabilir" uyarısıyla kısıtlanır. Loglarda
  `Binance Futures fetch failed` görürsen sebebi budur.
- CoinGecko ücretsiz katmanı dakikada sınırlı istek kabul eder. 2 dakikalık
  önbellek bunun için yeterlidir.
- Bakiye kullanıcının beyanıdır, borsadan okunmaz. Kullanıcı `bakiye` yazarak
  güncellemezse kill switch devreye giremez.
