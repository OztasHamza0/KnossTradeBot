import { Module } from '@nestjs/common';
import { AutoScanController } from './auto-scan.controller';
import { AutoScanService } from './auto-scan.service';
import { TradeEngineModule } from '../trade-engine/trade-engine.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [TradeEngineModule, TelegramModule],
  controllers: [AutoScanController],
  providers: [AutoScanService],
})
export class AutoScanModule {}
