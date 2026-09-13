import { Strategy } from '../backtest/types';
import { emaPullback } from './ema-pullback';
import { donchianBreakout } from './donchian-breakout';
import { meanReversion } from './mean-reversion';
import { volSqueeze } from './vol-squeeze';
import { tsMomentum } from './ts-momentum';
import { rangeBounce } from './range-bounce';
import { rsiDivergence } from './rsi-divergence';
import { sessionBreakout } from './session-breakout';
import { volumeThrust } from './volume-thrust';
import { mtfTrend } from './mtf-trend';

/**
 * Taramaya girecek stratejiler.
 *
 * Tek yerde tutulmasinin sebebi: yeni bir strateji eklemek tek satir olmali,
 * ve hicbir strateji "unutuldugu icin" taramanin disinda kalmamali. Eksik
 * kalan bir aday, elenmis bir aday gibi gorunur ama elenmemistir — sadece
 * hic olculmemistir.
 *
 * Yazi-tura kontrol grubu burada YOK: o her hucrede ayrica taban olarak
 * kosuluyor, aday olarak degil.
 *
 * Aileler bilerek birbirinin karsiti: trend takibi ile ortalamaya donus zit
 * hipotezlerdir. Ikisi de kaybediyorsa sorun fikirde degil rejimde ya da
 * maliyettedir — bunu ancak zit adaylari birlikte olcerek anlayabiliriz.
 */
export interface RegistryEntry {
  key: string;
  factory: () => Strategy;
}

export const ALL_STRATEGIES: RegistryEntry[] = [
  // --- Trend takibi ---
  { key: 'ema-pullback', factory: () => emaPullback() },
  {
    key: 'ema-pullback-fast',
    factory: () =>
      emaPullback({
        fast: 21,
        slow: 55,
        pull: 9,
        atrPeriod: 14,
        stopAtr: 1.5,
        rr: 2,
      }),
  },
  { key: 'donchian-55', factory: () => donchianBreakout() },
  {
    key: 'donchian-20',
    factory: () =>
      donchianBreakout({
        lookback: 20,
        atrPeriod: 14,
        stopAtr: 1.5,
        rr: 2,
        trendEma: 200,
      }),
  },
  { key: 'ts-momentum', factory: () => tsMomentum() },
  { key: 'mtf-trend', factory: () => mtfTrend() },

  // --- Ortalamaya donus / aralik ---
  { key: 'mean-reversion', factory: () => meanReversion() },
  { key: 'range-bounce', factory: () => rangeBounce() },
  { key: 'rsi-divergence', factory: () => rsiDivergence() },

  // --- Oynaklik / hacim / seans ---
  { key: 'vol-squeeze', factory: () => volSqueeze() },
  { key: 'session-breakout', factory: () => sessionBreakout() },
  { key: 'volume-thrust', factory: () => volumeThrust() },
];
