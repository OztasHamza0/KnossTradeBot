import { Module } from '@nestjs/common';
import { OutcomeTrackerService } from './outcome-tracker.service';
import { MarketDataModule } from '../market-data/market-data.module';

/**
 * OutcomeTracker'in kendi modulu.
 *
 * Neden ayri: hem TelegramService ("performans" komutu) hem AutoScanModule
 * bu servise ihtiyac duyuyor. AutoScanModule zaten TelegramModule'u import
 * ettigi icin (nobet sonucunu Telegram'a gonderiyor), servisi orada birakip
 * TelegramModule'e AutoScanModule'u import ettirmek dairesel bagimlilik
 * olurdu — ayni sebeple auto-scan.constants.ts de ayri bir dosyada duruyor.
 *
 * Bu modulun tek bagimliligi MarketDataModule, yani grafikte hicbir donguye
 * girmiyor ve iki taraf da guvenle import edebiliyor. Servis yalnizca burada
 * saglandigi icin tek ornek kaliyor ve @Cron bir kez kaydediliyor.
 */
@Module({
  imports: [MarketDataModule],
  providers: [OutcomeTrackerService],
  exports: [OutcomeTrackerService],
})
export class OutcomeTrackerModule {}
