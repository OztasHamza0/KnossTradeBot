import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface CoinData {
  /** Base symbol, uppercase — BTC, ETH, SOL */
  symbol: string;
  /** Binance Futures pair (BTCUSDT) when the coin trades there, else '' */
  pair: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  price_change_percentage_1h: number;
  /** 24h quote volume in USDT */
  total_volume: number;
  /** True when the coin was found on the Binance Futures ticker */
  onFutures: boolean;
}

export type MarketSource = 'binance' | 'coingecko' | 'none';

export interface MarketOverview {
  btc: CoinData | null;
  eth: CoinData | null;
  sol: CoinData | null;
  top50: CoinData[];
  fearGreed: { value: number; classification: string } | null;
  fetchedAt: number;
  /** Which feed produced top50 — the LLM is told, so it never invents pairs */
  source: MarketSource;
  /**
   * Every USDT perpetual on Binance Futures, not just the top 50. Tradability
   * and volume rank are different questions: a coin can be perfectly tradable
   * while sitting outside the busiest fifty.
   */
  tradablePairs: string[];
  warnings: string[];
}

/** Tek bir coin icin derin arastirma verisi — "arastir PEPE" komutu kullanir. */
export interface CoinResearch {
  id: string;
  name: string;
  symbol: string;
  marketCapRank: number | null;
  price: number;
  marketCap: number;
  volume24h: number;
  change24h: number;
  change7d: number;
  change30d: number;
  ath: number;
  athChangePct: number;
  circulatingSupply: number;
  totalSupply: number | null;
  maxSupply: number | null;
  categories: string[];
  description: string;
  homepage: string | null;
  /** Binance Futures paritesi (varsa) — yoksa bu coin futures'ta islem gormez. */
  futuresPair: string | null;
  /** Ayni sorguya uyan diger coinler; kullanici yanlis coini kastetmis olabilir. */
  alternatives: { id: string; symbol: string; rank: number | null }[];
}

interface BinanceTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

/**
 * Market feed for the trade engine.
 *
 * Binance Futures is the primary source: it is the venue the user actually
 * trades on, so its pair list is the only one guaranteed to be tradable.
 * Binance blocks some hosting regions (451), so CoinGecko is a full fallback.
 * CoinGecko is also merged in for 1h change, which the Binance 24h ticker
 * does not carry and which would otherwise cost 50 extra kline requests.
 */
