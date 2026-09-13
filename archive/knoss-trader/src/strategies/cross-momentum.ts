import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { atrSeries } from '../core/ma';
import { RankLookup } from '../backtest/cross-section';

export interface CrossMomentumParams {
  /** Siralama getirisinin olculdugu pencere (mum). */
  lookback: number;
  /**
   * Uc dilim genisligi (0..0.5). 0.2 = en guclu %20'ye LONG,
   * en zayif %20'ye SHORT.
   */
  edgePct: number;
  atrPeriod: number;
  stopAtr: number;
  rr: number;
  /**
   * false = momentum (guclu al, zayif sat)
   * true  = kesitsel ortalamaya donus (zayif al, guclu sat)
   *
   * Ikisi ZIT hipotez ve ikisi de test edilmeli: hangisinin gecerli
   * oldugunu tahmin degil olcum soylemeli. Ayni sebeple donchian
   * (kirilim) ve range-bounce (kenardan donus) birlikte olculmustu.
   */
  contrarian: boolean;
}

export const DEFAULT_CROSS_MOMENTUM: CrossMomentumParams = {
  /**
   * 168 mum = 1 saatlikte bir hafta. Akademik kesitsel momentum
   * hisse senedinde 1-12 AY penceresi kullanir; kripto ayni hikayeyi
   * cok daha hizli yasadigi icin olcek kucultuldu (ts-momentum.ts'teki
   * ayni gerekce).
   */
  lookback: 168,
  /**
   * %20: 20 sembollu bir evrende her iki uçta 4 sembol. Daha dar (%10)
   * iki sembol birakir ve sinyal sayisini istatistiksel olarak anlamsiz
   * kilar; daha genis (%33) "uc" kavramini anlamsizlastirir.
   */
  edgePct: 0.2,
  /**
   * Diger stratejilerle AYNI birakildi. Farkli stop mantiklariyla
   * kiyaslarsak hangi FIKRIN kazandigini degil, hangi STOPUN sansli
   * oldugunu olcmus oluruz.
   */
  atrPeriod: 14,
  stopAtr: 2,
  rr: 2,
  contrarian: false,
};

/**
 * KESITSEL MOMENTUM — goreli guc.
 *
 * Tek varlik stratejilerinin goremedigi bilgiyi kullanir: bu varlik,
 * DIGERLERINE GORE nerede duruyor? Hipotez, hisse senedi piyasalarinda
 * uzun suredir belgelenen kesitsel momentum anomalisinin kriptoda da
 * gorunup gorunmedigi.
 *
 * Kurallar:
 *  1. Her mumda tum evren `lookback` mumluk getiriye gore siralanir.
 *  2. Sembol en ust `edgePct` dilime GIRDIGI mumda LONG sinyali olusur
 *     (contrarian ise en alt dilime girdiginde).
 *  3. TETIK GECIStir, "icinde olmak" degil. Dilimin icinde durmak her
 *     mumda sinyal uretirdi; motor cikistan sonraki mumdan devam ettigi
 *     icin bu, ayni pozisyona surekli yeniden girmek olurdu ve olculen
 *     sey strateji degil komisyon olurdu.
 *  4. Stop ATR ile, hedef riskin kati — diger stratejilerle ayni yapi,
 *     boylece sonuclar karsilastirilabilir kalir.
 *
 * GELECEGE BAKMA YOK: siralama i. mumun kapanisindan ve `lookback` mum
 * oncesinden hesaplanir; tetik i-1 ile i arasindaki GECISe bakar; sinyal
 * i. mumun kapanisinda olusur; motor girisi i+1'in acilisinda yapar.
 */
export function crossMomentum(
  rank: RankLookup,
  params: CrossMomentumParams = DEFAULT_CROSS_MOMENTUM,
): Strategy {
  let cache: { bars: Bar[]; atr: (number | null)[] } | null = null;

  /** Gostergeler mum dizisi basina BIR KEZ — her onBar'da yeniden
   * hesaplamak 8760 mumluk kosuyu O(n^2) yapardi. */
  const prepare = (bars: Bar[]) => {
    if (cache && cache.bars === bars) return cache;
    cache = {
      bars,
      atr: atrSeries(
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        bars.map((b) => b.close),
        params.atrPeriod,
      ),
    };
    return cache;
  };

  const ustEsik = 1 - params.edgePct;
  const altEsik = params.edgePct;

  return {
    name:
      `Kesitsel ${params.contrarian ? 'ortalamaya donus' : 'momentum'} ` +
      `${params.lookback} mum, uc %${(params.edgePct * 100).toFixed(0)} ` +
      `(stop ${params.stopAtr} ATR, R:R ${params.rr})`,

    warmup: Math.max(params.lookback, params.atrPeriod) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      if (i < 1) return null;
      const p = prepare(bars);

      const simdi = rank(bars[i].openTime);
      const once = rank(bars[i - 1].openTime);
      // "Bilmiyorum" ile "ortada" ayni sey degil: evren dar oldugunda
      // rank null doner ve sinyal URETILMEZ.
      if (simdi === null || once === null) return null;

      const atrVal = p.atr[i];
      if (atrVal === null || !(atrVal > 0)) return null;

      // Tetik: dilime GECIS.
      const ustGecis = once < ustEsik && simdi >= ustEsik;
      const altGecis = once > altEsik && simdi <= altEsik;

      let side: 'LONG' | 'SHORT' | null = null;
      if (params.contrarian) {
        if (altGecis) side = 'LONG';
        else if (ustGecis) side = 'SHORT';
      } else {
        if (ustGecis) side = 'LONG';
        else if (altGecis) side = 'SHORT';
      }
      if (!side) return null;

      const entry = bars[i].close;
      const stopDist = atrVal * params.stopAtr;

      const stopLoss = side === 'LONG' ? entry - stopDist : entry + stopDist;
      const takeProfit =
        side === 'LONG' ? entry + stopDist * params.rr : entry - stopDist * params.rr;

      /**
       * Cokus mumlarinda ATR fiyatin yarisini asabiliyor; o zaman LONG'un
       * stopu SIFIRIN ALTINA duser ve motor "low <= stopLoss" diye aradigi
       * icin boyle bir islem ASLA zararla kapanmaz — olcum, gercekte var
       * olmayan risksiz bir islem uretir. (ts-momentum.ts'teki ayni kapi.)
       */
      if (stopLoss <= 0 || takeProfit <= 0) return null;

      return {
        side,
        stopLoss,
        takeProfit,
        reason:
          `kesitsel yuzdelik ${(once * 100).toFixed(0)} -> ${(simdi * 100).toFixed(0)}`,
      };
    },
  };
}
