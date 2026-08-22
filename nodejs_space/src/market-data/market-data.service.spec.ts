import { MarketDataService, MarketOverview } from './market-data.service';

const coin = (symbol: string) => ({
  symbol,
  pair: `${symbol}USDT`,
  name: symbol,
  current_price: 100,
  price_change_percentage_24h: 1,
  price_change_percentage_1h: 0.5,
  total_volume: 1_000_000,
  onFutures: true,
});

const goodSnapshot = (fetchedAt = Date.now()): MarketOverview => ({
  btc: coin('BTC'),
  eth: null,
  sol: null,
  top50: [coin('BTC'), coin('ETH')],
  fearGreed: { value: 50, classification: 'Neutral' },
  fetchedAt,
  source: 'binance',
  warnings: [],
});

const failedSnapshot = (): MarketOverview => ({
  btc: null,
  eth: null,
  sol: null,
  top50: [],
  fearGreed: null,
  fetchedAt: Date.now(),
  source: 'none',
  warnings: ['HICBIR piyasa verisi alinamadi.'],
});

/** Replaces the HTTP layer so only the cache/fallback policy is under test. */
function serviceWith(...responses: MarketOverview[]) {
  const svc = new MarketDataService() as any;
  let i = 0;
  svc.fetchFreshData = () =>
    Promise.resolve(responses[Math.min(i++, responses.length - 1)]);
  return svc as MarketDataService & {
    fetchFreshData: () => Promise<MarketOverview>;
  };
}

describe('MarketDataService cache and fallback', () => {
  it('serves a successful fetch and caches it', async () => {
    const svc = serviceWith(goodSnapshot());
    const a = await svc.getMarketData();
    const b = await svc.getMarketData();
    expect(a.top50).toHaveLength(2);
    expect(b).toBe(a); // ikinci cagri cache'ten
  });

  // The outage that hit in production: both feeds failed on a cold start and
  // the empty result was cached for the full two minutes, so the immediate
  // retry never actually re-fetched.
  it('does not serve an empty result from cache for the full TTL', async () => {
    const svc = serviceWith(failedSnapshot(), goodSnapshot());
    const first = await svc.getMarketData();
    expect(first.top50).toHaveLength(0);

    // FAILURE_TTL gecmis gibi davran
    (svc as any).cacheExpiry = Date.now() - 1;

    const second = await svc.getMarketData();
    expect(second.top50).toHaveLength(2);
    expect(second.source).toBe('binance');
  });

  it('falls back to the last good snapshot when every feed fails', async () => {
    const svc = serviceWith(goodSnapshot(), failedSnapshot());
    await svc.getMarketData();
    (svc as any).cacheExpiry = Date.now() - 1;

    const stale = await svc.getMarketData();
    expect(stale.top50).toHaveLength(2);
    expect(stale.warnings.join(' ')).toContain('eski');
    expect(stale.warnings.join(' ')).toContain('YENI POZISYON ACMA');
  });

  it('reports the age of the stale snapshot', async () => {
    const svc = serviceWith(goodSnapshot(), failedSnapshot());
    await svc.getMarketData();
    // 7 dakika once alinmis gibi yasllandir
    (svc as any).lastGood.fetchedAt = Date.now() - 7 * 60 * 1000;
    (svc as any).cacheExpiry = Date.now() - 1;

    const stale = await svc.getMarketData();
    expect(stale.warnings.join(' ')).toContain('7 dakika eski');
  });

  it('refuses a snapshot older than the staleness ceiling', async () => {
    const svc = serviceWith(goodSnapshot(), failedSnapshot());
    await svc.getMarketData();
    (svc as any).lastGood.fetchedAt = Date.now() - 30 * 60 * 1000;
    (svc as any).cacheExpiry = Date.now() - 1;

    const result = await svc.getMarketData();
    expect(result.top50).toHaveLength(0);
    expect(result.source).toBe('none');
  });

  it('keeps the last good snapshot intact across a failure', async () => {
    const svc = serviceWith(goodSnapshot(), failedSnapshot(), failedSnapshot());
    await svc.getMarketData();
    (svc as any).cacheExpiry = Date.now() - 1;
    await svc.getMarketData();
    (svc as any).cacheExpiry = Date.now() - 1;

    const stillStale = await svc.getMarketData();
    expect(stillStale.top50).toHaveLength(2);
  });

  it('returns an empty result when a failure happens with no prior snapshot', async () => {
    const svc = serviceWith(failedSnapshot());
    const result = await svc.getMarketData();
    expect(result.top50).toHaveLength(0);
    expect(result.warnings.join(' ')).toContain('HICBIR');
  });
});