@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Every CoinGecko call goes through here.
   *
   * Without a key the quota is per-IP, and on shared hosting that IP is shared
   * with every other tenant — the bot hit a permanent 429 on Render while the
   * same request succeeded from a home connection. A free Demo key moves the
   * quota onto the key instead.
   *
   * Retries once on 429: the free tier is bursty, and a second attempt a
   * moment later usually lands.
   */
  private async coingeckoGet<T = any>(
    path: string,
    params: Record<string, any> = {},
    timeout = 20000,
  ): Promise<T> {
    const key = this.config.get<string>('COINGECKO_API_KEY');
    const headers: Record<string, string> = key
      ? { 'x-cg-demo-api-key': key }
      : {};

    const url = `https://api.coingecko.com/api/v3${path}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await axios.get<T>(url, { params, headers, timeout });
        return resp.data;
      } catch (error: any) {
        const status = error?.response?.status;
        const lastAttempt = attempt === 1;

        if (status === 429 && !lastAttempt) {
          this.logger.warn(`CoinGecko 429 on ${path}, retrying once`);
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        if (status === 429) {
          this.logger.error(
            `CoinGecko rate limit on ${path}. ` +
              (key
                ? 'Demo anahtar kotasi dolmus olabilir.'
                : 'COINGECKO_API_KEY tanimli degil — paylasimli IP kotasi kullaniliyor.'),
          );
        }
        throw error;
      }
    }

    throw new Error('unreachable');
  }
  private cache: MarketOverview | null = null;
  private cacheExpiry = 0;
  /** Last fetch that actually produced coins — the stale fallback. */
  private lastGood: MarketOverview | null = null;

  private readonly CACHE_TTL = 2 * 60 * 1000; // 2 minutes
  /**
   * A total failure is cached far more briefly than a success. Caching an
   * outage for the full TTL means the next two minutes of requests are served
   * a known-empty result without ever retrying — which is what happened when
   * the container cold-started and both feeds timed out.
   */
  private readonly FAILURE_TTL = 20 * 1000;
  /**
   * How stale the last good snapshot may be before it is worse than nothing.
   * Prices this old must not drive a fresh entry, but they still let the model
   * answer questions and reason about direction — and the age is in the prompt.
   */
  private readonly MAX_STALE_MS = 15 * 60 * 1000;

  private readonly BINANCE_HOSTS = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
  ];

  /** Leveraged tokens and index products — never valid futures entries */
  private readonly EXCLUDED = /(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT)$/;

  /**
   * Per-coin research cache. Each lookup costs two CoinGecko calls and the
   * free tier rate-limits quickly, so asking about the same coin twice in a
   * conversation must not spend the budget twice. Fundamentals barely move in
   * ten minutes; the price shown alongside is refreshed by the market feed.
   */
  private readonly researchCache = new Map<
    string,
    { data: CoinResearch; expiry: number }
  >();
  private readonly RESEARCH_TTL = 10 * 60 * 1000;

  async getMarketData(): Promise<MarketOverview> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }

    const fresh = await this.fetchFreshData();

    if (fresh.top50.length > 0) {
      this.lastGood = fresh;
      this.cache = fresh;
      this.cacheExpiry = Date.now() + this.CACHE_TTL;
      return fresh;
    }

    // Every feed failed. Fall back to the last good snapshot while it is still
    // recent enough to be meaningful, and say plainly how old it is.
    const ageMs = this.lastGood
      ? Date.now() - this.lastGood.fetchedAt
      : Infinity;

    if (this.lastGood && ageMs < this.MAX_STALE_MS) {
      const ageMin = Math.round(ageMs / 60000);
      this.logger.warn(
        `Market fetch failed; serving ${ageMin} min old snapshot`,
      );

      const stale: MarketOverview = {
        ...this.lastGood,
        warnings: [
          ...fresh.warnings,
          `DIKKAT: Bu veri ${ageMin} dakika eski — canli kaynaklara ulasilamadi. ` +
            `Eski fiyata dayanarak YENI POZISYON ACMA.`,
        ],
      };
      this.cache = stale;
      this.cacheExpiry = Date.now() + this.FAILURE_TTL;
      return stale;
    }

    this.logger.error(
      'Market fetch failed and no usable snapshot is available',
    );
    this.cache = fresh;
    this.cacheExpiry = Date.now() + this.FAILURE_TTL;
    return fresh;
  }

  /**
   * Deep data for a single coin — the "araştır PEPE" path.
   *
   * The top-50 feed only covers the busiest pairs, so anything the user asks
   * about outside that set would otherwise reach the model with no numbers at
   * all. This fetches the coin directly instead.
   *
   * Returns null when the name matches nothing.
   */
  async researchCoin(query: string): Promise<CoinResearch | null> {
    const key = query.trim().toLowerCase();
    const hit = this.researchCache.get(key);
    if (hit && Date.now() < hit.expiry) {
      this.logger.debug(`Research cache hit for "${key}"`);
      return hit.data;
    }

    const matches = await this.searchCoins(query);
    if (matches.length === 0) return null;

    const best = matches[0];
    const detail = await this.fetchCoinDetail(best.id);
    if (!detail) return null;

    const research: CoinResearch = {
      ...detail,
      futuresPair: await this.findFuturesPair(detail.symbol),
      alternatives: matches.slice(1, 4),
    };

    this.researchCache.set(key, {
      data: research,
      expiry: Date.now() + this.RESEARCH_TTL,
    });
    // Unbounded growth would be a slow leak in a long-lived process.
    if (this.researchCache.size > 200) {
      const oldest = this.researchCache.keys().next().value;
      if (oldest) this.researchCache.delete(oldest);
    }

    return research;
  }

  /**
   * Ranked name/symbol matches. CoinGecko returns meme forks and copycats
   * ahead of the real coin often enough that ranking by market cap matters —
   * an unranked token sorts last rather than first.
   */
  private async searchCoins(
    query: string,
  ): Promise<{ id: string; symbol: string; rank: number | null }[]> {
    const data = await this.coingeckoGet<any>(
      '/search',
      { query: query.trim() },
      15000,
    );

    const coins = (data?.coins ?? []) as any[];
    const wantedUpper = query.trim().toUpperCase();
    const wantedLower = query.trim().toLowerCase();

    /**
     * Id match outranks symbol match. Copycats routinely take a famous name as
     * their *symbol* — there is a meme token whose symbol is literally
     * "BITCOIN", and ranking by symbol alone returned it for "bitcoin" ahead
     * of Bitcoin itself (whose symbol is BTC and whose id is "bitcoin").
     */
    const score = (c: { id: string; symbol: string }) => {
      if (c.id.toLowerCase() === wantedLower) return 0;
      if (c.symbol === wantedUpper) return 1;
      return 2;
    };

    return coins
      .map((c) => ({
        id: String(c.id),
        symbol: String(c.symbol ?? '').toUpperCase(),
        rank: (c.market_cap_rank as number) ?? null,
      }))
      .sort((a, b) => {
        const diff = score(a) - score(b);
        if (diff !== 0) return diff;
        // Unranked tokens sort last rather than first.
        return (a.rank ?? 99999) - (b.rank ?? 99999);
      })
      .slice(0, 5);
  }

  private async fetchCoinDetail(
    id: string,
  ): Promise<Omit<CoinResearch, 'futuresPair' | 'alternatives'> | null> {
    const d = await this.coingeckoGet<any>(`/coins/${encodeURIComponent(id)}`, {
      localization: false,
      tickers: false,
      market_data: true,
      community_data: false,
      developer_data: false,
      sparkline: false,
    });
    const m = d?.market_data;
    if (!m) return null;

    return {
      id: String(d.id),
      name: String(d.name),
      symbol: String(d.symbol ?? '').toUpperCase(),
      marketCapRank: d.market_cap_rank ?? null,
      price: m.current_price?.usd ?? 0,
      marketCap: m.market_cap?.usd ?? 0,
      volume24h: m.total_volume?.usd ?? 0,
      change24h: m.price_change_percentage_24h ?? 0,
      change7d: m.price_change_percentage_7d ?? 0,
      change30d: m.price_change_percentage_30d ?? 0,
      ath: m.ath?.usd ?? 0,
      athChangePct: m.ath_change_percentage?.usd ?? 0,
      circulatingSupply: m.circulating_supply ?? 0,
      totalSupply: m.total_supply ?? null,
      maxSupply: m.max_supply ?? null,
      categories: (d.categories ?? []).filter(Boolean).slice(0, 6),
      // Plain text only; the description carries HTML links.
      description: String(d.description?.en ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 700),
      homepage: d.links?.homepage?.[0] || null,
    };
  }

  /**
   * Maps a CoinGecko symbol to its Binance Futures pair.
   *
   * Binance quotes very cheap tokens in multiples so the tick size stays
   * usable — PEPE trades as 1000PEPEUSDT, SHIB as 1000SHIBUSDT. Checking the
   * bare symbol alone would wrongly report those as untradable.
   */
  private async findFuturesPair(symbol: string): Promise<string | null> {
    const market = await this.getMarketData();
    if (market.tradablePairs.length === 0) return null;

    const candidates = [
      `${symbol}USDT`,
      `1000${symbol}USDT`,
      `10000${symbol}USDT`,
      `1000000${symbol}USDT`,
    ];

    return candidates.find((c) => market.tradablePairs.includes(c)) ?? null;
  }

  private async fetchFreshData(): Promise<MarketOverview> {
    const [binanceResult, geckoResult, fgResult] = await Promise.allSettled([
      this.fetchBinanceFutures(),
      this.fetchCoinGecko(),
      this.fetchFearGreed(),
    ]);

    const warnings: string[] = [];

    const binance =
      binanceResult.status === 'fulfilled' ? binanceResult.value : [];
    const gecko = geckoResult.status === 'fulfilled' ? geckoResult.value : [];
    const fearGreed = fgResult.status === 'fulfilled' ? fgResult.value : null;

    if (binanceResult.status === 'rejected') {
      this.logger.error(
        `Binance Futures fetch failed: ${binanceResult.reason?.message}`,
      );
      warnings.push(
        'Binance Futures verisi alinamadi, CoinGecko kullaniliyor.',
      );
    }
    if (geckoResult.status === 'rejected') {
      this.logger.error(
        `CoinGecko fetch failed: ${geckoResult.reason?.message}`,
      );
    }
    if (fgResult.status === 'rejected') {
      this.logger.error(`Fear&Greed fetch failed: ${fgResult.reason?.message}`);
      warnings.push('Fear & Greed endeksi alinamadi.');
    }

    // 1h change and display names come from CoinGecko, keyed by base symbol.
    const geckoBySymbol = new Map(gecko.map((c) => [c.symbol, c]));

    let top50: CoinData[];
    let source: MarketSource;

    // Tradability is decided by the full list; the prompt only carries 50.
    const tradablePairs = binance.map((b) => b.pair);

    if (binance.length > 0) {
      source = 'binance';
      top50 = binance.slice(0, 50).map((b) => {
        const g = geckoBySymbol.get(b.symbol);
        return {
          ...b,
          name: g?.name ?? b.symbol,
          price_change_percentage_1h: g?.price_change_percentage_1h ?? 0,
        };
      });
      if (gecko.length === 0) {
        warnings.push('1 saatlik degisim verisi yok (CoinGecko erisilemedi).');
      }
    } else if (gecko.length > 0) {
      source = 'coingecko';
      top50 = gecko;
    } else {
      source = 'none';
      top50 = [];
      warnings.push('HICBIR piyasa verisi alinamadi.');
      this.logger.error('All market data sources failed');
    }

    return {
      btc: top50.find((c) => c.symbol === 'BTC') ?? null,
      eth: top50.find((c) => c.symbol === 'ETH') ?? null,
      sol: top50.find((c) => c.symbol === 'SOL') ?? null,
      top50: top50.slice(0, 50),
      fearGreed,
      fetchedAt: Date.now(),
      source,
      tradablePairs,
      warnings,
    };
  }

  /**
   * Every USDT-margined perpetual, sorted by 24h quote volume.
   * One bulk request covers every symbol; the caller decides how many to keep.
   */
  private async fetchBinanceFutures(): Promise<CoinData[]> {
    let lastError: any;

    for (const host of this.BINANCE_HOSTS) {
      try {
        const resp = await axios.get<BinanceTicker[]>(
          `${host}/fapi/v1/ticker/24hr`,
          {
            timeout: 15000,
          },
        );

        return resp.data
          .filter(
            (t) => t.symbol.endsWith('USDT') && !this.EXCLUDED.test(t.symbol),
          )
          .map((t) => ({
            symbol: t.symbol.slice(0, -4),
            pair: t.symbol,
            name: t.symbol.slice(0, -4),
            current_price: parseFloat(t.lastPrice),
            price_change_percentage_24h: parseFloat(t.priceChangePercent),
            price_change_percentage_1h: 0, // merged from CoinGecko by the caller
            total_volume: parseFloat(t.quoteVolume),
            onFutures: true,
          }))
          .filter(
            (c) => Number.isFinite(c.current_price) && c.current_price > 0,
          )
          .sort((a, b) => b.total_volume - a.total_volume);
      } catch (error: any) {
        lastError = error;
        this.logger.warn(`Binance host ${host} failed: ${error?.message}`);
      }
    }

    throw lastError ?? new Error('All Binance hosts unreachable');
  }

  /** Fallback feed, and the source of 1h change when Binance is primary. */
  private async fetchCoinGecko(): Promise<CoinData[]> {
    const data = await this.coingeckoGet<any[]>('/coins/markets', {
      vs_currency: 'usd',
      order: 'volume_desc',
      per_page: 100,
      page: 1,
      sparkline: false,
      price_change_percentage: '1h,24h',
    });

    return data.map((c: any) => ({
      symbol: String(c.symbol ?? '').toUpperCase(),
      pair: `${String(c.symbol ?? '').toUpperCase()}USDT`,
      name: c.name,
      current_price: c.current_price ?? 0,
      price_change_percentage_24h: c.price_change_percentage_24h ?? 0,
      price_change_percentage_1h: c.price_change_percentage_1h_in_currency ?? 0,
      total_volume: c.total_volume ?? 0,
      // Unverified — CoinGecko lists spot coins that may have no futures pair.
      onFutures: false,
    }));
  }

  private async fetchFearGreed(): Promise<{
    value: number;
    classification: string;
  }> {
    const resp = await axios.get('https://api.alternative.me/fng/', {
      timeout: 12000,
    });
    const d = resp.data?.data?.[0];
    return {
      value: parseInt(d?.value ?? '50', 10),
      classification: d?.value_classification ?? 'Neutral',
    };
  }
}
