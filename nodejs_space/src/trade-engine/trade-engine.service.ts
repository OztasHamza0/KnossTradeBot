import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  MarketDataService,
  MarketOverview,
  CoinResearch,
} from '../market-data/market-data.service';
import axios from 'axios';

export interface TradeSignal {
  pair: string;
  direction: string;
  leverage: string;
  margin: string;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  potentialGain: string;
  confidence: number;
  reason: string;
}

export interface EngineResponse {
  text: string;
  signal: TradeSignal | null;
}

export interface AutoScanResult {
  chatId: string;
  response: EngineResponse;
  alert: string | null;
  /** Why this pass did or did not produce a message. Shown by "nöbet test". */
  reason?: string;
}

/** Kill switch threshold — below this, no trade may be proposed. */
export const MIN_BALANCE_USDT = 50;
/** Position size ceiling as a fraction of balance. */
export const MAX_POSITION_RATIO = 0.5;
export const MIN_LEVERAGE = 1;
export const MAX_LEVERAGE = 10;

@Injectable()
export class TradeEngineService {
  private readonly logger = new Logger(TradeEngineService.name);
  private readonly apiUrl = 'https://apps.abacus.ai/v1/chat/completions';
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {
    this.model = this.config.get<string>('LLM_MODEL') ?? 'claude-fable-5';
  }

  async analyzeMarket(
    chatId: string,
    userMessage: string,
    imageBase64?: string,
  ): Promise<EngineResponse> {
    const balance = await this.getBalance(chatId);

    // Kill switch runs before the LLM call — a blocked account should not
    // spend tokens, and no prompt wording can talk the engine past this.
    if (balance !== null && balance < MIN_BALANCE_USDT) {
      return {
        text:
          `🛑 KILL SWITCH AKTIF\n\n` +
          `Kayıtlı bakiyen ${balance} USDT — ${MIN_BALANCE_USDT} USDT sınırının altında.\n` +
          `Kural gereği yeni işlem açmıyorum. Bakiyeni güncellemek için: "bakiye 120"`,
        signal: null,
      };
    }

    const [market, instructions, history] = await Promise.all([
      this.marketData.getMarketData(),
      this.getUserInstructions(chatId),
      this.getChatHistory(chatId),
    ]);

    const systemPrompt = this.buildSystemPrompt(market, instructions, balance);
    const messages = this.buildMessages(
      systemPrompt,
      history,
      userMessage,
      imageBase64,
    );

    let raw: string;
    try {
      raw = await this.callLLM(messages);
    } catch (error: any) {
      return { text: this.describeLLMError(error), signal: null };
    }

    const parsed = this.parseResponse(raw);
    if (!parsed.signal) return parsed;

    const validation = this.validateSignal(parsed.signal, market, balance);
    if (!validation.valid) {
      this.logger.warn(`Signal rejected: ${validation.reason}`);
      return {
        text:
          `⚠️ Model bir sinyal üretti ama güvenlik kontrolünden geçemedi:\n` +
          `${validation.reason}\n\n` +
          `🔍 Bu yüzden bu işlemi vermiyorum. Kurallar kurallar. 💪`,
        signal: null,
      };
    }

    if (
      await this.isDuplicateSignal(
        chatId,
        parsed.signal.pair,
        parsed.signal.direction,
      )
    ) {
      return {
        text:
          `ℹ️ ${parsed.signal.pair} ${parsed.signal.direction} sinyalini son 4 saat içinde ` +
          `zaten göndermiştim. Tekrar göndermiyorum. Sabırlı ol! 💪`,
        signal: null,
      };
    }

    return parsed;
  }

