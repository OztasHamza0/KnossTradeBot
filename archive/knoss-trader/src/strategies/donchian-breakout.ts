import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { atrSeries, rollingExtremes, ema } from '../core/ma';

export interface BreakoutParams {
  lookback: number;
  atrPeriod: number;
  stopAtr: number;
  rr: number;
  /** Trend filtresi; 0 = filtre yok. */
  trendEma: number;
}

export const DEFAULT_BREAKOUT: BreakoutParams = {
  lookback: 55,
  atrPeriod: 14,
  stopAtr: 1.5,
  rr: 2,
  trendEma: 200,
};

/**
 * Donchian kirilimi — klasik trend takibi.
 *
 * EMA geri cekilmesinin tam tersi bir fikir: geri cekilmeyi beklemek yerine
 * yeni bir uc noktanin kirilmasini bekliyor. Ikisini birden test etmenin
 * sebebi su: hangi fikrin bu piyasada calistigini tahmin degil OLCUM
 * belirlemeli. Ikisi de kaybettiriyorsa cevabi bilmek, yanlis olani canliya
 * almaktan iyidir.
 *
 * Trend filtresi opsiyonel ama varsayilan acik: filtresiz kirilim yatay
 * piyasada surekli yanlis sinyal uretir ve komisyonla erir.
 */
export function donchianBreakout(
  params: BreakoutParams = DEFAULT_BREAKOUT,
): Strategy {
  let prepared: {
    ref: Bar[];
    highest: (number | null)[];
    lowest: (number | null)[];
    atr: (number | null)[];
    trend: (number | null)[];
  } | null = null;

  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);
    const ext = rollingExtremes(highs, lows, params.lookback);
    prepared = {
      ref: bars,
      highest: ext.highest,
      lowest: ext.lowest,
      atr: atrSeries(highs, lows, closes, params.atrPeriod),
      trend: params.trendEma > 0 ? ema(closes, params.trendEma) : [],
    };
    return prepared;
  };

  return {
    name:
      `Donchian ${params.lookback} kirilim (stop ${params.stopAtr} ATR, R:R ${params.rr}` +
      (params.trendEma > 0 ? `, EMA${params.trendEma} filtresi` : '') +
      ')',
    warmup: Math.max(params.lookback, params.trendEma, params.atrPeriod) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);
      const atrVal = p.atr[i];
      // Kirilim ONCEKI mumun ucuna gore olculmeli; bu mumun kendi yuksegini
      // dahil etmek "kendi kendini kirmak" olur ve her mumda sinyal uretir.
      const prevHigh = p.highest[i - 1];
      const prevLow = p.lowest[i - 1];

      if (atrVal === null || atrVal <= 0 || prevHigh === null || prevLow === null) {
        return null;
      }

      const bar = bars[i];
      const trendVal = params.trendEma > 0 ? p.trend[i] : null;
      if (params.trendEma > 0 && trendVal === null) return null;

      const upOk = trendVal === null || bar.close > trendVal;
      const downOk = trendVal === null || bar.close < trendVal;

      const longSetup = bar.close > prevHigh && upOk;
      const shortSetup = bar.close < prevLow && downOk;
      if (!longSetup && !shortSetup) return null;

      const side = longSetup ? 'LONG' : 'SHORT';
      const entry = bar.close;
      const stopDist = atrVal * params.stopAtr;

      return {
        side,
        stopLoss: side === 'LONG' ? entry - stopDist : entry + stopDist,
        takeProfit:
          side === 'LONG'
            ? entry + stopDist * params.rr
            : entry - stopDist * params.rr,
        reason: `${params.lookback} mumluk ${side === 'LONG' ? 'tepe' : 'dip'} kirilimi`,
      };
    },
  };
}
