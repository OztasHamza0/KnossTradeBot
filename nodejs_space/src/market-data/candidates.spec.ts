import { MarketDataService, MarketOverview, CoinData } from './market-data.service';

const coin = (pair: string, h24: number, h1: number | null): CoinData => ({
  symbol: pair.replace('USDT', ''),
  pair,
  name: pair,
  current_price: 100,
  price_change_percentage_24h: h24,
  price_change_percentage_1h: h1,
  total_volume: 1e9,
  onFutures: true,
});

const market = (coins: CoinData[]): MarketOverview => ({
  btc: null, eth: null, sol: null,
  top50: coins,
  fearGreed: null,
  fetchedAt: Date.now(),
  source: 'binance',
  tradablePairs: coins.map((c) => c.pair),
  warnings: [],
});

/**
 * Eskiden tek olcut vardi: |1 saatlik degisim| en buyuk 5. Havuzda her zaman
 * "zaten kosmus" coinler oluyor, model de tepeden SHORT oneriyordu; denetci
 * bunlari duzenli olarak "momentuma karsi, onay yok" diye eliyordu.
 */
describe('selectCandidates', () => {
  const svc = new MarketDataService({ get: () => undefined } as any);

  it('sert hareket edeni alir', () => {
    const c = svc.selectCandidates(
      market([coin('AUSDT', 1, 9), coin('BUSDT', 1, 0.2), coin('CUSDT', 1, 0.1)]),
      5,
    );
    expect(c[0].pair).toBe('AUSDT');
    expect(c[0].setup).toContain('sert hareket');
  });

  it('yukselis trendinde geri cekilmis coini ayri bir kurulum olarak isaretler', () => {
    const c = svc.selectCandidates(
      market([
        coin('MOVERUSDT', 2, 8),
        coin('PULLUSDT', 12, -1.2), // 24s +%12 ama son saat eksi
      ]),
      5,
    );
    const pull = c.find((x) => x.pair === 'PULLUSDT');
    expect(pull?.setup).toContain('geri cekilme');
  });

  it('dusus trendinde tepki veren de geri cekilme kovasina girer', () => {
    const c = svc.selectCandidates(
      market([coin('MOVERUSDT', 1, 7), coin('BOUNCEUSDT', -11, 0.8)]),
      5,
    );
    expect(c.find((x) => x.pair === 'BOUNCEUSDT')?.setup).toContain(
      'geri cekilme',
    );
  });

  it('1 saatlik verisi olmayan coini hic aday yapmaz', () => {
    const c = svc.selectCandidates(
      market([coin('NULLUSDT', 30, null), coin('OKUSDT', 2, 3)]),
      5,
    );
    expect(c.map((x) => x.pair)).not.toContain('NULLUSDT');
  });

  it('ayni coini iki kez almaz ve sayiyi asmaz', () => {
    const coins = Array.from({ length: 20 }, (_, i) =>
      coin(`C${i}USDT`, 10 - i * 0.5, i % 2 === 0 ? -1 : 4),
    );
    const c = svc.selectCandidates(market(coins), 5);
    expect(c).toHaveLength(5);
    expect(new Set(c.map((x) => x.pair)).size).toBe(5);
  });

  it('geri cekilme yoksa trend liderleriyle doldurur', () => {
    const c = svc.selectCandidates(
      market([
        coin('AUSDT', 9, 9),
        coin('BUSDT', 8, 8),
        coin('CUSDT', 7, 7),
        coin('DUSDT', 6, 6),
      ]),
      4,
    );
    expect(c).toHaveLength(4);
    expect(c.some((x) => x.setup.includes('trend lideri'))).toBe(true);
  });
});
