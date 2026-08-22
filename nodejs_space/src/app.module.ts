import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from './prisma/prisma.module';
import { MarketDataModule } from './market-data/market-data.module';
import { TradeEngineModule } from './trade-engine/trade-engine.module';
import { TelegramModule } from './telegram/telegram.module';
import { AutoScanModule } from './auto-scan/auto-scan.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Drives the hourly watch in-process, so the bot needs no external cron.
    ScheduleModule.forRoot(),
    PrismaModule,
    MarketDataModule,
    TradeEngineModule,
    TelegramModule,
    AutoScanModule,
  ],
})
export class AppModule {}
