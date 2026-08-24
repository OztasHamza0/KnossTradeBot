# Abacus kotası biterse ne yapılır (para vermeden)

Üç kademe var: önce tüketimi düşür, yetmezse sağlayıcı değiştir.
Kod değişikliği gerekmiyor — hepsi ortam değişkeni.

---

## Kademe 1 — Tüketimi düşür (30 saniye)

Telegram'dan:

```
nöbet 2 saat
```

Tarama sayısı doğrudan maliyet. Aralık başına günlük çağrı:

| Aralık | Günlük tarama |
|---|---|
| 10 dk | 144 |
| 30 dk | 48 |
| 1 saat | 24 |
| 2 saat | 12 |
| 4 saat | 6 |

`nöbet kapat` dersen otomatik tarama tamamen durur; `tara` ve `araştır`
komutları çalışmaya devam eder. Kotayı sadece sen kullandığında harcarsın.

---

## Kademe 1.5 — İki kademeli model (en iyi kalite/maliyet dengesi)

Nöbet taramalarının ~%95'i "fırsat yok" ile bitiyor. O geçişlere pahalı model
harcamanın karşılığı yok. Ucuz model tarar, **sinyal çıkarsa** karar modeli
devreye girip onaylar, düzeltir ya da reddeder.

```
LLM_MODEL=anthropic/claude-opus-5          # karar modeli
LLM_MODEL_WATCH=anthropic/claude-haiku-4.5 # tarama modeli
```

**Tarama modelini ücretsiz yapmak:** Asıl kararı karar modeli verdiği için
tarayıcı ücretsiz de olabilir. OpenRouter'daki `:free` modeller arasında
bu iş için yeterli olanlar (güçlüden zayıfa):

```
nvidia/nemotron-3-ultra-550b-a55b:free
nvidia/nemotron-3-super-120b-a12b:free
z-ai/glm-5.2:free
google/gemma-4-31b-it:free
```

Ücretsiz modellerde dikkat edilecek iki şey:

1. **Format güvenilirliği.** Tarayıcının `{"signal": true/false}` JSON'u
   üretmesi gerekiyor. Üretemezse bot bunu artık "fırsat yok" sanmıyor,
   `nöbet test` çıktısında **"FORMAT HATASI"** diye açıkça söylüyor. O uyarıyı
   görürsen modeli değiştir.
2. **Günlük istek limiti.** Ücretsiz uçların günlük tavanı var. Saatlik nöbet
   günde ~16-24 çağrı yapıyor, çoğu limit buna yeter — ama `nöbet 10dk`
   yaparsan (144/gün) limite çarpabilirsin.

Modeli değiştirdikten sonra birkaç gün `nöbet test` ile kontrol et: format
hatası veriyor mu, hiç sinyal üretmiyor mu. Hiç sinyal üretmeyen bir tarayıcı
sessizce her fırsatı kaçırır — en sinsi başarısızlık şekli budur.

Sonuç: senin gördüğün **her kart** karar modelinden geçmiş olur, ama binlerce
sonuçsuz tarama ucuz modelde kalır. Ölçülen maliyet farkı: hepsi opus ~$29/ay,
iki kademeli ~$19/ay.

`LLM_MODEL_WATCH` tanımlı değilse ayrım kapanır, her şey `LLM_MODEL` ile çalışır.

---

## Kademe 2 — İstek başına maliyeti düşür (Render → Environment)

| Değişken | Etki |
|---|---|
| `LLM_MODEL=claude-sonnet-4-6` | Fable 5'ten belirgin ucuz, kalite kaybı sınırlı |
| `PROMPT_COIN_COUNT=25` | Prompt'a giren coin sayısı yarıya iner, input token yarılanır |
| `LLM_MAX_TOKENS=2000` | Cevap uzunluğu sınırlanır (fable düşünme payı ister, 2000'in altına inme) |

Üçünü birden uygularsan çağrı başına maliyet kabaca üçte bire düşer.

---

## Kademe 3 — Sağlayıcı değiştir

`callLLM` OpenAI-uyumlu `chat/completions` formatı konuşuyor. Aşağıdaki
sağlayıcılar aynı formatı kabul ediyor, yani **üç değişken değiştirip**
geçebilirsin. Kodda hiçbir şey değişmez.

### Google Gemini — önerilen alternatif

Tek gerçek sebebi: **görsel okuyabiliyor.** Bot Binance ekran görüntüsü
analiz ediyor; görsel desteklemeyen bir modele geçersen o özellik ölür.

```
LLM_API_URL=https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
LLM_API_KEY=<Google AI Studio anahtarı>
LLM_MODEL=<güncel gemini flash modeli>
```

Anahtar: https://aistudio.google.com → Get API key (ücretsiz, kart yok)

### Groq — en hızlısı

Çok hızlı ve ücretsiz, ama günlük istek limiti dar ve kullandığın modele
göre görsel desteği olmayabilir.

```
LLM_API_URL=https://api.groq.com/openai/v1/chat/completions
LLM_API_KEY=<Groq anahtarı>
LLM_MODEL=<groq model adı>
```

Anahtar: https://console.groq.com

### OpenRouter — tek anahtarla çok model

Ücretsiz modelleri var, sağlayıcı denemek için pratik.

```
LLM_API_URL=https://openrouter.ai/api/v1/chat/completions
LLM_API_KEY=<OpenRouter anahtarı>
LLM_MODEL=<model adı>
```

Anahtar: https://openrouter.ai/keys

---

## Geçiş sonrası kontrol listesi

1. Render → Environment → değişkenleri kaydet → servis yeniden başlar
2. Açılış logunda şu satır yeni sağlayıcıyı göstermeli:
   `LLM: <model> @ <host> | 50 coin, max 4000 token`
3. Telegram'dan `nöbet test` → "Model sonucu" satırı dolu gelmeli
4. Telegram'dan `tara` → analiz gelmeli
5. **Ekran görüntüsü gönder** → yeni model görseli okuyabiliyor mu, bunu
   mutlaka test et. Okuyamıyorsa hata verir ya da saçmalar.

Bir şey tutmazsa `LLM_API_URL` ve `LLM_API_KEY`'i silmen yeterli —
`ABACUSAI_API_KEY` yedek olarak duruyor, bot Abacus'a geri döner.

---

## Not

Sağlayıcı değiştirmek modelin karakterini değiştirir. Demir kurallar kodda
zorlandığı için güvenlik bozulmaz (`validateSignal` her sinyali süzer), ama
analiz kalitesi ve Türkçe akıcılığı modele göre değişir. Geçtikten sonra
birkaç `tara` çalıştırıp çıktının işine yarayıp yaramadığına bak.
