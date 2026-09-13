import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { ema, atrSeries } from '../core/ma';

export interface EmaPullbackParams {
  fast: number;
  slow: number;
  /** Geri cekilmenin olculdugu ortalama. */
  pull: number;
  atrPeriod: number;
  /** Stop kac ATR uzakta. */
  stopAtr: number;
  /** Hedef, riskin kac kati. */
  rr: number;
}

export const DEFAULT_EMA_PULLBACK: EmaPullbackParams = {
  fast: 50,
  slow: 200,
  pull: 20,
  atrPeriod: 14,
  stopAtr: 1.5,
  rr: 2,
};

/**
 * Trend + geri cekilme.
 *
 * Eski botun denetci modeli her reddinde ayni seyi soyluyordu: "momentuma
 * karsi girme, geri cekilme onayi bekle". Bu strateji tam olarak onu
 * kurallastiriyor:
 *
 *   1. Trend: EMA50 > EMA200 ise yukselis, tersi ise dusus. Trende KARSI
 *      islem yok — kovalamacanin ve dusen bicagin kaynagi buydu.
 *   2. Geri cekilme: fiyat EMA20'nin ters tarafina sarkmis olmali. Trend
 *      yonunde ama zirveden giris "kovalamaca"dir.
 *   3. Devam onayi: mum EMA20'nin trend tarafina KAPANMALI. Sarkmanin
 *      kendisi yeterli degil; dusen bicak da sarkiyor.
 *   4. Stop ATR ile: sabit yuzde stop, BTC'de genis ZRO'da gurultudur.
 *   5. Hedef riskin kati: R:R sabit, boylece isabet oraniyla beklenti
 *      arasindaki iliski olculebilir kaliyor.
 *
 * Gelecege bakma yok: her sey i. mum ve oncesinden hesaplaniyor, sinyal
 * i. mumun kapanisinda olusuyor, motor girisi i+1'in acilisinda yapiyor.
 */
export function emaPullback(
  params: EmaPullbackParams = DEFAULT_EMA_PULLBACK,
): Strategy {
  let prepared: {
    ref: Bar[];
    emaFast: (number | null)[];
    emaSlow: (number | null)[];
    emaPull: (number | null)[];
    atr: (number | null)[];
  } | null = null;

  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const closes = bars.map((b) => b.close);
    prepared = {
      ref: bars,
      emaFast: ema(closes, params.fast),
      emaSlow: ema(closes, params.slow),
      emaPull: ema(closes, params.pull),
      atr: atrSeries(
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        closes,
        params.atrPeriod,
      ),
    };
    return prepared;
  };

  return {
    name: `EMA${params.fast}/${params.slow} geri cekilme (stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    warmup: Math.max(params.slow, params.atrPeriod) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      const fast = p.emaFast[i];
      const slow = p.emaSlow[i];
      const pull = p.emaPull[i];
      const atrVal = p.atr[i];
      const prevPull = p.emaPull[i - 1];

      if (
        fast === null ||
        slow === null ||
        pull === null ||
        prevPull === null ||
        atrVal === null ||
        atrVal <= 0
      ) {
        return null;
      }

      const bar = bars[i];
      const prev = bars[i - 1];
      const up = fast > slow;
      const down = fast < slow;

      // 2 + 3: onceki mum EMA20'nin ters tarafinda kapanmis (geri cekilme),
      // bu mum trend tarafina donmus (onay).
      const longSetup = up && prev.close < prevPull && bar.close > pull;
      const shortSetup = down && prev.close > prevPull && bar.close < pull;

      if (!longSetup && !shortSetup) return null;

      const side = longSetup ? 'LONG' : 'SHORT';
      const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak
      const stopDist = atrVal * params.stopAtr;

      const stopLoss = side === 'LONG' ? entry - stopDist : entry + stopDist;
      const takeProfit =
        side === 'LONG'
          ? entry + stopDist * params.rr
          : entry - stopDist * params.rr;

      return {
        side,
        stopLoss,
        takeProfit,
        reason:
          `${side === 'LONG' ? 'Yukselis' : 'Dusus'} trendinde EMA${params.pull} ` +
          `geri cekilmesinden donus`,
      };
    },
  };
}
