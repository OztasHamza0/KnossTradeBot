import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  TradeEngineService,
  TradeSignal,
  EngineResponse,
  MIN_BALANCE_USDT,
} from '../trade-engine/trade-engine.service';
import { MarketDataService } from '../market-data/market-data.service';
import axios from 'axios';

/** Telegram hard-caps a single sendMessage body at 4096 characters. */
const TELEGRAM_MAX_LEN = 4096;

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly botToken: string;
  private readonly apiBase: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tradeEngine: TradeEngineService,
    private readonly marketData: MarketDataService,
  ) {
    this.botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN') ?? '';
    this.apiBase = `https://api.telegram.org/bot${this.botToken}`;
    if (!this.botToken) {
      this.logger.error(
        'TELEGRAM_BOT_TOKEN tanimli degil — bot mesaj gonderemez.',
      );
    }
  }

  async processUpdate(update: any): Promise<void> {
    const message = update?.message ?? update?.edited_message;
    if (!message?.chat?.id) return;

    const chatId = String(message.chat.id);
    const text = (message.text ?? message.caption ?? '').trim();
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;

    await this.registerChat(chatId);

    try {
      // A photo is checked first: a screenshot captioned "tara" is a screenshot
      // request, not a market scan, and the image must not be dropped.
      if (hasPhoto) {
        await this.handlePhoto(chatId, message, text);
      } else if (text === '/start' || text === '/help' || text === 'yardim') {
        await this.handleStart(chatId);
      } else if (this.matchBalanceCommand(text) !== null) {
        await this.handleBalance(chatId, this.matchBalanceCommand(text)!);
      } else if (this.isRulesCommand(text)) {
        await this.handleShowRules(chatId);
      } else if (this.isDeleteRuleCommand(text)) {
        await this.handleDeleteRule(chatId, text);
      } else if (this.isScanCommand(text)) {
        await this.handleScan(chatId);
      } else if (this.isMarketCommand(text)) {
        await this.handleMarketOverview(chatId);
      } else if (text.length > 0) {
        await this.handleFreeChat(chatId, text);
      }
    } catch (error: any) {
      this.logger.error(
        `Error handling message from ${chatId}: ${error?.message}`,
        error?.stack,
      );
      await this.sendMessage(chatId, '❌ Bir hata oluştu, tekrar dene dostum!');
    }
  }

  // ---------------------------------------------------------------- commands

  /**
   * Turkish text is normalised to ASCII so a single pattern matches
   * "var mı?", "VAR MI" and "var mi".
   */
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .replace(/ı/g, 'i')
      .replace(/İ/g, 'i')
      .replace(/ş/g, 's')
      .replace(/ğ/g, 'g')
      .replace(/ü/g, 'u')
      .replace(/ö/g, 'o')
      .replace(/ç/g, 'c')
      .trim();
  }

  /**
   * Word-boundary matching, not substring. `includes('tara')` used to fire a
   * full market scan on the word "taraf".
   */
  private isScanCommand(text: string): boolean {
    const t = this.normalize(text);
    return (
      /\b(tara|taras[ai]n|tarama|scan)\b/.test(t) ||
      /\bvar mi\b/.test(t) ||
      /\bgirilir mi\b/.test(t) ||
      /\bfirsat var\b/.test(t)
    );
  }

  private isMarketCommand(text: string): boolean {
    const t = this.normalize(text);
    return /\b(piyasa|market|fiyat|fiyatlar|piyasa durumu)\b/.test(t);
  }

  private isRulesCommand(text: string): boolean {
    const t = this.normalize(text);
    return /^(kurallarim|kurallar|\/kurallar)$/.test(t);
  }

  private isDeleteRuleCommand(text: string): boolean {
    return /^kural sil/i.test(this.normalize(text));
  }

  /** Returns the parsed amount, NaN for a bare "bakiye" query, or null if not a balance command. */
  private matchBalanceCommand(text: string): number | null {
    const t = this.normalize(text);
    const m = t.match(/^(?:\/)?bakiye(?:m)?\s*([\d.,]+)?\s*(?:usdt)?$/);
    if (!m) return null;
    if (!m[1]) return NaN;
    return parseFloat(m[1].replace(/,/g, '.'));
  }

  // ---------------------------------------------------------------- handlers

  private async handleStart(chatId: string): Promise<void> {
    await this.sendMessage(
      chatId,
      `🚀 Selam trader! Ben senin kripto asistanınım.

📋 Neler yapabilirim:
• "tara" / "var mı?" / "girilir mi?" → Piyasa taraması + işlem sinyali
• "piyasa" → Güncel piyasa özeti
• "bakiye 100" → Bakiyeni kaydet (kill switch için ŞART)
• "bakiye" → Kayıtlı bakiyeni göster
• "kurallarım" → Kayıtlı kurallarını göster
• "kural sil 1" → Kural sil
• 📸 Ekran görüntüsü gönder → Analiz ederim

💡 Kalıcı talimat verebilirsin:
"Bundan sonra kaldıracı 5x geçme" → Kaydederim, her kararda uygularım

⏰ Saatte bir otomatik nöbet tutuyorum. Sert hareket ya da güçlü fırsat varsa
sen yazmadan haber veriyorum.

⚡ Kurallarım demir gibi:
✅ Her işlemde stop-loss + take-profit
✅ Sadece ISOLATED margin
✅ 1x-10x kaldıraç, margin bakiyenin max %50'si
✅ Bakiye ${MIN_BALANCE_USDT} USDT altına düşerse işlem YOK
✅ Emin değilsem işlem açmam

👉 İlk iş: "bakiye 100" yazıp bakiyeni kaydet. Haydi başlayalım! 💪🔥`,
    );
  }

  private async handleBalance(chatId: string, amount: number): Promise<void> {
    if (Number.isNaN(amount)) {
      const current = await this.tradeEngine.getBalance(chatId);
      await this.sendMessage(
        chatId,
        current === null
          ? '💰 Kayıtlı bakiyen yok. Kaydetmek için: "bakiye 100"'
          : `💰 Kayıtlı bakiyen: ${current} USDT` +
              (current < MIN_BALANCE_USDT
                ? `\n\n🛑 KILL SWITCH AKTİF — ${MIN_BALANCE_USDT} USDT altındasın, işlem açmıyorum.`
                : ''),
      );
      return;
    }

    if (!Number.isFinite(amount) || amount < 0) {
      await this.sendMessage(
        chatId,
        '❓ Geçerli bir miktar gir. Örnek: "bakiye 100"',
      );
      return;
    }

    await this.prisma.user_state.upsert({
      where: { chat_id: chatId },
      update: { balance_usdt: amount },
      create: { chat_id: chatId, balance_usdt: amount },
    });

    const maxMargin = (amount * 0.5).toFixed(2);
    await this.sendMessage(
      chatId,
      amount < MIN_BALANCE_USDT
        ? `💰 Bakiye kaydedildi: ${amount} USDT\n\n` +
            `🛑 KILL SWITCH AKTİF\n${MIN_BALANCE_USDT} USDT sınırının altındasın, ` +
            `kural gereği yeni işlem açmıyorum. Bakiye artınca tekrar yaz.`
        : `💰 Bakiye kaydedildi: ${amount} USDT\n` +
            `📏 Bundan sonra margin üst sınırın: ${maxMargin} USDT (bakiyenin %50'si)\n\n` +
            `Hazırız! "tara" yazıp başlayalım 💪`,
    );
  }

  private async handleScan(chatId: string): Promise<void> {
    await this.sendMessage(chatId, '🔍 50 coin taranıyor... Bekle biraz! ⏳');
    await this.saveChatMessage(
      chatId,
      'user',
      'Piyasa taraması yap ve fırsat varsa işlem kartı ver.',
    );

    const result = await this.tradeEngine.analyzeMarket(
      chatId,
      'Piyasa taraması yap. Listedeki 50 coini analiz et ve işleme girilecek bir fırsat ' +
        'varsa işlem kartı ver. Yoksa açıkça fırsat yok de.',
    );

    await this.deliverResult(chatId, result);
  }

  private async handleMarketOverview(chatId: string): Promise<void> {
    const market = await this.marketData.getMarketData();

    const line = (label: string, coin: any) =>
      coin
        ? `${label}: $${coin.current_price.toLocaleString('en-US')} ` +
          `(${coin.price_change_percentage_24h >= 0 ? '+' : ''}${coin.price_change_percentage_24h.toFixed(2)}%)`
        : `${label}: veri yok`;

    const movers = [...market.top50]
      .sort(
        (a, b) =>
          Math.abs(b.price_change_percentage_24h) -
          Math.abs(a.price_change_percentage_24h),
      )
      .slice(0, 5)
      .map(
        (c) =>
          `  ${c.symbol}: ${c.price_change_percentage_24h >= 0 ? '+' : ''}${c.price_change_percentage_24h.toFixed(2)}%`,
      )
      .join('\n');

    const sourceLabel =
      market.source === 'binance'
        ? 'Binance Futures'
        : market.source === 'coingecko'
          ? 'CoinGecko (Binance erişilemedi)'
          : 'YOK';

    await this.sendMessage(
      chatId,
      `📊 PİYASA DURUMU\n\n` +
        `${line('₿ BTC', market.btc)}\n` +
        `${line('⟠ ETH', market.eth)}\n` +
        `${line('◎ SOL', market.sol)}\n\n` +
        `😱 Fear & Greed: ${
          market.fearGreed
            ? `${market.fearGreed.value}/100 (${market.fearGreed.classification})`
            : 'veri yok'
        }\n\n` +
        `🔥 24s en hareketliler:\n${movers || '  veri yok'}\n\n` +
        `📡 Kaynak: ${sourceLabel}\n` +
        `⏰ ${new Date(market.fetchedAt).toLocaleTimeString('tr-TR')}` +
        (market.warnings.length
          ? `\n\n⚠️ ${market.warnings.join('\n⚠️ ')}`
          : ''),
    );
  }

  private async handleShowRules(chatId: string): Promise<void> {
    const rules = await this.prisma.user_instructions.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'asc' },
    });

    if (rules.length === 0) {
      await this.sendMessage(
        chatId,
        '📋 Kayıtlı kuralın yok. Bana bir talimat ver, kaydedeyim!\nÖrnek: "Bundan sonra kaldıracı 3x geçme"',
      );
      return;
    }

    await this.sendMessage(
      chatId,
      `📋 Kayıtlı Kuralların:\n\n${rules.map((r, i) => `${i + 1}. ${r.instruction}`).join('\n')}\n\n` +
        `Silmek için: "kural sil 1"`,
    );
  }

  private async handleDeleteRule(chatId: string, text: string): Promise<void> {
    const match = text.match(/(\d+)/);
    if (!match) {
      await this.sendMessage(
        chatId,
        '❓ Hangi kuralı silmek istiyorsun? Numara ver.\nÖrnek: "kural sil 1"',
      );
      return;
    }

    const rules = await this.prisma.user_instructions.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'asc' },
    });
    const index = parseInt(match[1], 10) - 1;

    if (index < 0 || index >= rules.length) {
      await this.sendMessage(
        chatId,
        rules.length === 0
          ? '📋 Silinecek kuralın yok.'
          : `❌ Geçersiz numara. 1-${rules.length} arası gir.`,
      );
      return;
    }

    await this.prisma.user_instructions.delete({
      where: { id: rules[index].id },
    });
    await this.sendMessage(
      chatId,
      `✅ Kural silindi: "${rules[index].instruction}"`,
    );
  }

  private async handlePhoto(
    chatId: string,
    message: any,
    caption: string,
  ): Promise<void> {
    await this.sendMessage(
      chatId,
      '📸 Ekran görüntüsü alındı, analiz ediyorum... ⏳',
    );

    try {
      const photo = message.photo[message.photo.length - 1];
      const fileResp = await axios.get(`${this.apiBase}/getFile`, {
        params: { file_id: photo.file_id },
        timeout: 20000,
      });
      const filePath = fileResp.data?.result?.file_path;

      if (!filePath) {
        await this.sendMessage(
          chatId,
          '❌ Fotoğraf indirilemedi, tekrar gönder.',
        );
        return;
      }

      const imageResp = await axios.get(
        `https://api.telegram.org/file/bot${this.botToken}/${filePath}`,
        { responseType: 'arraybuffer', timeout: 30000 },
      );
      const imageBase64 = Buffer.from(imageResp.data).toString('base64');

      const prompt = caption || 'Bu ekran görüntüsünü analiz et.';
      await this.saveChatMessage(chatId, 'user', `[Ekran görüntüsü] ${prompt}`);

      const result = await this.tradeEngine.analyzeMarket(
        chatId,
        prompt,
        imageBase64,
      );
      await this.deliverResult(chatId, result);
    } catch (error: any) {
      this.logger.error(`Error processing photo: ${error?.message}`);
      await this.sendMessage(
        chatId,
        '❌ Görsel analizi sırasında hata oluştu, tekrar dene.',
      );
    }
  }

  private async handleFreeChat(chatId: string, text: string): Promise<void> {
    if (this.looksLikePersistentInstruction(text)) {
      await this.prisma.user_instructions.create({
        data: { chat_id: chatId, instruction: text },
      });
      await this.sendMessage(
        chatId,
        `✅ Kural kaydedildi: "${text}"\nBundan sonra her analizde bunu uygulayacağım! 💪\n\n` +
          `(Yanlışsa: "kural sil" + numara)`,
      );
      return;
    }

    await this.saveChatMessage(chatId, 'user', text);
    const result = await this.tradeEngine.analyzeMarket(chatId, text);
    await this.deliverResult(chatId, result);
  }

  /**
   * Only treats a message as a standing rule when it carries an explicit
   * directive marker. The old patterns matched bare words like "asla" and
   * "girme", so questions such as "ETH'ye girme zamanı mı?" were silently
   * stored as permanent rules.
   */
  private looksLikePersistentInstruction(text: string): boolean {
    const t = this.normalize(text);

    // A question is a question, never a rule.
    if (t.endsWith('?')) return false;

    const directivePrefix =
      /(bundan sonra|su andan itibaren|her zaman|artik|kural[:s]?|talimat)/;
    const imperative =
      /\b(gecme|gecmeyeceksin|kullanma|acma|girme|yapma|olsun|uygula|dikkat et|unutma|hatirla)\b/;

    return directivePrefix.test(t) && imperative.test(t);
  }

  // ----------------------------------------------------------------- output

  /** Single path for formatting, persisting and sending an engine result. */
  private async deliverResult(
    chatId: string,
    result: EngineResponse,
  ): Promise<void> {
    let responseText = result.text;

    if (result.signal) {
      const card = this.formatTradeCard(result.signal);
      responseText = result.text ? `${result.text}\n\n${card}` : card;

      await this.prisma.sent_signals.create({
        data: {
          chat_id: chatId,
          pair: result.signal.pair.toUpperCase(),
          direction: result.signal.direction.toUpperCase(),
          entry_price: this.tradeEngine.parseNum(result.signal.entry) || 0,
        },
      });
    }

    if (!responseText.trim()) return;

    await this.sendMessage(chatId, responseText);
    await this.saveChatMessage(chatId, 'assistant', responseText);
  }

  formatTradeCard(signal: TradeSignal): string {
    const dirIcon = signal.direction.toUpperCase() === 'LONG' ? '🔼' : '🔽';
    return `🎯 İŞLEM KARTI

📊 Parite: ${signal.pair}
${dirIcon} Yön: ${signal.direction.toUpperCase()}
⚡ Kaldıraç: ${signal.leverage} (ISOLATED)
💰 Margin: ${signal.margin}
📍 Giriş: ${signal.entry}
🛑 Stop-Loss: ${signal.stopLoss}
✅ Take-Profit: ${signal.takeProfit}
📈 Potansiyel Kazanç: ${signal.potentialGain}
🎯 Güven Skoru: ${signal.confidence}/10
📝 Gerekçe: ${signal.reason}

⚠️ Emirleri ISOLATED modda ve stop-loss ile birlikte gir.`;
  }

  /**
   * Sends as plain text and splits at Telegram's 4096-char cap. Markdown mode
   * is deliberately not used: model output routinely contains stray * and _
   * characters, and a parse failure would drop the whole message.
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    for (const chunk of this.splitMessage(text)) {
      try {
        await axios.post(
          `${this.apiBase}/sendMessage`,
          { chat_id: chatId, text: chunk, disable_web_page_preview: true },
          { timeout: 20000 },
        );
      } catch (error: any) {
        const status = error?.response?.status;
        const description =
          error?.response?.data?.description ?? error?.message;
        this.logger.error(
          `sendMessage to ${chatId} failed (${status}): ${description}`,
        );

        // The user blocked the bot or deleted the chat — stop the hourly watch
        // from retrying this chat forever.
        if (status === 403) {
          await this.prisma.active_chats
            .deleteMany({ where: { chat_id: chatId } })
            .catch(() => undefined);
          this.logger.warn(`Chat ${chatId} deactivated (bot blocked)`);
        }
        return;
      }
    }
  }

  private splitMessage(text: string): string[] {
    if (text.length <= TELEGRAM_MAX_LEN) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > TELEGRAM_MAX_LEN) {
      // Prefer a line break so trade cards are not cut mid-field.
      let cut = remaining.lastIndexOf('\n', TELEGRAM_MAX_LEN);
      if (cut < TELEGRAM_MAX_LEN * 0.5) cut = TELEGRAM_MAX_LEN;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) chunks.push(remaining);

    return chunks;
  }

  /** Registers this deployment's URL with Telegram. Called on boot from main.ts. */
  async setWebhook(url: string): Promise<void> {
    const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
    const resp = await axios.post(
      `${this.apiBase}/setWebhook`,
      {
        url,
        // Anything else (channel posts, polls) would just be discarded.
        allowed_updates: ['message', 'edited_message'],
        drop_pending_updates: true,
        ...(secret ? { secret_token: secret } : {}),
      },
      { timeout: 20000 },
    );

    if (!resp.data?.ok) {
      throw new Error(resp.data?.description ?? 'setWebhook basarisiz');
    }
  }

  // ------------------------------------------------------------- persistence

  private async registerChat(chatId: string): Promise<void> {
    await this.prisma.active_chats.upsert({
      where: { chat_id: chatId },
      update: {},
      create: { chat_id: chatId },
    });
  }

  private async saveChatMessage(
    chatId: string,
    role: string,
    content: string,
  ): Promise<void> {
    await this.prisma.chat_history.create({
      data: { chat_id: chatId, role, content },
    });

    const count = await this.prisma.chat_history.count({
      where: { chat_id: chatId },
    });
    if (count > 50) {
      const oldest = await this.prisma.chat_history.findMany({
        where: { chat_id: chatId },
        orderBy: { created_at: 'asc' },
        take: count - 50,
        select: { id: true },
      });
      await this.prisma.chat_history.deleteMany({
        where: { id: { in: oldest.map((r) => r.id) } },
      });
    }
  }
}
