# knoss-trader

Binance Futures otomatik işlem botu. Sıra: **backtest → testnet → canlı.**

## Neden bu sıra

Önceki bot (`crypto_trading_bot`) bir LLM'e "fırsat var mı" sorup cevabını
sinyal sayıyordu. Kart üretiyordu, güvenlik kontrolleri de doğruydu — ama
**işe yarayıp yaramadığı hiçbir zaman ölçülemedi.** Backtest yoktu, sonuç
takibi sonradan eklendi, isabet oranı hiç bilinmedi.

Bu projede ilk yazılan şey al-sat değil, **ölçüm**. Bir strateji geçmiş
veride para kazanmıyorsa canlıda da kazanmaz; canlıda kazanacağını
söyleyebilmenin tek yolu önce burada göstermek.

## Durum

| Aşama | Durum |
|---|---|
| Veri çekici (public klines, API key gerekmez) | ✅ |
| Backtest motoru | ✅ 72 test |
| Stratejiler (EMA geri çekilme, Donchian kırılım, yazı-tura kontrol) | ✅ |
| **Pozitif beklentili strateji** | ❌ henüz yok |
| Binance API istemcisi (testnet) | ⏳ |
| Canlı emir yürütücü | ⏳ |

## İlk ölçüm sonucu

BTCUSDT, komisyon %0.05/yön + kayma %0.02, işlem başı risk %1:

```
1 saatlik, 365 gün (8760 mum)
  EMA21/55 geri çekilme      351 işlem  %36.5 isabet  -0.073 R/işlem
  Donchian 20 kırılım        269 işlem  %35.7 isabet  -0.093 R/işlem
  Yazı-tura kontrol          305 işlem  %34.8 isabet  -0.123 R/işlem

4 saatlik, 900 gün
  Donchian 20 kırılım        169 işlem  %34.9 isabet  -0.033 R/işlem
  EMA21/55 geri çekilme      200 işlem  %34.5 isabet  -0.039 R/işlem
  Yazı-tura kontrol          202 işlem  %35.6 isabet  -0.000 R/işlem
```

**Hiçbiri pozitif değil.** 4 saatlikte klasik stratejiler yazı-turadan
*daha kötü*. R:R 2'de başabaş isabet oranı %33.3; hepsi %32-36 bandında,
yani ham sinyal kalitesi rastgeleden ayrışmıyor ve komisyon farkı yiyor.

Bu sonuç projenin başarısızlığı değil, **çıktısı**. Bu stratejiler canlıya
alınsaydı para kaybettirecekti ve bunu ancak aylar sonra anlayacaktık.

## Backtest motorunun kuralları

Her kural, backtest'i kolayca yalancı yapan bir şeyi engellemek için var:

1. **Geleceğe bakma yok** — strateji `i`. mumun kapanışında çağrılır.
2. **Giriş `i+1`'in açılışında** — sinyal mumunun kapanışından dolum alınamaz.
3. **Aynı mumda stop + hedef → stop sayılır** — mum içi sıra bilinmez;
   iyimser varsaymak sonucu sistematik olarak şişirir.
4. **Her iki yönde komisyon + kayma.**
5. **Fonlama** — 8 saatte bir, pozisyon açıkken.
6. **Tek pozisyon** — üst üste pozisyon maruziyeti gizlice büyütür.

Bunların hepsi `src/backtest/engine.spec.ts` içinde teste bağlı.

## Kullanım

```bash
npm install
npm run backtest -- BTCUSDT 1h 365
npm run backtest -- ETHUSDT 4h 900
```

Veri `data/` altına indirilir ve tekrar kullanılır.

## Önceki projeden taşınanlar

`crypto_trading_bot` içinde gerçekten doğru çalışan ve test edilmiş üç
modül aynen alındı:

- `core/indicators.ts` — RSI, ATR, aralık konumu, stop mesafesi denetimi
- `core/risk.ts` — likidasyon mesafesi, R/R, pozisyon boyutu, işlem başı risk

Atılan şey LLM'e karar verdiren katman.
