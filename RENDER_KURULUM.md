# Render + Neon — Kart İstemeyen Kurulum

Bot Render'da, veritabanı Neon'da, ikisi de ücretsiz ve kredi kartı istemiyor.
Toplam süre yaklaşık 30 dakika.

| Parça | Nerede | Ücret |
|---|---|---|
| Bot (Node servisi) | Render free web service | 0 — ayda 750 saat |
| PostgreSQL | Neon free | 0 — 0.5 GB, süresi dolmaz |
| Uyanık tutma | cron-job.org | 0 |
| HTTPS + alan adı | Render otomatik verir | 0 |

Oracle'dan farkı: alan adı almana gerek yok, firewall ayarı yok, sunucu
yönetimi yok. Render sana `https://...onrender.com` adresini kendisi veriyor.

---

## 1. Veritabanı — Neon

1. https://neon.com → **Sign up** (GitHub veya Google ile, kart yok)
2. **Create project**
   - İsim: `trading-bot`
   - Bölge: **Europe (Frankfurt)** — Render'ı da Frankfurt'a kuracağız
3. Proje açılınca **Connection string** kutusundan bağlantı adresini kopyala.
   Şuna benzer:

```
postgresql://neondb_owner:XXXX@ep-cool-name-123456.eu-central-1.aws.neon.tech/neondb?sslmode=require
```

Bunu bir kenara kaydet, birazdan lazım. **`?sslmode=require` kısmı şart**,
silme.

---

## 2. Kodu GitHub'a koy

Render kodu GitHub'dan çekiyor. Depo **private** olabilir.

1. https://github.com/new → depo adı `crypto-trading-bot` → **Private** → Create
2. Kendi bilgisayarında, proje klasöründe:

```bash
cd "C:\Users\Hamza\Downloads\crypto_trading_bot"

git init
git add .
git commit -m "Kripto trading bot"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADIN/crypto-trading-bot.git
git push -u origin main
```

> `.gitignore` hazır — `.env`, `.env.deploy` ve `node_modules` depoya gitmez.
> Push'tan sonra GitHub'da `.env` dosyasının **görünmediğini** kontrol et.

---

## 3. Render'da servisi kur

1. https://render.com → **Get Started** (GitHub ile giriş yap)
2. **New +** → **Blueprint**
3. GitHub deposunu seç. Render kökteki `render.yaml` dosyasını bulur ve
   servisi otomatik tanımlar.
4. **Apply** de. Render dört değişkeni senden isteyecek:

| Değişken | Ne yazacaksın |
|---|---|
| `DATABASE_URL` | Adım 1'deki Neon bağlantı adresi |
| `TELEGRAM_BOT_TOKEN` | @BotFather'dan aldığın token |
| `ABACUSAI_API_KEY` | Abacus API anahtarın |
| `PUBLIC_URL` | **Şimdilik boş bırak veya rastgele bir şey yaz** — adresi henüz bilmiyoruz |

`CRON_API_KEY` ve `TELEGRAM_WEBHOOK_SECRET` Render tarafından otomatik üretilir,
sen bir şey yazmayacaksın.

5. İlk derleme 5-10 dakika sürer (Docker imajı kuruluyor).

---

## 4. PUBLIC_URL'i ayarla — atlanırsa bot çalışmaz

Deploy bitince Render servis sayfasının en üstünde adresi gösterir:

```
https://kripto-trading-bot-xxxx.onrender.com
```

1. Bu adresi kopyala
2. Servis → **Environment** sekmesi → `PUBLIC_URL` değerini bu adres yap
   - Sonunda `/` **olmasın**
   - `/webhook/telegram` ekleme, kod onu kendisi ekliyor
3. **Save** → Render servisi otomatik yeniden başlatır

Loglarda şunu görmelisin:

```
Kripto Trading Bot 10000 portunda calisiyor
Telegram webhook kuruldu: https://kripto-trading-bot-xxxx.onrender.com/webhook/telegram
```

---

## 5. Uyanık tutma — bu adım önemli

Render ücretsiz servisi **15 dakika istek gelmezse uyur.** Uyurken:

- Telegram'dan yazdığında ~1 dakika gecikme olur
- **Saatlik otomatik nöbet hiç çalışmaz** (uyuyan konteynerde cron ateşlenmez)

