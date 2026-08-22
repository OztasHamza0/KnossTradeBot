# Oracle Cloud Always Free — Kurulum Adımları

Bot + PostgreSQL + otomatik HTTPS, tek makinede, süresiz ücretsiz.
Baştan sona yaklaşık 40 dakika.

---

## 1. Oracle hesabı ve sunucu

1. https://cloud.oracle.com → **Start for free**
2. Kayıt sırasında kart ister — **doğrulama içindir, para çekilmez.**
   Hesabın "Always Free" kalır; yükseltmedikçe ücretlendirilmezsin.
3. **Ana bölgeyi (home region) dikkatli seç, sonradan değişmez.**
   Almanya (Frankfurt) veya Hollanda (Amsterdam) Türkiye'ye en yakın gecikmeyi verir.
4. Menü → **Compute → Instances → Create instance**
   - **Image:** Ubuntu 22.04 (veya 24.04)
   - **Shape:** `VM.Standard.A1.Flex` → **2 OCPU / 12 GB** (Always Free sınırı)
   - SSH anahtarını **indir ve sakla** — bir daha veremiyor
5. **"Out of host capacity" hatası alırsan:** ARM kapasitesi o an dolu demektir.
   Başka bir Availability Domain dene, ya da `VM.Standard.E2.1.Micro`
   (AMD, 1 GB RAM) seç — o da Always Free ve bu bot için yeterli.

Kurulum bitince **Public IP** adresini not al.

---

## 2. İki firewall katmanı (en sık takılınan yer)

Oracle'da **iki** ayrı firewall var. İkisini de açman gerekiyor, yoksa
site açılmaz ve sebebini bulmak saatler alır.

### 2a. Oracle tarafı (VCN Security List)

Instance sayfası → **Virtual Cloud Network** → **Security Lists** → default liste
→ **Add Ingress Rules**, iki kural ekle:

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

### 2b. Sunucu içi (iptables)

Oracle'ın Ubuntu imajları 22 dışındaki her portu kapalı getirir.
SSH ile bağlanıp:

```bash
ssh -i indirdigin_anahtar.key ubuntu@SUNUCU_IP

sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo apt-get update && sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

> `iptables-persistent` kurulumu sırasında "mevcut kuralları kaydet?" diye
> sorarsa **Yes** de. Bu adım atlanırsa sunucu yeniden başladığında kurallar
> kaybolur ve bot erişilemez olur.

---

## 3. Ücretsiz alan adı (DuckDNS)

**Telegram webhook için ham IP adresi kullanılamaz, HTTPS zorunludur.**
HTTPS sertifikası da alan adı ister. DuckDNS ücretsiz ve yeterli.

1. https://www.duckdns.org → GitHub/Google ile giriş
2. Bir isim seç (örnek: `hamzabot`) → **add domain**
3. **current ip** alanına Oracle sunucunun public IP'sini yaz → **update ip**

Alan adın: `hamzabot.duckdns.org`

Doğrula (kendi bilgisayarından):

```bash
nslookup hamzabot.duckdns.org
```

Sunucunun IP'sini döndürmeli. Dönmüyorsa birkaç dakika bekle.

---

## 4. Docker kurulumu

Sunucuda:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker          # veya cikip tekrar SSH ile bagalan
docker --version
```

---

## 5. Projeyi sunucuya at

Kendi bilgisayarından (zip zaten hazır):

```bash
scp -i indirdigin_anahtar.key \
    "C:\Users\Hamza\Downloads\crypto_trading_bot_deploy.zip" \
    ubuntu@SUNUCU_IP:~/
```

Sunucuda:

```bash
sudo apt-get install -y unzip
unzip crypto_trading_bot_deploy.zip
cd crypto_trading_bot
```

---

## 6. Ortam değişkenleri

```bash
cp .env.deploy.example .env.deploy
nano .env.deploy
```

Doldurulacaklar:

| Değişken | Değer |
|---|---|
| `DOMAIN` | `hamzabot.duckdns.org` (kendi seçtiğin) |
| `ACME_EMAIL` | e-posta adresin |
| `POSTGRES_PASSWORD` | `openssl rand -base64 24` çıktısı |
| `TELEGRAM_BOT_TOKEN` | @BotFather'dan aldığın token |
| `ABACUSAI_API_KEY` | Abacus API anahtarın |
| `CRON_API_KEY` | `openssl rand -hex 32` çıktısı |
| `TELEGRAM_WEBHOOK_SECRET` | `openssl rand -hex 32` çıktısı |

