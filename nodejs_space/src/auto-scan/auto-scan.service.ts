import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { TradeEngineService } from '../trade-engine/trade-engine.service';
import { TelegramService } from '../telegram/telegram.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AutoScanService {
  private readonly logger = new Logger(AutoScanService.name);
  /** Guards against the cron firing while a manual run is still in flight. */
  private running = false;

  constructor(
    private readonly tradeEngine: TradeEngineService,
    private readonly telegramService: TelegramService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The hourly watch from the spec. Runs in-process so no external scheduler
   * is required; the /auto-scan/execute endpoint remains available for
   * platforms where an external cron is preferred.
   */
  @Cron(CronExpression.EVERY_HOUR, { name: 'hourly-auto-scan' })
  async scheduledScan(): Promise<void> {
    if (this.config.get<string>('DISABLE_INTERNAL_CRON') === 'true') {
      this.logger.debug('Internal cron disabled by DISABLE_INTERNAL_CRON');
      return;
    }
    this.logger.log('Hourly cron fired');
    await this.runAutoScan();
  }

  async runAutoScan(): Promise<number> {
    if (this.running) {
      this.logger.warn('Auto-scan already running, skipping this trigger');
      return 0;
    }
    this.running = true;
    this.logger.log('Running auto-scan...');

    let delivered = 0;

    try {
      const results = await this.tradeEngine.analyzeForAutoScan();

      for (const { chatId, response, alert } of results) {
        // A volatility alert needs no model output, so it is sent on its own.
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

      this.logger.log(`Auto-scan complete. ${delivered} message(s) delivered.`);
      return delivered;
    } catch (error: any) {
      this.logger.error(`Auto-scan failed: ${error?.message}`, error?.stack);
      return delivered;
    } finally {
      this.running = false;
    }
  }
}
