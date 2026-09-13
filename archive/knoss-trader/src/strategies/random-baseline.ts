import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { atrSeries } from '../core/ma';

/**
 * Yazi-tura kontrol grubu.
 *
 * Bir stratejinin "kazandigini" gormek tek basina hicbir sey soylemez;
 * kiyaslanacagi bir taban gerekir. Bu strateji rastgele yon seciyor ama
 * AYNI stop/hedef yapisini, ayni komisyonu ve ayni kaymayi kullaniyor.
 *
 * Iki isi var:
 *   1. Maliyet tabanini gosterir. Yazi-tura + komisyon her zaman eksidir;
 *      o eksinin ne kadar oldugunu bilmek, bir stratejinin ne kadarini
 *      sadece maliyetleri asmak icin harcadigini soyler.
 *   2. Sahte edge'i yakalar. Gercek strateji bunu anlamli sekilde
 *      gecemiyorsa ortada edge yok, sans var.
 *
 * Tohum sabit: ayni kosu ayni sonucu vermeli, yoksa karsilastirma anlamsiz.
 */
export function randomBaseline(
  seed = 42,
  tradeEveryN = 20,
  /**
   * Stop/hedef yapisi disaridan verilebilir olmali.
   *
   * Sebep metodolojik: "genis stop sonucu iyilestiriyor" bulgusunu test
   * ederken kontrol grubu ESKI yapida kalirsa karsilastirma sahte olur.
   * Genis stop islem sayisini dusurur, bu da komisyon yukunu azaltir —
   * yani yazi-tura bile "iyilesir". Gercek soru sudur: strateji, AYNI
   * yapidaki yazi-turadan daha fazla mi iyilesiyor?
   */
  stopAtr = 1.5,
  rr = 2,
): Strategy {
  let prepared: { ref: Bar[]; atr: (number | null)[] } | null = null;
  let state = seed;

  // Kucuk, deterministik LCG. Math.random() tohumlanamaz.
  const next = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    state = seed;
    prepared = {
      ref: bars,
      atr: atrSeries(
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        bars.map((b) => b.close),
        14,
      ),
    };
    return prepared;
  };

  return {
    name: `Yazi-tura kontrol (~${tradeEveryN} mumda bir, stop ${stopAtr} ATR, R:R ${rr})`,
    warmup: 20,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);
      const atrVal = p.atr[i];
      if (atrVal === null || atrVal <= 0) return null;

      // Gercek stratejilerle benzer sayida islem uretsin diye seyreltiliyor;
      // her mumda islem acmak karsilastirmayi maliyet tarafina carpitirdi.
      if (i % tradeEveryN !== 0) return null;

      const side = next() < 0.5 ? 'LONG' : 'SHORT';
      const entry = bars[i].close;
      const stopDist = atrVal * stopAtr;

      return {
        side,
        stopLoss: side === 'LONG' ? entry - stopDist : entry + stopDist,
        takeProfit:
          side === 'LONG' ? entry + stopDist * rr : entry - stopDist * rr,
        reason: 'rastgele',
      };
    },
  };
}