  /**
   * The watch pass. Runs on the chats the scheduler decided are due —
   * cadence is per-chat and lives in AutoScanService, not here.
   * Volatility only changes the framing; it is never a gate.
   */
  async analyzeForAutoScan(
    chatIds: string[],
    diagnostic = false,
  ): Promise<AutoScanResult[]> {
    const market = await this.marketData.getMarketData();
    const results: AutoScanResult[] = [];

    if (market.top50.length === 0) {
      this.logger.warn('Auto-scan skipped: no market data available');
      if (diagnostic) {
        for (const chatId of chatIds) {
          results.push({
            chatId,
            response: { text: '', signal: null },
            alert: null,
            reason: 'Piyasa verisi alınamadı — hiçbir kaynak cevap vermedi.',
          });
        }
      }
      return results;
    }

    const sharpMovers = market.top50.filter(
      (c) => Math.abs(c.price_change_percentage_1h) > 5,
    );

    for (const chatId of chatIds) {
      const balance = await this.getBalance(chatId);
      if (balance !== null && balance < MIN_BALANCE_USDT) {
        this.logger.log(`Auto-scan skipped for ${chatId}: kill switch active`);
        if (diagnostic) {
          results.push({
            chatId,
            response: { text: '', signal: null },
            alert: null,
            reason: `Kill switch aktif — bakiye ${balance} USDT, ${MIN_BALANCE_USDT} USDT sınırının altında.`,
          });
        }
        continue;
      }

      const alert =
        sharpMovers.length > 0
          ? `⚡ SERT HAREKET\n\n` +
            sharpMovers
              .slice(0, 8)
              .map(
                (c) =>
                  `${c.symbol}: $${this.fmtPrice(c.current_price)} ` +
                  `(1s: ${c.price_change_percentage_1h >= 0 ? '+' : ''}${c.price_change_percentage_1h.toFixed(2)}%)`,
              )
              .join('\n')
          : null;

      const instructions = await this.getUserInstructions(chatId);
      const systemPrompt = this.buildSystemPrompt(
        market,
        instructions,
        balance,
      );

      const userMsg =
        sharpMovers.length > 0
          ? `OTOMATİK NÖBET: Son 1 saatte sert hareket eden coinler: ` +
            `${sharpMovers.map((c) => c.symbol).join(', ')}. ` +
            `Bunları ve listedeki diğer coinleri değerlendir. ` +
            `Yüksek güvenli (7+) bir fırsat varsa işlem kartı ver, yoksa {"signal": false} dön.`
          : `OTOMATİK NÖBET: Piyasa sakin. Listedeki 50 coini tara. ` +
            `SADECE çok net ve yüksek güvenli (7+) bir fırsat varsa işlem kartı ver, ` +
            `en ufak şüphede {"signal": false} dön.`;

      let raw: string;
      try {
        raw = await this.callLLM(this.buildMessages(systemPrompt, [], userMsg));
      } catch (error: any) {
        this.logger.error(
          `Auto-scan LLM call failed for ${chatId}: ${error?.message}`,
        );
        // Still deliver the volatility alert — it needs no model.
        if (alert || diagnostic)
          results.push({
            chatId,
            response: { text: '', signal: null },
            alert,
            reason: `Model çağrısı başarısız: ${error?.message}`,
          });
        continue;
      }

      const parsed = this.parseResponse(raw);

      // Why nothing was sent — surfaced by "nöbet test" so a silent watch can
      // be told apart from a broken one.
      let reason: string;
      let deliverable: EngineResponse = { text: '', signal: null };

      if (!parsed.signal) {
        reason = 'Model fırsat görmedi (signal: false).';
      } else if (parsed.signal.confidence < 7) {
        reason =
          `Model ${parsed.signal.pair} ${parsed.signal.direction} önerdi ama güven skoru ` +
          `${parsed.signal.confidence}/10 — otomatik nöbet için 7 gerekiyor.`;
      } else {
        const validation = this.validateSignal(parsed.signal, market, balance);
        const duplicate = await this.isDuplicateSignal(
          chatId,
          parsed.signal.pair,
          parsed.signal.direction,
        );

        if (!validation.valid) {
          reason = `Sinyal güvenlik kontrolünden geçemedi: ${validation.reason}`;
          this.logger.warn(`Auto-scan signal rejected: ${validation.reason}`);
        } else if (duplicate) {
          reason =
            `${parsed.signal.pair} ${parsed.signal.direction} son 4 saatte zaten ` +
            `gönderilmişti (spam koruması).`;
        } else {
          deliverable = parsed;
          reason = 'Sinyal gönderildi.';
        }
      }

      if (deliverable.signal || alert || diagnostic) {
        results.push({ chatId, response: deliverable, alert, reason });
      }
    }

    return results;
  }

