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
   * Chats whose interval has elapsed. A chat with no user_state row has never
   * been configured, so it takes the default cadence.
   */
  async findDueChats(now = new Date()): Promise<string[]> {
    const chats = await this.prisma.active_chats.findMany({
      select: { chat_id: true },
    });
    if (chats.length === 0) return [];

    const states = await this.prisma.user_state.findMany({
      where: { chat_id: { in: chats.map((c) => c.chat_id) } },
    });
    const stateByChat = new Map(states.map((s) => [s.chat_id, s]));

    const due: string[] = [];
    for (const { chat_id } of chats) {
      const state = stateByChat.get(chat_id);

      if (state && !state.scan_enabled) continue;

      const interval = state?.scan_interval_minutes ?? DEFAULT_SCAN_INTERVAL;
      const last = state?.last_scan_at;

      // Never scanned → due now, so a fresh chat does not wait a full cycle.
      if (!last) {
        due.push(chat_id);
        continue;
      }

      const elapsedMin = (now.getTime() - last.getTime()) / 60000;
      // 30s slack: a 60-minute interval on a 5-minute tick would otherwise
      // drift to 65 minutes every time.
      if (elapsedMin >= interval - 0.5) due.push(chat_id);
    }

    return due;
  }

  async runAutoScan(force = false): Promise<number> {
    if (this.running) {
      this.logger.warn('Auto-scan already running, skipping this trigger');
      return 0;
    }
    this.running = true;

    let delivered = 0;

    try {
      const chatIds = force
        ? (
            await this.prisma.active_chats.findMany({
              select: { chat_id: true },
            })
          ).map((c) => c.chat_id)
        : await this.findDueChats();

      if (chatIds.length === 0) return 0;
      this.logger.log(`Auto-scan running for ${chatIds.length} chat(s)`);

      const results = await this.tradeEngine.analyzeForAutoScan(chatIds);

      for (const { chatId, response, alert } of results) {
        if (alert) {
          await this.telegramService.sendMessage(chatId, alert);
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

      // Stamped for every scanned chat, not just the ones that produced a
      // message — otherwise a quiet chat would be re-scanned on every tick.
      await this.markScanned(chatIds);

      this.logger.log(`Auto-scan complete. ${delivered} message(s) delivered.`);
      return delivered;
    } catch (error: any) {
      this.logger.error(`Auto-scan failed: ${error?.message}`, error?.stack);
      return delivered;
    } finally {
      this.running = false;
    }
  }

  private async markScanned(chatIds: string[]): Promise<void> {
    const now = new Date();
    for (const chatId of chatIds) {
      await this.prisma.user_state
        .upsert({
          where: { chat_id: chatId },
          update: { last_scan_at: now },
          create: { chat_id: chatId, last_scan_at: now },
        })
        .catch((e: any) =>
          this.logger.error(`markScanned failed for ${chatId}: ${e?.message}`),
        );
    }
  }
}
