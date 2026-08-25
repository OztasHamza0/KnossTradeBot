import { Module } from '@nestjs/common';
import { AutoScanController } from './auto-scan.controller';
import { AutoScanService } from './auto-scan.service';
import { OutcomeTrackerModule } from './outcome-tracker.module';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [
    TradeEngineModule,
    TelegramModule,
    MarketDataModule,
    OutcomeTrackerModule,
  ],
  controllers: [AutoScanController],
  providers: [AutoScanService],
})
export class AutoScanModule {}