  /** Diagnostics for "nöbet test" — no model call, so it is free and instant. */
  async describeMarketState(): Promise<{
    source: string;
    coinCount: number;
    sharpMovers: { symbol: string; change1h: number }[];
    fearGreed: number | null;
    fetchedAt: number;
    warnings: string[];
  }> {
    const market = await this.marketData.getMarketData();
    return {
      source: market.source,
      coinCount: market.top50.length,
      sharpMovers: market.top50
        .filter((c) => Math.abs(c.price_change_percentage_1h) > 5)
        .map((c) => ({
          symbol: c.symbol,
          change1h: c.price_change_percentage_1h,
        })),
      fearGreed: market.fearGreed?.value ?? null,
      fetchedAt: market.fetchedAt,
      warnings: market.warnings,
    };
  }

  /**
   * Research mode — "araştır PEPE".
   *
   * Discussion is not a signal, so the framing is deliberately looser than the
   * scan path: the model is asked to weigh the project, not to hunt an entry.
   * A trade card is still allowed, and when one comes back it goes through the
   * exact same validateSignal gate as every other card. The safety layer sits
   * on the signal, not on the conversation.
   */
  async analyzeCoin(
    chatId: string,
    research: CoinResearch,
    userQuestion: string,
  ): Promise<EngineResponse> {
    const balance = await this.getBalance(chatId);

    if (balance !== null && balance < MIN_BALANCE_USDT) {
      // Research is still allowed while the kill switch is on — only the card
      // is not. The model is told so it does not dangle an entry.
      this.logger.log(`Research in kill-switch mode for ${chatId}`);
    }

    const [market, instructions] = await Promise.all([
      this.marketData.getMarketData(),
      this.getUserInstructions(chatId),
    ]);

    const killSwitchOn = balance !== null && balance < MIN_BALANCE_USDT;
    const systemPrompt = this.buildResearchPrompt(
      research,
      market,
      instructions,
      balance,
      killSwitchOn,
    );

    let raw: string;
    try {
      raw = await this.callLLM([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userQuestion },
      ]);
    } catch (error: any) {
      return { text: this.describeLLMError(error), signal: null };
    }

    const parsed = this.parseResponse(raw);
    if (!parsed.signal) return parsed;

    if (killSwitchOn) {
      return {
        text:
          `${parsed.text}\n\n` +
          `🛑 Analizi yaptım ama işlem kartı vermiyorum: bakiyen ${balance} USDT, ` +
          `${MIN_BALANCE_USDT} USDT sınırının altında.`,
        signal: null,
      };
    }

    const validation = this.validateSignal(parsed.signal, market, balance);
    if (!validation.valid) {
      this.logger.warn(`Research signal rejected: ${validation.reason}`);
      return {
        text:
          `${parsed.text}\n\n` +
          `⚠️ Bir işlem kartı önerdim ama güvenlik kontrolünden geçmedi:\n` +
          `${validation.reason}\n\nO yüzden kartı vermiyorum.`,
        signal: null,
      };
    }

