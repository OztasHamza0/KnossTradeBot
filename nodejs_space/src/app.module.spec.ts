import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';
import { TelegramService } from './telegram/telegram.service';
import { AutoScanService } from './auto-scan/auto-scan.service';
import { OutcomeTrackerService } from './auto-scan/outcome-tracker.service';
import { TradeEngineService } from './trade-engine/trade-engine.service';

/**
 * DI grafigi derleniyor mu.
 *
 * Bu dosyanin varlik sebebi gercek bir uretim arizasi: TelegramService'e
 * OutcomeTrackerService bagimliligi eklendi ama TelegramModule'e karsiligi
 * yazilmadi. Servis AutoScanModule'de saglaniyordu ve AutoScanModule zaten
 * TelegramModule'u import ettigi icin tersi mumkun degildi.
 *
 * 367 birim testin hicbiri bunu yakalamadi, cunku hepsi servisleri elle
 * `new` ile kuruyor — Nest'in cozucusu hic calismiyor. Sonuc: butun testler
 * yesilken konteyner acilista
 *   "Nest can't resolve dependencies of the TelegramService ... index [4]"
 * ile cikti ve deploy dustu.
 *
 * compile() yasam dongusu kancalarini (onModuleInit) CALISTIRMAZ, yani
 * PrismaService baglanmaya calismaz ve bu test veritabani istemez.
 */
describe('AppModule DI grafigi', () => {
  const OLD_ENV = process.env;

  beforeAll(() => {
    process.env = {
      ...OLD_ENV,
      // PrismaClient kurucusu bir baglanti adresi bekliyor; baglanmiyor.
      DATABASE_URL:
        OLD_ENV.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/db',
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('butun modulleri cozer', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Zincirin her halkasi gercekten ornekleniyor mu.
    expect(moduleRef.get(TelegramService)).toBeDefined();
    expect(moduleRef.get(AutoScanService)).toBeDefined();
    expect(moduleRef.get(OutcomeTrackerService)).toBeDefined();
    expect(moduleRef.get(TradeEngineService)).toBeDefined();

    await moduleRef.close();
  });

  it('OutcomeTracker tek ornek — @Cron iki kez kaydolmaz', async () => {
    // Servis yalnizca OutcomeTrackerModule'de saglaniyor; TelegramModule ve
    // AutoScanModule ayni ornegi paylasiyor. Iki ayri providers listesine
    // konsaydi iki ornek olur ve sonuc kontrolu 10 dakikada bir iki kez
    // kosardi.
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const fromTelegram: any = moduleRef.get(TelegramService);
    const direct = moduleRef.get(OutcomeTrackerService);

    expect(fromTelegram.outcomeTracker).toBe(direct);

    await moduleRef.close();
  });
});
