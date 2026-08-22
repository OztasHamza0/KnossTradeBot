import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [TradeEngineModule, MarketDataModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
