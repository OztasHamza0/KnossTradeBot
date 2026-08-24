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

/** Ucuz nobet modelinin urettigi sinyale ana modelin verdigi karar. */
export interface SignalReview {
  verdict: 'approve' | 'revise' | 'reject';
  /** reject ise null; revise ise duzeltilmis kart. */
  signal: TradeSignal | null;
  comment: string;
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
  /**
   * The provider is configurable because the request body is plain
   * OpenAI-compatible chat/completions — Abacus, Gemini's compatibility
   * layer, Groq, OpenRouter and others all accept the same shape. If one
   * runs out of quota the bot moves to another by changing env vars only.
   */
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  /** Ucuz tarama modeli; sinyal cikarsa ana model dogruluyor. */
  private readonly watchModel: string;
  private readonly maxTokens: number;
  /** How many coins reach the prompt. Fewer coins, fewer input tokens. */
  private readonly promptCoinCount: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {
    this.apiUrl =
      this.config.get<string>('LLM_API_URL') ??
      'https://apps.abacus.ai/v1/chat/completions';
    // ABACUSAI_API_KEY stays as a fallback so existing deployments keep working.
    this.apiKey =
      this.config.get<string>('LLM_API_KEY') ??
      this.config.get<string>('ABACUSAI_API_KEY') ??
      '';
    this.model = this.config.get<string>('LLM_MODEL') ?? 'claude-fable-5';
    // Nobet taramalarinin buyuk cogunlugu "firsat yok" ile bitiyor; o
    // gecislere pahali model harcamanin karsiligi yok. Tanimli degilse
    // ayrim kapanir ve her sey ana modele gider.
    this.watchModel = this.config.get<string>('LLM_MODEL_WATCH') ?? this.model;
    this.maxTokens = parseInt(
      this.config.get<string>('LLM_MAX_TOKENS') ?? '4000',
      10,
    );
    this.promptCoinCount = Math.min(
      Math.max(
        parseInt(this.config.get<string>('PROMPT_COIN_COUNT') ?? '50', 10),
        5,
      ),
      50,
    );
    this.logger.log(
      `LLM: karar=${this.model} nobet=${this.watchModel} @ ` +
        `${new URL(this.apiUrl).host} | ${this.promptCoinCount} coin, ` +
        `max ${this.maxTokens} token`,
    );
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
        raw = await this.callLLM(
          this.buildMessages(systemPrompt, [], userMsg),
          this.watchModel,
        );
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
          // Escalation: the watch found something, so the decision model
          // reviews it before the user ever sees a card. This is the only
          // place the expensive model runs during a watch pass.
          const review = await this.reviewSignal(
            parsed.signal,
            market,
            instructions,
            balance,
          );

          if (review.verdict === 'reject' || !review.signal) {
            reason = `İkinci değerlendirmede elendi: ${review.comment || 'gerekçe belirtilmedi'}`;
            this.logger.log(`Review rejected signal: ${review.comment}`);
          } else {
            // A revised card is not trusted either — it goes through the same
            // hard rules as the original.
            const reValidation = this.validateSignal(
              review.signal,
              market,
              balance,
            );

            if (!reValidation.valid) {
              reason =
                `İkinci değerlendirme kartı düzeltti ama düzeltilmiş hali ` +
                `güvenlik kontrolünden geçemedi: ${reValidation.reason}`;
              this.logger.warn(
                `Revised signal failed validation: ${reValidation.reason}`,
              );
            } else {
              const note =
                review.verdict === 'revise'
                  ? `\n\n🔎 İkinci değerlendirme kartı düzeltti: ${review.comment}`
                  : review.comment
                    ? `\n\n🔎 İkinci değerlendirme onayladı: ${review.comment}`
                    : '';

              deliverable = {
                text: parsed.text + note,
                signal: review.signal,
              };
              reason =
                review.verdict === 'revise'
                  ? 'Sinyal düzeltilerek gönderildi.'
                  : 'Sinyal gönderildi (ikinci değerlendirmeden geçti).';
            }
          }
        }
      }

      if (deliverable.signal || alert || diagnostic) {
        results.push({ chatId, response: deliverable, alert, reason });
      }
    }

    return results;
  }

  /**
   * Second opinion on a watch signal.
   *
   * The watch runs on a cheap model because the overwhelming majority of
   * passes end in "no opportunity" — spending a premium model on those is
   * waste. But the rare pass that *does* produce a card is exactly where the
   * user acts with real money, so that one gets reviewed by the decision
   * model before it ever reaches Telegram.
   *
   * The reviewer may approve, revise, or reject. A revised card is re-run
   * through validateSignal by the caller like any other — the review is a
   * quality gate, not a bypass.
   */
  async reviewSignal(
    signal: TradeSignal,
    market: MarketOverview,
    instructions: string[],
    balance: number | null,
  ): Promise<SignalReview> {
    // No separate reviewer configured — the watch already ran on the
    // decision model, so a second pass would just cost twice.
    if (this.watchModel === this.model) {
      return { verdict: 'approve', signal, comment: '' };
    }

    const coin = market.top50.find((c) => c.pair === signal.pair);
    const coinLine = coin
      ? `${coin.pair}: $${this.fmtPrice(coin.current_price)} | ` +
        `24s ${coin.price_change_percentage_24h.toFixed(2)}% | ` +
        `1s ${coin.price_change_percentage_1h.toFixed(2)}% | ` +
        `hacim $${(coin.total_volume / 1e6).toFixed(0)}M`
      : `${signal.pair}: hacim listesinde yok`;

    const others = market.top50
      .slice(0, 15)
      .map(
        (c) =>
          `${c.symbol} ${c.price_change_percentage_24h >= 0 ? '+' : ''}${c.price_change_percentage_24h.toFixed(1)}%`,
      )
      .join(', ');

    const instructionsBlock = instructions.length
      ? `\n\nKULLANICININ KALICI TALİMATLARI:\n${instructions.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
      : '';

    const systemPrompt = `Sen deneyimli bir risk yöneticisisin. Daha küçük bir model bir işlem
önerisi üretti. Senin işin bunu onaylamak, düzeltmek ya da reddetmek.

Sen fırsat aramıyorsun — önüne gelen öneriyi denetliyorsun. Şüpheci ol.
Kullanıcı bu kartla GERÇEK PARA koyacak.

📋 ÖNERİLEN İŞLEM:
Parite      : ${signal.pair}
Yön         : ${signal.direction}
Kaldıraç    : ${signal.leverage}
Margin      : ${signal.margin}
Giriş       : ${signal.entry}
Stop-loss   : ${signal.stopLoss}
Take-profit : ${signal.takeProfit}
Güven       : ${signal.confidence}/10
Gerekçe     : ${signal.reason}

📊 PARİTENİN GÜNCEL DURUMU:
${coinLine}

🌍 PİYASA: BTC ${market.btc ? `$${this.fmtPrice(market.btc.current_price)} (${market.btc.price_change_percentage_24h.toFixed(1)}%)` : '?'} | Fear & Greed ${market.fearGreed?.value ?? '?'}
İlk 15: ${others}

💰 Bakiye: ${balance ?? 'bildirilmemiş'} USDT${instructionsBlock}

🔍 NELERİ SORGULA:
1. Giriş mantıklı mı, yoksa hareket zaten olmuş da kovalamaca mı oluyor?
2. Stop-loss yerinde mi — çok sıkı (gürültüde süpürülür) ya da çok geniş mi?
3. Risk/ödül oranı işe değer mi? En az 1:1.5 olmalı.
4. Take-profit gerçekçi mi, yoksa hayal mi?
5. Kaldıraç bu volatiliteye uygun mu?
6. Gerekçe verilerle tutarlı mı, uydurma bir hikaye mi?

⚖️ KARARIN:
- "approve" → öneri sağlam, olduğu gibi geçsin
- "revise"  → fikir doğru ama rakamlar düzeltilmeli (stop/hedef/kaldıraç)
- "reject"  → bu işlem açılmamalı

Reddetmekten çekinme. En iyi işlem çoğu zaman yapmadığın işlemdir.

Cevabını SADECE şu JSON ile ver:
\`\`\`json
{
  "verdict": "approve",
  "comment": "Türkçe, tek iki cümle gerekçe",
  "pair": "${signal.pair}",
  "direction": "${signal.direction}",
  "leverage": "${signal.leverage}",
  "margin": "${signal.margin}",
  "entry": "${signal.entry}",
  "stopLoss": "${signal.stopLoss}",
  "takeProfit": "${signal.takeProfit}",
  "potentialGain": "${signal.potentialGain}",
  "confidence": ${signal.confidence},
  "reason": "kısa gerekçe"
}
\`\`\`
verdict "revise" ise rakamları değiştir. "reject" ise rakamlar önemsiz,
sadece comment'te neden reddettiğini yaz.`;

    let raw: string;
    try {
      raw = await this.callLLM(
        [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: 'Bu işlem önerisini denetle ve kararını ver.',
          },
        ],
        this.model,
      );
    } catch (error: any) {
      // The reviewer is a quality gate, not a safety gate — validateSignal
      // still runs either way. Letting the card through on a reviewer outage
      // is better than silently swallowing every signal.
      this.logger.error(`Signal review failed: ${error?.message}`);
      return {
        verdict: 'approve',
        signal,
        comment: '(İkinci değerlendirme yapılamadı, kart ilk haliyle geçti.)',
      };
    }

    return this.parseReview(raw, signal);
  }

  parseReview(raw: string, original: TradeSignal): SignalReview {
    const fenced = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const bare = fenced ? null : raw.match(/\{[\s\S]*"verdict"[\s\S]*?\}/);
    const jsonText = fenced?.[1] ?? bare?.[0];

    if (!jsonText) {
      this.logger.warn('Review response had no JSON; approving unchanged');
      return {
        verdict: 'approve',
        signal: original,
        comment: raw.trim().slice(0, 300),
      };
    }

    try {
      const p = JSON.parse(jsonText);
      const verdict =
        p.verdict === 'reject'
          ? 'reject'
          : p.verdict === 'revise'
            ? 'revise'
            : 'approve';
      const comment = String(p.comment ?? '').trim();

      if (verdict === 'reject') {
        return { verdict, signal: null, comment };
      }

      // approve and revise both carry a full card; revise changed the numbers.
      return {
        verdict,
        signal: {
          pair: String(p.pair ?? original.pair).toUpperCase(),
          direction: String(p.direction ?? original.direction).toUpperCase(),
          leverage: String(p.leverage ?? original.leverage),
          margin: String(p.margin ?? original.margin),
          entry: String(p.entry ?? original.entry),
          stopLoss: String(p.stopLoss ?? original.stopLoss),
          takeProfit: String(p.takeProfit ?? original.takeProfit),
          potentialGain: String(p.potentialGain ?? original.potentialGain),
          confidence: Number(p.confidence) || original.confidence,
          reason: String(p.reason ?? original.reason),
        },
        comment,
      };
    } catch (e: any) {
      this.logger.error(`Review JSON parse failed: ${e?.message}`);
      return { verdict: 'approve', signal: original, comment: '' };
    }
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

    // The model was asked to scan the list, so it must actually see the list.
    // The count is configurable: trimming it is the cheapest way to cut input
    // tokens when a provider's quota gets tight.
    const coinTable = market.top50
      .slice(0, this.promptCoinCount)
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

📋 HACME GÖRE TOP ${this.promptCoinCount}:
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

  private async callLLM(messages: any[], model = this.model): Promise<string> {
    if (!this.apiKey) {
      throw new Error('LLM_API_KEY (veya ABACUSAI_API_KEY) tanimli degil');
    }

    const resp = await axios.post(
      this.apiUrl,
      {
        model,
        messages,
        stream: false,
        // Fable spends tokens on reasoning before it writes, so the ceiling
        // has to clear both the thinking and the answer.
        max_tokens: this.maxTokens,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
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