    return parsed;
  }

  private buildResearchPrompt(
    r: CoinResearch,
    market: MarketOverview,
    instructions: string[],
    balance: number | null,
    killSwitchOn: boolean,
  ): string {
    const fmtBig = (n: number) =>
      n >= 1e9
        ? `$${(n / 1e9).toFixed(2)} Milyar`
        : n >= 1e6
          ? `$${(n / 1e6).toFixed(1)}M`
          : `$${n.toFixed(0)}`;

    const fmtSupply = (n: number | null) => {
      if (n === null || n === 0) return 'bilinmiyor';
      if (n >= 1e12) return `${(n / 1e12).toFixed(2)} Trilyon`;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)} Milyar`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)} Milyon`;
      return n.toFixed(0);
    };

    const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

    // Fully-circulating supply means no unlock overhang; a small float means
    // the opposite. Worth stating rather than leaving the model to infer.
    const floatNote =
      r.totalSupply && r.circulatingSupply
        ? r.circulatingSupply / r.totalSupply > 0.95
          ? 'Arzın neredeyse tamamı dolaşımda — kilit açılımı baskısı düşük.'
          : `Toplam arzın yalnızca %${((r.circulatingSupply / r.totalSupply) * 100).toFixed(0)}'i dolaşımda — ilerleyen dönemde kilit açılımı satış baskısı yaratabilir.`
        : '';

    const tradableNote = r.futuresPair
      ? `Binance Futures'ta ${r.futuresPair} olarak işlem görüyor — işlem kartı verebilirsin.`
      : `⚠️ Bu coin Binance Futures'ta İŞLEM GÖRMÜYOR. Kaldıraçlı işlem AÇILAMAZ. ` +
        `İşlem kartı VERME, {"signal": false} dön ve kullanıcıya spot alım dışında ` +
        `bu coine futures'tan giremeyeceğini söyle.`;

    const altNote = r.alternatives.length
      ? `\n\nNot: Bu isimle eşleşen başka coinler de var (${r.alternatives
          .map((a) => `${a.symbol}${a.rank ? ` #${a.rank}` : ''}`)
          .join(
            ', ',
          )}). Kullanıcı bunlardan birini kastettiyse belirtmesini iste.`
      : '';

    const balanceBlock = killSwitchOn
      ? `💰 Kullanıcı bakiyesi ${balance} USDT — ${MIN_BALANCE_USDT} USDT sınırının ALTINDA. ` +
        `Analiz yap ama işlem kartı VERME.`
      : balance !== null
        ? `💰 Kullanıcı bakiyesi: ${balance} USDT — margin ${(balance * MAX_POSITION_RATIO).toFixed(2)} USDT'yi geçemez.`
        : `💰 Bakiye bildirilmemiş. Kart verirsen 100 USDT varsay ve "bakiye 100" yazmasını hatırlat.`;

    const instructionsBlock = instructions.length
      ? `\n\n🔒 KULLANICININ KALICI TALİMATLARI:\n${instructions.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
      : '';

    return `Sen cesur ama disiplinli bir Türk kripto trader'ısın. Şu an ARAŞTIRMA MODUNDASIN.

Kullanıcı belirli bir coin hakkında konuşmak, öğrenmek ve fikrini almak istiyor.
Bu bir tarama değil — zorla fırsat bulmak zorunda değilsin. Dürüst ol:
coin çöpse çöp de, riskliyse riskini söyle, güzelse güzel de.

📊 ${r.name} (${r.symbol})${r.marketCapRank ? ` — piyasa değeri sıralaması #${r.marketCapRank}` : ''}