`DOMAIN` başına `https://` **yazma**, sadece alan adı. `PUBLIC_URL`'i
docker-compose kendisi `https://${DOMAIN}` olarak kuruyor.

Kaydet: `Ctrl+O`, `Enter`, `Ctrl+X`

---

## 7. Başlat

```bash
docker compose --env-file .env.deploy up -d --build
```

İlk derleme ARM'de 3-6 dakika sürer. Sonra:

```bash
docker compose --env-file .env.deploy logs -f bot
```

Görmen gerekenler:

```
Kripto Trading Bot 3000 portunda calisiyor
Telegram webhook kuruldu: https://hamzabot.duckdns.org/webhook/telegram
```

`Ctrl+C` ile log takibinden çık (konteynerler çalışmaya devam eder).

---

## 8. Doğrulama

```bash
# 1. HTTPS ve saglik kontrolu
curl https://hamzabot.duckdns.org/webhook/health
# beklenen: {"status":"ok","uptime":N}

# 2. Telegram webhook'u gordu mu
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
# "url" dolu, "last_error_message" bos olmali
```

Sonra Telegram'dan bota sırayla:

1. `/start` → karşılama mesajı
2. `bakiye 100` → bakiye kaydı (kill switch bunu kullanır)
3. `piyasa` → BTC/ETH/SOL fiyatları, "Kaynak: Binance Futures" yazmalı
4. `tara` → 30-90 saniyede analiz

Saatlik otomatik nöbet uygulama içinde çalışır, ek kurulum yok.
Elle tetiklemek için:

```bash
curl -X POST https://hamzabot.duckdns.org/auto-scan/execute \
     -H "x-api-key: CRON_API_KEY_DEGERIN"
```

---

## 9. Günlük kullanım

```bash
cd ~/crypto_trading_bot

# Durum
docker compose --env-file .env.deploy ps

# Loglar
docker compose --env-file .env.deploy logs -f bot

# Yeniden baslat
docker compose --env-file .env.deploy restart bot

# Kod guncelledikten sonra
docker compose --env-file .env.deploy up -d --build

# Veritabani yedegi
docker compose --env-file .env.deploy exec postgres \
  pg_dump -U tradingbot tradingbot > yedek_$(date +%F).sql
```

---

## Sorun giderme

| Belirti | Sebep / çözüm |
|---|---|
| `curl` zaman aşımına uğruyor | Firewall. Adım 2a **ve** 2b'yi kontrol et — ikisi de gerekli |
| Caddy sertifika alamıyor | DuckDNS henüz sunucu IP'sini göstermiyor. `nslookup` ile doğrula, sonra `docker compose restart caddy` |
| `Telegram webhook kurulamadi` | `DOMAIN` yanlış ya da HTTPS henüz hazır değil. Önce adım 8'deki `curl` testini geçir |
| Bot cevap vermiyor ama loglar temiz | `getWebhookInfo` çıktısındaki `last_error_message`'a bak |
| `Binance Futures fetch failed` | Oracle'ın o bölgesi Binance'e engelli. Bot otomatik CoinGecko'ya düşer, çalışmaya devam eder ama sinyal kalitesi düşer. Bölge değiştirmek çözer |
| "Out of host capacity" | ARM kapasitesi dolu. Başka AD dene veya `E2.1.Micro` seç |

---

## Notlar

- **Tek instance çalıştır.** Saatlik cron uygulama içinde; iki kopya aynı
  sinyali iki kez gönderir.
- **Veritabanı bu makinede.** `pgdata` Docker volume'ünde durur, konteyner
  silinse bile kalır. Yine de düzenli `pg_dump` al.
- **Abacus'un veritabanı artık kullanılmıyor.** Eski `DATABASE_URL`
  (`hosteddb.reai.io`) dışarı kapalı olduğu için oradaki sohbet geçmişi
  taşınamaz — bot temiz başlar. Kurallarını ve bakiyeni yeniden gir.
- **Sunucu yeniden başlarsa** konteynerler `restart: unless-stopped`
  sayesinde kendiliğinden ayağa kalkar.
