import { Injectable, Logger } from '@nestjs/common';
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
  warnings: string[];
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
  private cache: MarketOverview | null = null;
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 2 * 60 * 1000; // 2 minutes

  private readonly BINANCE_HOSTS = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
  ];

  /** Leveraged tokens and index products — never valid futures entries */
  private readonly EXCLUDED = /(UPUSDT|DOWNUSDT|BULLUSDT|BEARUSDT)$/;

  async getMarketData(): Promise<MarketOverview> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }
    const data = await this.fetchFreshData();
    this.cache = data;
    this.cacheExpiry = Date.now() + this.CACHE_TTL;
    return data;
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

    if (binance.length > 0) {
      source = 'binance';
      top50 = binance.map((b) => {
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
      warnings,
    };
  }

  /**
   * Top 50 USDT-margined perpetuals by 24h quote volume.
   * One bulk request covers every symbol.
   */
  private async fetchBinanceFutures(): Promise<CoinData[]> {
    let lastError: any;

    for (const host of this.BINANCE_HOSTS) {
      try {
        const resp = await axios.get<BinanceTicker[]>(
          `${host}/fapi/v1/ticker/24hr`,
          {
            timeout: 12000,
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
          .sort((a, b) => b.total_volume - a.total_volume)
          .slice(0, 50);
      } catch (error: any) {
        lastError = error;
        this.logger.warn(`Binance host ${host} failed: ${error?.message}`);
      }
    }

    throw lastError ?? new Error('All Binance hosts unreachable');
  }

  /** Fallback feed, and the source of 1h change when Binance is primary. */
  private async fetchCoinGecko(): Promise<CoinData[]> {
    const resp = await axios.get(
      'https://api.coingecko.com/api/v3/coins/markets',
      {
        params: {
          vs_currency: 'usd',
          order: 'volume_desc',
          per_page: 100,
          page: 1,
          sparkline: false,
          price_change_percentage: '1h,24h',
        },
        timeout: 15000,
      },
    );

    return resp.data.map((c: any) => ({
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
      timeout: 10000,
    });
    const d = resp.data?.data?.[0];
    return {
      value: parseInt(d?.value ?? '50', 10),
      classification: d?.value_classification ?? 'Neutral',
    };
  }
}
