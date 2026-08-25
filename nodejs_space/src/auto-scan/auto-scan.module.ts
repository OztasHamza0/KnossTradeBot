import { Module } from '@nestjs/common';
import { AutoScanController } from './auto-scan.controller';
import { AutoScanService } from './auto-scan.service';
import { OutcomeTrackerService } from './outcome-tracker.service';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { TelegramModule } from '../telegram/telegram.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [TradeEngineModule, TelegramModule, MarketDataModule],
  controllers: [AutoScanController],
  providers: [AutoScanService, OutcomeTrackerService],
  exports: [OutcomeTrackerService],
})
export class AutoScanModule {}