Çözüm: 10 dakikada bir sağlık kontrolüne istek atmak. Servis hiç uyumaz,
otomatik nöbet düzgün çalışır.

1. https://cron-job.org → **Sign up** (ücretsiz, kart yok)
2. **Create cronjob**
   - Title: `bot uyanik tut`
   - URL: `https://kripto-trading-bot-xxxx.onrender.com/webhook/health`
   - Schedule: **Every 10 minutes**
3. **Create**

### Aylık saat hesabı

Render ayda **750 saat** veriyor. 31 günlük bir ay 744 saat.
Yani tek servisi ay boyunca kesintisiz çalıştırabilirsin — **6 saat marjın var.**

Marj dar. Şunlara dikkat:

- **Aynı hesapta ikinci bir ücretsiz servis çalıştırma.** Saatler ortak havuzdan
  düşer, ikisi birden ayı çıkaramaz.
- Kotayı doldurursan servis ay sonuna kadar askıya alınır.

**Riski sıfırlamak istersen** alternatif: uyusun, sadece saatlik tarama çalışsın.

- Render → Environment → `DISABLE_INTERNAL_CRON` = `true`
- cron-job.org'daki işi 10 dakikada bir yerine **saatte bir** yap ve URL'i şu şekilde değiştir:
  - URL: `https://.../auto-scan/execute`
  - Method: **POST**
  - Header ekle: `x-api-key` = Render'ın ürettiği `CRON_API_KEY`
    (Environment sekmesinde göz simgesine basınca görünür)

Bu durumda saatlik nöbet garanti çalışır, ayda ~50 saat harcarsın, ama
Telegram'dan ilk yazdığında ~1 dakika beklersin.

---

## 6. Doğrulama

```bash
curl https://kripto-trading-bot-xxxx.onrender.com/webhook/health
# beklenen: {"status":"ok","uptime":N}

curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
# "url" dolu, "last_error_message" bos olmali
```

Telegram'dan bota sırayla:

1. `/start` → karşılama mesajı
2. `bakiye 100` → bakiye kaydı (kill switch bunu kullanır)
3. `piyasa` → fiyatlar. **"Kaynak" satırına bak:**
   - `Binance Futures` → her şey yolunda
   - `CoinGecko (Binance erişilemedi)` → aşağıdaki nota bak
4. `tara` → 30-90 saniyede analiz

---

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| Bot hiç cevap vermiyor | `PUBLIC_URL` boş ya da yanlış. Adım 4'ü tekrarla, sonra Render'dan **Manual Deploy → Restart** |
| İlk mesajda ~1 dk gecikme | Servis uykudaydı. Adım 5'teki uyanık tutma işini kur |
| Otomatik nöbet hiç gelmiyor | Servis uyuyor. Adım 5 |
| `getWebhookInfo`'da SSL hatası | `PUBLIC_URL` sonunda `/` var ya da `http://` yazılmış |
| Deploy sırasında Prisma hatası | `DATABASE_URL` yanlış ya da `?sslmode=require` eksik |
| Servis askıya alındı | 750 saat kotası dolmuş. Ay başını bekle ya da adım 5'teki "uyusun" moduna geç |
| Kaynak `CoinGecko` görünüyor | Render'ın IP'si Binance'e engelli. Bot çalışmaya devam eder ama model sadece major coinlerden sinyal verir. Bölgeyi `oregon` yapmayı dene |

---

## Notlar

- **Neon 5 dakika hareketsizlikte veritabanını uyutur.** İlk sorgu onu uyandırır
  (~1 saniye), sorun değil. Ayda 100 compute-hour veriyor, bizim kullanımımız
  bunun çok altında.
- **Tek instance.** Render ücretsiz planda zaten tek instance verir, bu iyi —
  saatlik cron uygulama içinde, iki kopya aynı sinyali iki kez gönderirdi.
- **Abacus'un eski veritabanı taşınamaz** (dışarı kapalı). Bot temiz başlar,
  kurallarını ve bakiyeni yeniden gireceksin.
- **Kod güncellersen** GitHub'a push at, Render otomatik yeniden deploy eder.
