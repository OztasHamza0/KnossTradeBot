import { Module } from '@nestjs/common';
import { TradeEngineService } from './trade-engine.service';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [MarketDataModule],
  providers: [TradeEngineService],
  exports: [TradeEngineService],
})
export class TradeEngineModule {}
