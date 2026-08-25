import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TradeEngineService } from '../trade-engine/trade-engine.service';
import { TelegramService } from '../telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_SCAN_INTERVAL } from './auto-scan.constants';

@Injectable()
export class AutoScanService {
  private readonly logger = new Logger(AutoScanService.name);
  /** Guards against a tick firing while the previous pass is still running. */
  private running = false;

  constructor(
    private readonly tradeEngine: TradeEngineService,
    private readonly telegramService: TelegramService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Ticks every 5 minutes; the actual cadence is per-chat and comes from
   * user_state.scan_interval_minutes. The tick is only the resolution floor —
   * a chat set to 30 minutes is scanned every 30 minutes, not every 5.
   */
  @Cron('*/5 * * * *', { name: 'auto-scan-tick' })
  async scheduledScan(): Promise<void> {
    if (this.config.get<string>('DISABLE_INTERNAL_CRON') === 'true') return;
    await this.runAutoScan();
  }

  /**
   * Local hour in the bot's timezone, read explicitly rather than via the
   * container's TZ so the behaviour does not silently change with the host.
   */
  currentHour(now = new Date()): number {
    const tz = this.config.get<string>('BOT_TIMEZONE') ?? 'Europe/Istanbul';
    try {
      return parseInt(
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hour: 'numeric',
          hourCycle: 'h23',
        }).format(now),
        10,
      );
    } catch {
      this.logger.warn(`Gecersiz BOT_TIMEZONE "${tz}", UTC kullaniliyor`);
      return now.getUTCHours();
    }
  }

  /**
   * Quiet hours are a per-chat window in which the watch stays silent.
   * The window may wrap past midnight — 23-07 is a normal way to say
   * "overnight", so a plain start<=h<end comparison would be wrong.
   */
  isQuietNow(
    start: number | null,
    end: number | null,
    hour = this.currentHour(),
  ): boolean {
    if (start === null || end === null) return false;
    if (start === end) return false; // sifir uzunlukta pencere
    return start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
  }

  /**
   * Atomically claims the chats whose interval has elapsed.
   *
   * The claim is the same UPDATE that stamps last_scan_at, so two processes
   * firing the same tick cannot both take a chat — the second one's WHERE no
   * longer matches and it claims nothing. Read-then-scan-then-stamp did allow
   * that: during a Render deploy the old and new containers overlap, both
   * crons fired at the same minute, and the chat was scanned twice seconds
   * apart (observed in production at 19:10:01 and 19:10:14).
   *
   * Stamping before the scan also means a crashed pass waits a full interval
   * instead of being retried on every tick.
   *
   * 30s slack: a 10-minute interval sampled by a 5-minute tick lands at 10.0
   * exactly, and without slack it would slip a tick and drift every cycle.
   */
  async claimDueChats(): Promise<string[]> {
    const chats = await this.prisma.active_chats.findMany({
      select: { chat_id: true },
    });
    if (chats.length === 0) return [];

    // The claim is an UPDATE, so a chat with no state row would never match.
    for (const { chat_id } of chats) {
      await this.prisma.user_state.upsert({
        where: { chat_id },
        update: {},
        create: { chat_id, scan_interval_minutes: DEFAULT_SCAN_INTERVAL },
      });
    }

    // Quiet hours are filtered here rather than in the claim SQL: the window
    // is timezone-dependent, and doing it in JS keeps it readable and
    // testable. Both instances filter identically, so the claim below still
    // decides who scans.
    const states = await this.prisma.user_state.findMany({
      where: { chat_id: { in: chats.map((c) => c.chat_id) } },
      select: { chat_id: true, quiet_start: true, quiet_end: true },
    });
    const quiet = new Set(
      states
        .filter((st) => this.isQuietNow(st.quiet_start, st.quiet_end))
        .map((st) => st.chat_id),
    );
    if (quiet.size > 0) {
      this.logger.log(`${quiet.size} sohbet sessiz saatte, atlaniyor`);
    }

    const claimed: string[] = [];
    for (const { chat_id } of chats) {
      if (quiet.has(chat_id)) continue;
      const rows = await this.prisma.$executeRaw`
        UPDATE user_state
        SET last_scan_at = NOW()
        WHERE chat_id = ${chat_id}
          AND scan_enabled = true
          AND (
            last_scan_at IS NULL
            OR last_scan_at <= NOW()
               - (scan_interval_minutes * INTERVAL '1 minute')
               + INTERVAL '30 seconds'
          )
      `;
      if (rows > 0) claimed.push(chat_id);
    }

    return claimed;
  }

  async runAutoScan(force = false): Promise<number> {
    if (this.running) {
      this.logger.warn('Auto-scan already running, skipping this trigger');
      return 0;
    }
    this.running = true;

    let delivered = 0;

    try {
      // force skips the interval but still stamps, so a manual run does not
      // leave the chat immediately due again on the next tick.
      const chatIds = force
        ? await this.claimAllChats()
        : await this.claimDueChats();

      if (chatIds.length === 0) return 0;
      this.logger.log(`Auto-scan running for ${chatIds.length} chat(s)`);

      const results = await this.tradeEngine.analyzeForAutoScan(chatIds);

      for (const { chatId, response, alert, reason } of results) {
        if (alert) {
          // A volatility alert with no card looks like a half-finished thought
          // unless the reason is stated. A coin that just ran 20% is often a
          // deliberate skip, not an oversight — say which.
          const note =
            !response.signal && reason
              ? `\n\n📋 İşlem kartı yok — ${reason}`
              : '';
          await this.telegramService.sendMessage(chatId, alert + note);
          delivered++;
        }

        if (!response.signal) continue;

        const card = this.telegramService.formatTradeCard(response.signal);
        await this.telegramService.sendMessage(
          chatId,
          `🔔 OTOMATİK NÖBET SİNYALİ\n\n${response.text ? `${response.text}\n\n` : ''}${card}`,
        );

        await this.prisma.sent_signals.create({
          data: {
            chat_id: chatId,
            pair: response.signal.pair.toUpperCase(),
            direction: response.signal.direction.toUpperCase(),
            entry_price: this.tradeEngine.parseNum(response.signal.entry) || 0,
          },
        });

        delivered++;
        this.logger.log(
          `Signal sent to ${chatId}: ${response.signal.pair} ${response.signal.direction}`,
        );
      }

      this.logger.log(`Auto-scan complete. ${delivered} message(s) delivered.`);
      return delivered;
    } catch (error: any) {
      this.logger.error(`Auto-scan failed: ${error?.message}`, error?.stack);
      return delivered;
    } finally {
      this.running = false;
    }
  }

  /**
   * Manual trigger: skips the interval and quiet hours, but NOT scan_enabled.
   *
   * "nobet kapat" demis bir kullaniciya dis bir cron uzerinden tarama
   * gondermek, komutu tamamen anlamsiz kilardi — force araliği atlamak
   * icindir, kullanicinin kararini ezmek icin degil.
   */
  private async claimAllChats(): Promise<string[]> {
    const chats = await this.prisma.active_chats.findMany({
      select: { chat_id: true },
    });
    const states = await this.prisma.user_state.findMany({
      where: { chat_id: { in: chats.map((c) => c.chat_id) } },
      select: { chat_id: true, scan_enabled: true },
    });
    const disabled = new Set(
      states.filter((st) => !st.scan_enabled).map((st) => st.chat_id),
    );

    const eligible = chats.filter((c) => !disabled.has(c.chat_id));
    if (disabled.size > 0) {
      this.logger.log(
        `${disabled.size} sohbet nobeti kapatmis, force atlaniyor`,
      );
    }

    const now = new Date();

    for (const { chat_id } of eligible) {
      await this.prisma.user_state
        .upsert({
          where: { chat_id },
          update: { last_scan_at: now },
          create: { chat_id, last_scan_at: now },
        })
        .catch((e: any) =>
          this.logger.error(
            `claimAllChats failed for ${chat_id}: ${e?.message}`,
          ),
        );
    }

    return eligible.map((c) => c.chat_id);
  }
}
