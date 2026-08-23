import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import {
  TradeEngineService,
  TradeSignal,
  EngineResponse,
  MIN_BALANCE_USDT,
} from '../trade-engine/trade-engine.service';
import {
  MarketDataService,
  CoinResearch,
} from '../market-data/market-data.service';
import {
  MIN_SCAN_INTERVAL,
  MAX_SCAN_INTERVAL,
  DEFAULT_SCAN_INTERVAL,
} from '../auto-scan/auto-scan.constants';
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
      } else if (
        text === '/start' ||
        text === '/help' ||
        text === '/yardim' ||
        text === 'yardim' ||
        text === 'yardım'
      ) {
        await this.handleStart(chatId);
      } else if (this.matchBalanceCommand(text) !== null) {
        await this.handleBalance(chatId, this.matchBalanceCommand(text)!);
      } else if (this.isWatchCommand(text)) {
        await this.handleWatch(chatId, text);
      } else if (this.isResearchCommand(text)) {
        await this.handleResearch(chatId, text);
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

  private isWatchCommand(text: string): boolean {
    return /^(?:\/)?nobet\b/.test(this.normalize(text));
  }

  /**
   * "nobet"        -> mevcut ayari goster
   * "nobet 30dk"   -> 30 dakikada bir
   * "nobet 2 saat" -> 120 dakikada bir
   * "nobet kapat"  -> otomatik nobeti durdur
   * Donen deger dakikadir; 0 = kapat, -1 = ac, null = anlasilmadi.
   */
  parseWatchArg(text: string): number | null {
    const arg = this.normalize(text)
      .replace(/^(?:\/)?nobet\s*/, '')
      .trim();

    if (!arg) return NaN; // argumansiz -> durumu goster
    if (/^(kapat|kapali|dur|durdur|iptal|off)$/.test(arg)) return 0;
    if (/^(ac|acik|basla|baslat|on|devam)$/.test(arg)) return -1;

    const m = arg.match(/^(\d+)\s*(saat|sa|s|dakika|dakka|dak|dk|d|min|m)?$/);
    if (!m) return null;

    const value = parseInt(m[1], 10);
    const unit = m[2] ?? 'dk';
    // Birim yazilmazsa dakika kabul edilir.
    const isHours = /^(saat|sa|s)$/.test(unit);
    return isHours ? value * 60 : value;
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
• "nöbet 30dk" → Otomatik tarama aralığını değiştir
• "nöbet kapat" → Otomatik taramayı durdur
• "nöbet test" → Nöbeti şimdi çalıştır, sonucu raporla
• "araştır PEPE" → Bir coini derinlemesine incele
• 📸 Ekran görüntüsü gönder → Analiz ederim

💡 Kalıcı talimat verebilirsin:
"Bundan sonra kaldıracı 5x geçme" → Kaydederim, her kararda uygularım

⏰ Varsayılan olarak saatte bir nöbet tutuyorum. Sert hareket ya da güçlü
fırsat varsa sen yazmadan haber veriyorum. Aralığı "nöbet 30dk" ile
değiştirebilir, "nöbet kapat" ile durdurabilirsin.

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

  /**
   * "araştır PEPE", "incele SOL", "/arastir bonk"
   *
   * Deliberately requires a verb: a bare coin name would collide with ordinary
   * chat ("BTC bugün nasıl") and hijack it into a research fetch.
   */
  isResearchCommand(text: string): boolean {
    return /^(?:\/)?(arastir|arastır|incele|analiz|arastirma)\s+\S+/.test(
      this.normalize(text),
    );
  }

  /** Returns the coin name the user asked about, or null. */
  parseResearchQuery(text: string): string | null {
    const m = text
      .trim()
      .match(/^(?:\/)?(?:ara[sş]t[iı]r(?:ma)?|incele|analiz)\s+(.+)$/i);
    if (!m) return null;

    const query = m[1]
      // "PEPE coinini araştır" gibi eklerden arındır
      .replace(/\b(coin|coini|coinini|token|tokeni|hakkinda|hakkında)\b/gi, '')
      .replace(/[?!.]+$/, '')
      .trim();

    return query.length > 0 && query.length <= 40 ? query : null;
  }

  private async handleResearch(chatId: string, text: string): Promise<void> {
    const query = this.parseResearchQuery(text);
    if (!query) {
      await this.sendMessage(
        chatId,
        `❓ Hangi coini araştırayım?\n\nÖrnek: "araştır PEPE" · "incele SOL"`,
      );
      return;
    }

    await this.sendMessage(
      chatId,
      `🔬 ${query.toUpperCase()} araştırılıyor... Veri topluyorum, biraz sürebilir. ⏳`,
    );

    let research: Awaited<ReturnType<MarketDataService['researchCoin']>>;
    try {
      research = await this.marketData.researchCoin(query);
    } catch (error: any) {
      const status = error?.response?.status;
      this.logger.error(
        `researchCoin failed for "${query}" (${status}): ${error?.message}`,
      );
      await this.sendMessage(
        chatId,
        status === 429
          ? '⏳ CoinGecko hız limitine takıldık (ücretsiz katman). Bir dakika bekleyip tekrar dene.'
          : '❌ Coin verisi çekilemedi. Birazdan tekrar dene.',
      );
      return;
    }

    if (!research) {
      await this.sendMessage(
        chatId,
        `🤷 "${query}" diye bir coin bulamadım.\n\n` +
          `Sembolünü ya da tam adını yazmayı dene: "araştır PEPE", "araştır bitcoin"`,
      );
      return;
    }

    await this.saveChatMessage(chatId, 'user', `[Araştırma] ${query}`);

    const result = await this.tradeEngine.analyzeCoin(
      chatId,
      research,
      `${query} adlı coini araştır ve incele. Yatırım/işlem için mantıklı mı, ` +
        `dürüstçe değerlendir. Riskleri de söyle.`,
    );

    // Ham veriyi ayrica gonderiyoruz: modelin yorumu degisebilir ama
    // sayilar sabit kalir ve kullanici kendi karsilastirmasini yapabilir.
    await this.sendMessage(chatId, this.formatResearchCard(research));
    await this.deliverResult(chatId, result);
  }

  formatResearchCard(r: CoinResearch): string {
    const big = (n: number) =>
      n >= 1e9
        ? `$${(n / 1e9).toFixed(2)}Mr`
        : n >= 1e6
          ? `$${(n / 1e6).toFixed(1)}M`
          : `$${n.toFixed(0)}`;
    const pct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
    const supply = (n: number | null) => {
      if (!n) return '—';
      if (n >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}Mr`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
      return String(Math.round(n));
    };

    return `🔬 ${r.name} (${r.symbol})${r.marketCapRank ? ` · #${r.marketCapRank}` : ''}

💵 Fiyat: $${r.price}
🏦 Piyasa değeri: ${big(r.marketCap)}
📊 24s hacim: ${big(r.volume24h)}
📈 24s ${pct(r.change24h)} · 7g ${pct(r.change7d)} · 30g ${pct(r.change30d)}
🔝 ATH: $${r.ath} (${pct(r.athChangePct)} uzakta)
🪙 Dolaşan: ${supply(r.circulatingSupply)} / Toplam: ${supply(r.totalSupply)}
🏷️ ${r.categories.slice(0, 4).join(', ') || 'kategori yok'}
${r.futuresPair ? `✅ Binance Futures: ${r.futuresPair}` : "⛔ Binance Futures'ta yok — kaldıraçlı işlem açılamaz"}${
      r.alternatives.length
        ? `\n\n❓ Bunu mu kastettin? Başka eşleşmeler: ${r.alternatives.map((a) => a.symbol).join(', ')}`
        : ''
    }`;
  }

  isWatchTestCommand(text: string): boolean {
    return /^(?:\/)?nobet\s+(test|dene|simdi)$/.test(this.normalize(text));
  }

  /**
   * "nöbet test" — otomatik nöbet turunu simdi calistirir ve SONUCU HER ZAMAN
   * bildirir. Normal nöbet sadece soyleyecek bir sey varsa konusuyor; bu
   * yuzden sessizlik "calisiyor ama firsat yok" ile "bozuk" arasinda ayirt
   * edilemiyordu. Bu komut o farki gosterir.
   */
  private async handleWatchTest(chatId: string): Promise<void> {
    await this.sendMessage(
      chatId,
      '🧪 Otomatik nöbet turu şimdi çalıştırılıyor... 30-90 saniye sürebilir.',
    );

    const state = await this.tradeEngine.describeMarketState();

    const sourceLabel =
      state.source === 'binance'
        ? 'Binance Futures ✅'
        : state.source === 'coingecko'
          ? 'CoinGecko (Binance erişilemedi) ⚠️'
          : 'YOK ❌';

    const moversText = state.sharpMovers.length
      ? state.sharpMovers
          .slice(0, 8)
          .map(
            (m) =>
              `  ${m.symbol}: ${m.change1h >= 0 ? '+' : ''}${m.change1h.toFixed(2)}%`,
          )
          .join('\n')
      : '  yok (hiçbir coin son 1 saatte %5 hareket etmemiş)';

    const results = await this.tradeEngine.analyzeForAutoScan([chatId], true);
    const result = results[0];

    // Gercek nobet turunda gonderilecek olan mesajlar aynen gonderilir.
    if (result?.alert) {
      await this.sendMessage(chatId, result.alert);
    }
    if (result?.response.signal) {
      const card = this.formatTradeCard(result.response.signal);
      await this.sendMessage(
        chatId,
        `🔔 OTOMATİK NÖBET SİNYALİ\n\n${result.response.text ? `${result.response.text}\n\n` : ''}${card}`,
      );
    }

    const wouldSend = Boolean(result?.alert || result?.response.signal);

    await this.sendMessage(
      chatId,
      `🧪 NÖBET TESTİ SONUCU

📡 Veri kaynağı: ${sourceLabel}
🪙 Taranan coin: ${state.coinCount}
😱 Fear & Greed: ${state.fearGreed ?? 'veri yok'}
⏰ Veri zamanı: ${new Date(state.fetchedAt).toLocaleTimeString('tr-TR')}

⚡ Sert hareket edenler (1s > %5):
${moversText}

🤖 Model sonucu:
  ${result?.reason ?? 'sonuç alınamadı'}

${
  wouldSend
    ? '✅ Bu tur mesaj ÜRETTİ — yukarıda gördün.'
    : '🔇 Bu tur mesaj üretmedi. Bu NORMAL: otomatik nöbet sadece %5+ hareket ya da güven 7+ fırsat varsa konuşur.'
}

Zincir çalışıyor: veri → model → güvenlik kontrolü → Telegram.`,
    );
  }

  private async handleWatch(chatId: string, text: string): Promise<void> {
    if (this.isWatchTestCommand(text)) {
      await this.handleWatchTest(chatId);
      return;
    }

    const minutes = this.parseWatchArg(text);

    if (minutes === null) {
      await this.sendMessage(
        chatId,
        `❓ Anlamadım. Örnekler:
• "nöbet 30dk"
• "nöbet 2 saat"
• "nöbet kapat"
• "nöbet" (durumu göster)`,
      );
      return;
    }

    // Argümansız "nöbet" → mevcut ayarı göster
    if (Number.isNaN(minutes)) {
      const state = await this.prisma.user_state.findUnique({
        where: { chat_id: chatId },
      });
      const interval = state?.scan_interval_minutes ?? DEFAULT_SCAN_INTERVAL;
      const enabled = state?.scan_enabled ?? true;
      const last = state?.last_scan_at;

      await this.sendMessage(
        chatId,
        enabled
          ? `⏰ Otomatik nöbet AÇIK

Aralık: ${this.formatInterval(interval)}
Son tarama: ${last ? last.toLocaleString('tr-TR') : 'henüz yapılmadı'}

Değiştirmek için: "nöbet 30dk"
Kapatmak için: "nöbet kapat"`
          : `⏸️ Otomatik nöbet KAPALI

Kayıtlı aralık: ${this.formatInterval(interval)}

Açmak için: "nöbet aç"`,
      );
      return;
    }

    if (minutes === 0) {
      await this.prisma.user_state.upsert({
        where: { chat_id: chatId },
        update: { scan_enabled: false },
        create: { chat_id: chatId, scan_enabled: false },
      });
      await this.sendMessage(
        chatId,
        `⏸️ Otomatik nöbet kapatıldı. Artık sen yazmadan tarama yapmayacağım.

Açmak için: "nöbet aç"`,
      );
      return;
    }

    if (minutes === -1) {
      const state = await this.prisma.user_state.upsert({
        where: { chat_id: chatId },
        update: { scan_enabled: true },
        create: { chat_id: chatId, scan_enabled: true },
      });
      await this.sendMessage(
        chatId,
        `▶️ Otomatik nöbet açıldı. Aralık: ${this.formatInterval(state.scan_interval_minutes)}`,
      );
      return;
    }

    if (minutes < MIN_SCAN_INTERVAL || minutes > MAX_SCAN_INTERVAL) {
      await this.sendMessage(
        chatId,
        `❌ Aralık ${MIN_SCAN_INTERVAL} dakika ile ${this.formatInterval(MAX_SCAN_INTERVAL)} arasında olmalı.

Her tarama bir yapay zeka çağrısı demek — çok sık ayarlamak kotanı yakar, üstelik piyasa o kadar hızlı değişmez.`,
      );
      return;
    }

    await this.prisma.user_state.upsert({
      where: { chat_id: chatId },
      update: { scan_interval_minutes: minutes, scan_enabled: true },
      create: {
        chat_id: chatId,
        scan_interval_minutes: minutes,
        scan_enabled: true,
      },
    });

    const perDay = Math.round(1440 / minutes);
    const warning =
      minutes < 30
        ? `

⚠️ Sıkı tempo. Aynı fırsatı tekrar göndermem (4 saat spam koruması var) ama yapay zeka kotan hızlı erir.`
        : '';

    await this.sendMessage(
      chatId,
      `✅ Otomatik nöbet ${this.formatInterval(minutes)} olarak ayarlandı.
Günde ~${perDay} tarama yapacağım.${warning}`,
    );
  }

  private formatInterval(minutes: number): string {
    if (minutes >= 60 && minutes % 60 === 0) {
      return `${minutes / 60} saat`;
    }
    return `${minutes} dakika`;
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

  /**
   * Fills Telegram's "/" menu. Done from code rather than by hand in BotFather
   * so the menu cannot drift away from what the bot actually accepts.
   *
   * Command names must be lowercase a-z, 0-9 and _ only — hence "nobet" and
   * "yardim" without Turkish characters. The handlers normalise anyway, so
   * typing "nöbet" still works.
   */
  async setMyCommands(): Promise<void> {
    const commands = [
      { command: 'tara', description: 'Piyasayı tara, işlem fırsatı ara' },
      { command: 'piyasa', description: 'Güncel fiyatlar ve Fear & Greed' },
      {
        command: 'bakiye',
        description: 'Bakiyeni gör veya kaydet — örn: bakiye 100',
      },
      {
        command: 'nobet',
        description: 'Otomatik tarama aralığı — örn: nöbet 30dk',
      },
      { command: 'kurallar', description: 'Kayıtlı kalıcı kuralların' },
      { command: 'yardim', description: 'Komutları ve kuralları göster' },
      { command: 'start', description: 'Botu başlat' },
    ];

    const resp = await axios.post(
      `${this.apiBase}/setMyCommands`,
      { commands },
      { timeout: 20000 },
    );

    if (!resp.data?.ok) {
      throw new Error(resp.data?.description ?? 'setMyCommands basarisiz');
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
