import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MarketDataService } from '../market-data/market-data.service';
import { judgeOutcome, rMultiple, summarize } from '../market-data/outcome';
import { toCandles } from '../market-data/indicators';

/** Bu sureden sonra hala acik olan kart "expired" sayilir. */
const EXPIRY_HOURS = 72;

/**
 * Gonderilen kartlarin sonucunu olcer.
 *
 * Bot bunu yapmadan once verdigi sinyalin tuttugunu mu tutmadigini mi
 * bilmiyordu: sent_signals sadece karti kaydediyordu, sonucu degil. Yani
 * "bot ise yariyor mu" sorusunun olculebilir bir cevabi yoktu ve bot
 * aylarca zarar ettiriyor olsa veride bunu gosterecek hicbir sey olmazdi.
 */
@Injectable()
export class OutcomeTrackerService {
  private readonly logger = new Logger(OutcomeTrackerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'outcome-tracker' })
  async scheduled(): Promise<void> {
    await this.checkOpenSignals();
  }

  async checkOpenSignals(): Promise<number> {
    if (this.running) return 0;
    this.running = true;

    try {
      const open = await this.prisma.sent_signals.findMany({
        where: {
          status: 'open',
          // Stop/hedef kaydedilmemis eski kayitlar olculemez.
          stop_loss: { not: null },
          take_profit: { not: null },
        },
        orderBy: { created_at: 'asc' },
        take: 50,
      });

      if (open.length === 0) return 0;

      let closed = 0;
      for (const sig of open) {
        const ageHours = (Date.now() - sig.created_at.getTime()) / 3_600_000;

        try {
          const raw = await this.marketData.getCandlesSince(
            sig.pair,
            sig.created_at,
          );
          const candles = toCandles(raw);

          const verdict = judgeOutcome(
            sig.direction,
            sig.stop_loss!,
            sig.take_profit!,
            candles,
          );

          if (verdict.status === 'open') {
            // Sonsuza kadar acik kalmasin: uzun sure ne stopa ne hedefe
            // varmamis bir kart pratikte gecersizlesmistir.
            if (ageHours > EXPIRY_HOURS) {
              await this.prisma.sent_signals.update({
                where: { id: sig.id },
                data: { status: 'expired', closed_at: new Date() },
              });
              closed++;
            }
            continue;
          }

          await this.prisma.sent_signals.update({
            where: { id: sig.id },
            data: {
              status: verdict.status,
              closed_at: new Date(),
              closed_price: verdict.price,
            },
          });
          closed++;

          this.logger.log(
            `${sig.pair} ${sig.direction} -> ${verdict.status.toUpperCase()}` +
              (verdict.note ? ` (${verdict.note})` : ''),
          );
        } catch (error: any) {
          this.logger.warn(
            `Outcome check failed for ${sig.pair} #${sig.id}: ${error?.message}`,
          );
        }
      }

      if (closed > 0) this.logger.log(`${closed} sinyalin sonucu belirlendi`);
      return closed;
    } catch (error: any) {
      this.logger.error(`Outcome tracking failed: ${error?.message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** "performans" komutunun kullandigi ozet. */
  async performanceFor(chatId: string) {
    const rows = await this.prisma.sent_signals.findMany({
      where: { chat_id: chatId },
      orderBy: { created_at: 'desc' },
      take: 200,
    });

    const withR = rows.map((r) => ({
      status: r.status,
      rMultiple:
        r.stop_loss !== null && r.take_profit !== null
          ? rMultiple(
              r.entry_price,
              r.stop_loss,
              r.take_profit,
              r.status as any,
            )
          : null,
    }));

    return {
      summary: summarize(withR),
      recent: rows.slice(0, 5).map((r) => ({
        pair: r.pair,
        direction: r.direction,
        status: r.status,
        createdAt: r.created_at,
      })),
      /** Sonucu olculemeyen eski kayitlar — dogru sayiyi bilmek icin. */
      unmeasurable: rows.filter(
        (r) => r.stop_loss === null || r.take_profit === null,
      ).length,
    };
  }
}