Fiyat        : $${r.price}
Piyasa değeri: ${fmtBig(r.marketCap)}
24s hacim    : ${fmtBig(r.volume24h)}
Değişim      : 24s ${pct(r.change24h)} | 7g ${pct(r.change7d)} | 30g ${pct(r.change30d)}
ATH          : $${r.ath} (şu an ATH'den ${pct(r.athChangePct)} uzakta)
Dolaşan arz  : ${fmtSupply(r.circulatingSupply)}
Toplam arz   : ${fmtSupply(r.totalSupply)}
Maks arz     : ${fmtSupply(r.maxSupply)}
Kategoriler  : ${r.categories.join(', ') || 'belirtilmemiş'}
${r.homepage ? `Site         : ${r.homepage}` : ''}

Proje açıklaması:
${r.description || '(açıklama yok)'}

${floatNote}
${tradableNote}${altNote}

🌍 GENEL PİYASA: BTC ${market.btc ? `$${this.fmtPrice(market.btc.current_price)}` : 'bilinmiyor'}, Fear & Greed ${market.fearGreed?.value ?? '?'}

${balanceBlock}

📝 NASIL CEVAP VER:
1. Coin ne işe yarıyor, gerçek bir projesi mi var yoksa meme mi — açıkça söyle
2. Sayılardan ne okuyorsun: hacim/piyasa değeri oranı, ATH mesafesi, arz durumu
3. Riskler — meme coin riski, düşük hacim, kilit açılımı, aşırı ısınma
4. Net görüş: şu an yatırım/işlem için mantıklı mı, değilse neden

🚫 DEMİR KURALLAR (işlem kartı verirsen geçerli):
1. Stop-loss VE take-profit ZORUNLU
2. SADECE ISOLATED margin
3. Kaldıraç ${MIN_LEVERAGE}x-${MAX_LEVERAGE}x
4. Margin, bakiyenin en fazla %${MAX_POSITION_RATIO * 100}'si
5. LONG ise stopLoss < entry < takeProfit — SHORT ise takeProfit < entry < stopLoss
6. Emin değilsen kart VERME, sadece yorumunu yaz
${instructionsBlock}

İşlem kartı vermek istersen cevabına şu JSON'u ekle (fiyatları sayı olarak yaz):
\`\`\`json
{"signal": true, "pair": "${r.futuresPair ?? 'YOK'}", "direction": "LONG", "leverage": "3x", "margin": "20 USDT", "entry": "0", "stopLoss": "0", "takeProfit": "0", "potentialGain": "+X USDT", "confidence": 6, "reason": "kısa gerekçe"}
\`\`\`

Kart vermeyeceksen:
\`\`\`json
{"signal": false}
\`\`\`

Türkçe, enerjik ama dürüst konuş. Sohbet ediyoruz — sinyal makinesi değilsin.`;
  }

  private buildSystemPrompt(
    market: MarketOverview,
    instructions: string[],
    balance: number | null,
  ): string {
    const px = (c: { current_price: number } | null) =>
      c ? `$${this.fmtPrice(c.current_price)}` : 'bilinmiyor';

    const fg = market.fearGreed
      ? `${market.fearGreed.value}/100 (${market.fearGreed.classification})`
      : 'bilinmiyor';

    // All 50 coins, one compact line each — the model was asked to scan 50,
    // so it must actually see 50.
    const coinTable = market.top50
      .map(
        (c, i) =>
          `${String(i + 1).padStart(2)}. ${c.pair.padEnd(12)} $${this.fmtPrice(c.current_price)} ` +
          `| 24s ${c.price_change_percentage_24h >= 0 ? '+' : ''}${c.price_change_percentage_24h.toFixed(2)}% ` +
          `| 1s ${c.price_change_percentage_1h >= 0 ? '+' : ''}${c.price_change_percentage_1h.toFixed(2)}% ` +
          `| hacim $${(c.total_volume / 1_000_000).toFixed(1)}M`,
      )
      .join('\n');

    const sourceNote =
      market.source === 'binance'
        ? `Bu liste Binance Futures'tan geldi — hepsi işlem yapılabilir USDT perpetual paritesi. SADECE bu listedeki paritelerden sinyal ver.`
        : market.source === 'coingecko'
          ? `⚠️ Binance Futures verisine ulaşılamadı, bu liste CoinGecko'dan geldi. Paritelerin Futures'ta olduğu GARANTİ DEĞİL — sadece çok bilinen major coinlerden sinyal ver, ufak coinlere girme.`
          : `⚠️ Piyasa verisi alınamadı. Fiyata dayalı sinyal VERME.`;

    const balanceBlock =
      balance !== null
        ? `💰 KULLANICI BAKİYESİ: ${balance} USDT\n` +
          `→ Margin ${(balance * MAX_POSITION_RATIO).toFixed(2)} USDT'yi GEÇEMEZ (bakiyenin %50'si).`
        : `💰 Kullanıcı bakiyesini henüz bildirmedi. Margin önerirken 100 USDT varsay ` +
          `ve kullanıcıya "bakiye 100" yazarak gerçek bakiyesini kaydetmesini hatırlat.`;

    const instructionsBlock = instructions.length
      ? `\n\n🔒 KULLANICININ KALICI TALİMATLARI (bunlara MUTLAKA uy, demir kurallarla çelişmediği sürece):\n` +
        instructions.map((inst, i) => `${i + 1}. ${inst}`).join('\n')
      : '';

    const warningBlock = market.warnings.length
      ? `\n\n⚠️ VERİ UYARILARI:\n${market.warnings.map((w) => `- ${w}`).join('\n')}`
      : '';

    return `Sen cesur ama disiplinli bir Türk kripto trader'ısın. Binance Futures üzerinde işlem yapıyorsun.
Enerjik, motive edici ve Türkçe konuşuyorsun. Ama kuralların DEMİR gibi.

📊 PİYASA (${new Date(market.fetchedAt).toLocaleString('tr-TR')}):
BTC ${px(market.btc)} | ETH ${px(market.eth)} | SOL ${px(market.sol)}
Fear & Greed: ${fg}

📋 HACME GÖRE TOP 50:
${coinTable || '(veri yok)'}

${sourceNote}

${balanceBlock}

🚫 DEMİR KURALLAR (ASLA İHLAL ETME):
1. Her işlem sinyalinde MUTLAKA stop-loss VE take-profit olacak. Sonradan genişletilemez.
2. SADECE ISOLATED margin modu.
3. Martingale YOK — kaybeden pozisyona ekleme YASAK.
4. Kaldıraç ${MIN_LEVERAGE}x-${MAX_LEVERAGE}x arası. Asla daha fazla değil.
5. Margin, bakiyenin en fazla %${MAX_POSITION_RATIO * 100}'si.
6. Bakiye ${MIN_BALANCE_USDT} USDT altındaysa → TÜM işlemleri REDDET.
7. Emin değilsen işlem AÇMA. "Şu an işlem yok" geçerli ve saygın bir cevaptır.

📐 STOP-LOSS / TAKE-PROFIT YÖNÜ (matematiksel zorunluluk):
- LONG ise: stopLoss < entry < takeProfit
- SHORT ise: takeProfit < entry < stopLoss
Bu ters olursa sinyal otomatik REDDEDİLİR.
${instructionsBlock}${warningBlock}

📋 CEVAP FORMATI:
İşlem fırsatı varsa cevabına şu JSON bloğunu MUTLAKA ekle:
\`\`\`json
{
  "signal": true,
  "pair": "BTCUSDT",
  "direction": "LONG",
  "leverage": "5x",
  "margin": "20 USDT",
  "entry": "67450",
  "stopLoss": "66200",
  "takeProfit": "69500",
  "potentialGain": "+15 USDT",
  "confidence": 7,
  "reason": "Kısa gerekçe"
}
\`\`\`

Fırsat yoksa:
\`\`\`json
{"signal": false}
\`\`\`

Fiyatları sayı olarak yaz (binlik ayraç veya $ işareti KOYMA).
JSON bloğundan önce veya sonra Türkçe yorumunu yaz. Enerjik ve motive edici ol!
Kullanıcı ekran görüntüsü gönderirse görseli analiz et ve yukarıdaki piyasa verisiyle birlikte değerlendir.`;
  }

  private buildMessages(
    systemPrompt: string,
    history: { role: string; content: string }[],
    userMessage: string,
    imageBase64?: string,
  ): any[] {
    const msgs: any[] = [{ role: 'system', content: systemPrompt }];

    for (const h of history.slice(-10)) {
      msgs.push({ role: h.role, content: h.content });
    }

    if (imageBase64) {
      msgs.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              userMessage ||
              'Bu ekran görüntüsünü analiz et ve işlem fırsatı var mı değerlendir.',
          },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
        ],
      });
    } else {
      msgs.push({ role: 'user', content: userMessage });
    }

    return msgs;
  }

  private async callLLM(messages: any[]): Promise<string> {
    const apiKey = this.config.get<string>('ABACUSAI_API_KEY');
    if (!apiKey) throw new Error('ABACUSAI_API_KEY tanimli degil');

    const resp = await axios.post(
      this.apiUrl,
      {
        model: this.model,
        messages,
        stream: false,
        // Fable spends tokens on reasoning before it writes, so the ceiling
        // has to clear both the thinking and the answer.
        max_tokens: 4000,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120000,
      },
    );

    const content = resp.data?.choices?.[0]?.message?.content ?? '';
    if (!content) {
      const finish = resp.data?.choices?.[0]?.finish_reason;
      throw new Error(`Model bos cevap dondu (finish_reason: ${finish})`);
    }
    return content;
  }

  private describeLLMError(error: any): string {
    const status = error?.response?.status;
    this.logger.error(
      `LLM call failed (${status ?? 'no status'}): ${error?.message}`,
    );

    if (status === 401 || status === 403) {
      return '🔑 Abacus API anahtarı reddedildi. ABACUSAI_API_KEY değerini kontrol et.';
    }
    if (status === 429) {
      return '⏳ Abacus API kotası doldu ya da çok hızlı istek attık. Birkaç dakika sonra tekrar dene.';
    }
    if (error?.code === 'ECONNABORTED') {
      return '⏱️ Model zamanında cevap vermedi. Tekrar dene.';
    }
    return '❌ Analiz motoruna ulaşamadım. Birazdan tekrar dene.';
  }

  parseResponse(raw: string): EngineResponse {
    // Prefer a fenced block; fall back to a bare object so a missing fence
    // does not silently turn a real signal into plain chat.
    const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const bare = fenced ? null : raw.match(/\{[\s\S]*"signal"[\s\S]*?\}/);
    const jsonText = fenced?.[1] ?? bare?.[0];

    if (!jsonText) return { text: raw.trim(), signal: null };

    try {
      const parsed = JSON.parse(jsonText);
      const text = raw.replace(fenced?.[0] ?? bare![0], '').trim();

      if (!parsed.signal) {
        return {
          text:
            text ||
            '🔍 Şu an net bir fırsat yok. Sabırlı kal, piyasa konuşacak!',
          signal: null,
        };
      }

      return {
        text,
        signal: {
          pair: String(parsed.pair ?? '').toUpperCase(),
          direction: String(parsed.direction ?? '').toUpperCase(),
          leverage: String(parsed.leverage ?? ''),
          margin: String(parsed.margin ?? ''),
          entry: String(parsed.entry ?? ''),
          stopLoss: String(parsed.stopLoss ?? ''),
          takeProfit: String(parsed.takeProfit ?? ''),
          potentialGain: String(parsed.potentialGain ?? ''),
          confidence: Number(parsed.confidence) || 0,
          reason: String(parsed.reason ?? ''),
        },
      };
    } catch (e: any) {
      this.logger.error(`Failed to parse LLM JSON: ${e?.message}`);
      return { text: raw.trim(), signal: null };
    }
  }

  /** Parses '67,450.5', '$67450', '67450 USDT' → 67450.5 */
  parseNum(value: string): number {
    const cleaned = String(value).replace(/[^0-9.-]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : NaN;
  }

  /**
   * Last line of defence. Every rule the user called "demir" is enforced here
   * in code, not left to the model's goodwill.
   */
  validateSignal(
    signal: TradeSignal,
    market?: MarketOverview,
    balance?: number | null,
  ): { valid: boolean; reason?: string } {
    if (!signal.pair) return { valid: false, reason: 'Parite belirtilmemiş.' };

    const direction = signal.direction.toUpperCase();
    if (!['LONG', 'SHORT'].includes(direction)) {
      return { valid: false, reason: 'Yön LONG veya SHORT olmalı.' };
    }

    const entry = this.parseNum(signal.entry);
    const sl = this.parseNum(signal.stopLoss);
    const tp = this.parseNum(signal.takeProfit);

    if (!Number.isFinite(entry) || entry <= 0) {
      return { valid: false, reason: 'Giriş fiyatı okunamadı.' };
    }
    if (!Number.isFinite(sl) || sl <= 0) {
      return {
        valid: false,
        reason: 'Stop-loss eksik veya geçersiz. Stop-loss zorunlu.',
      };
    }
    if (!Number.isFinite(tp) || tp <= 0) {
      return {
        valid: false,
        reason: 'Take-profit eksik veya geçersiz. Take-profit zorunlu.',
      };
    }

    // A stop on the wrong side of entry is not a stop — it is an unbounded loss.
    if (direction === 'LONG' && !(sl < entry && entry < tp)) {
      return {
        valid: false,
        reason: `LONG için sıralama stop-loss < giriş < take-profit olmalı. Gelen: ${sl} / ${entry} / ${tp}`,
      };
    }
    if (direction === 'SHORT' && !(tp < entry && entry < sl)) {
      return {
        valid: false,
        reason: `SHORT için sıralama take-profit < giriş < stop-loss olmalı. Gelen: ${tp} / ${entry} / ${sl}`,
      };
    }

    const levMatch = signal.leverage.match(/(\d+(?:\.\d+)?)/);
    if (!levMatch) return { valid: false, reason: 'Kaldıraç okunamadı.' };
    const lev = parseFloat(levMatch[1]);
    if (lev < MIN_LEVERAGE || lev > MAX_LEVERAGE) {
      return {
        valid: false,
        reason: `Kaldıraç ${lev}x geçersiz. ${MIN_LEVERAGE}x-${MAX_LEVERAGE}x arası olmalı.`,
      };
    }

    if (balance !== null && balance !== undefined) {
      if (balance < MIN_BALANCE_USDT) {
        return {
          valid: false,
          reason: `Bakiye ${balance} USDT — kill switch sınırının altında.`,
        };
      }
      const margin = this.parseNum(signal.margin);
      if (Number.isFinite(margin) && margin > balance * MAX_POSITION_RATIO) {
        return {
          valid: false,
          reason:
            `Margin ${margin} USDT, bakiyenin %${MAX_POSITION_RATIO * 100}'sini ` +
            `(${(balance * MAX_POSITION_RATIO).toFixed(2)} USDT) aşıyor.`,
        };
      }
    }

    // Tradability, not popularity: the check is whether Binance Futures lists
    // the pair at all. Requiring top-50 volume rank used to reject perfectly
    // tradable coins, which blocked research on anything outside the busiest
    // fifty.
    if (market?.source === 'binance' && market.tradablePairs.length > 0) {
      if (!market.tradablePairs.includes(signal.pair)) {
        return {
          valid: false,
          reason: `${signal.pair} Binance Futures'ta işlem görmüyor.`,
        };
      }
    }

    return { valid: true };
  }

  private fmtPrice(price: number): string {
    if (!Number.isFinite(price)) return '0';
    if (price >= 1000)
      return price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (price >= 1) return price.toFixed(3);
    return price.toPrecision(4);
  }

  private async isDuplicateSignal(
    chatId: string,
    pair: string,
    direction: string,
  ): Promise<boolean> {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    const existing = await this.prisma.sent_signals.findFirst({
      where: {
        chat_id: chatId,
        pair: pair.toUpperCase(),
        direction: direction.toUpperCase(),
        created_at: { gte: fourHoursAgo },
      },
    });
    return !!existing;
  }

  async getBalance(chatId: string): Promise<number | null> {
    const state = await this.prisma.user_state.findUnique({
      where: { chat_id: chatId },
    });
    return state?.balance_usdt ?? null;
  }

  private async getUserInstructions(chatId: string): Promise<string[]> {
    const rows = await this.prisma.user_instructions.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((r) => r.instruction);
  }

  private async getChatHistory(
    chatId: string,
  ): Promise<{ role: string; content: string }[]> {
    const rows = await this.prisma.chat_history.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'desc' },
      take: 10,
    });
    return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
  }
}
