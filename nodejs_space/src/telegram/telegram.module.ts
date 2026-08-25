import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { OutcomeTrackerModule } from '../auto-scan/outcome-tracker.module';

@Module({
  // OutcomeTrackerModule "performans" komutu icin gerekli. AutoScanModule
  // degil OutcomeTrackerModule import ediliyor: AutoScanModule bu modulu
  // import ediyor, tersi dairesel bagimlilik olurdu.
  imports: [TradeEngineModule, MarketDataModule, OutcomeTrackerModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
