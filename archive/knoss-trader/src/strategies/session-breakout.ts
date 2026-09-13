import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { atrSeries } from '../core/ma';

export interface SessionBreakoutParams {
  /** Gunun ilk kac saati "acilis araligini" olusturur. */
  rangeHours: number;
  atrPeriod: number;
  /** Stop kac ATR uzakta. */
  stopAtr: number;
  /** Hedef, riskin kac kati. */
  rr: number;
  /** Aralik genisligi en az kac ATR olmali. */
  minRangeAtr: number;
  /** Aralik genisligi en fazla kac ATR olabilir. */
  maxRangeAtr: number;
}

export const DEFAULT_SESSION_BREAKOUT: SessionBreakoutParams = {
  // 6 saat: UTC 00:00-06:00 kabaca Asya seansi. Gunun asil hacmi Avrupa
  // (07:00+) ve ABD (13:00+) acilislarinda geliyor; sakin seansta olusan
  // araligin o hacimle kirilmasi anlamli bir olay. 2 saat cok dar kalir
  // (gurultuyu aralik sanar), 12 saat gunun yarisini yer ve geriye islem
  // yapacak zaman birakmaz.
  rangeHours: 6,
  atrPeriod: 14,
  // 1.0 ATR: kirilim stratejisinde giris zaten hareketin basinda oldugu
  // icin geri cekilmeye 1.5-2 ATR pay vermek gereksiz genis stop demek;
  // yanlis kirilim hizli anlasilir, o yuzden daha siki duruyoruz.
  stopAtr: 1.0,
  rr: 2,
  // Aralik ATR'nin yarisindan darsa o gun fiyat neredeyse hic hareket
  // etmemis demektir; boyle bir araligi kirmak "olay" degil gurultudur.
  minRangeAtr: 0.5,
  // Aralik 4 ATR'den genisse gunun hareketi zaten yapilmis; kirilimda
  // girmek hareketin sonuna yetismektir.
  maxRangeAtr: 4,
};

/**
 * Gunluk acilis araligi kirilimi (opening range breakout).
 *
 * Kripto 7/24 ama gunluk bir dongusu var: fonlama saatleri, gunluk mum
 * kapanislari ve tureve dayali referanslarin hepsi UTC 00:00'a gore. Bu
 * yuzden gunun ilk saatlerinde olusan aralik, gun icin gercek bir referans
 * seviye isi goruyor — rastgele secilmis bir N mum degil.
 *
 * Kurallar ve NEDENleri:
 *
 *   1. Gun siniri Bar.openTime'dan (UTC ms) hesaplaniyor. Yerel saat
 *      kullanmak backtest'i calistiran makineye gore farkli sonuc uretirdi;
 *      borsanin dunyasi UTC.
 *   2. Aralik yalnizca gunun ILK bari 00:00'da baslayan gunlerde gecerli.
 *      Veri gunun ortasindan basliyorsa (ya da mum boslugu varsa) elimizdeki
 *      "aralik" gercek acilis araligi degildir; o gunu pas geciyoruz.
 *   3. Kirilim KAPANISLA olculuyor, fitille degil. Aralik sinirlarinin hemen
 *      otesi stop avinin toplandigi yerdir; fitil kirilimini kovalamak
 *      sistematik olarak en kotu fiyattan girmektir.
 *   4. Gunde EN FAZLA BIR islem: gunun ILK kirilimi. Ayni gun ikinci ve
 *      ucuncu kirilim, ilkinin yalanlandigi anlamina gelir; boyle gunlerde
 *      art arda girmek testere piyasasinda komisyonla erimenin tarifidir.
 *   5. Aralik genisligi ATR bandiyla suzuluyor (min/max): cok dar aralik
 *      gurultu, cok genis aralik gecikmis harekettir. Gunun ilk kirilimi bu
 *      filtreye takilirsa o gun hic islem yok — filtre gunu eler, kirilimi
 *      degil, cunku sonraki kirilimlar zaten kural 4'e takiliyor.
 *   6. Gunun son saatlerinde kirilim alinmiyor: giris bir sonraki mumun
 *      acilisinda oldugu icin gec sinyalin dolumu ertesi gune sarkar.
 *   7. Stop ATR'ye bagli — sabit yuzde stop BTC'de genis, oynak altcoinde
 *      gurultudur.
 *
 * Gelecege bakma yok: aralik yalnizca i. bardan ONCEKI (ayni gune ait)
 * barlardan olusuyor, sinyal i. mumun kapanisinda uretiliyor, motor girisi
 * i+1'in acilisinda yapiyor.
 */
export function sessionBreakout(
  params: SessionBreakoutParams = DEFAULT_SESSION_BREAKOUT,
): Strategy {
  const DAY_MS = 24 * 60 * 60 * 1000;

  let prepared: {
    ref: Bar[];
    /** i. barda gecerli olan (tamamlanmis) gunluk aralik; yoksa null. */
    rangeHigh: (number | null)[];
    rangeLow: (number | null)[];
    /** i. bar, kendi gununun ILK kirilim bari mi. */
    firstBreak: boolean[];
    atr: (number | null)[];
  } | null = null;

  /**
   * Tum seriyi tek gecisde hazirliyoruz. onBar her cagrildiginda gunu
   * bastan taramak 8760 mumluk kosuyu O(n^2) yapardi; ema-pullback'teki
   * onbellek deseninin sebebi tam olarak bu.
   *
   * Gunun "ilk kirilimi" bilgisini de burada isaretliyoruz. Bunu onBar
   * icinde bir sayacla tutmak cazip ama YANLIS olurdu: motor bir islem
   * acildiginda cikis barina atliyor, yani onBar her bar icin cagrilmiyor.
   * Ise yarayan tek yol, cagri sirasindan bagimsiz olarak diziden okumak.
   */
  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;

    const n = bars.length;
    const rangeHigh: (number | null)[] = new Array(n).fill(null);
    const rangeLow: (number | null)[] = new Array(n).fill(null);
    const firstBreak: boolean[] = new Array(n).fill(false);
    const rangeMs = params.rangeHours * 60 * 60 * 1000;

    // Gun boyunca tasinan durum. Hepsi yalnizca GECMIS barlardan doluyor.
    let dayKey = -1;
    let dayValid = false; // kural 2: gun 00:00'da basladi mi
    let hi = -Infinity;
    let lo = Infinity;
    let barsInRange = 0;
    let broken = false; // kural 4: bu gun kirilim yasandi mi

    for (let i = 0; i < n; i++) {
      const bar = bars[i];
      const key = Math.floor(bar.openTime / DAY_MS);
      const offset = bar.openTime - key * DAY_MS;

      if (key !== dayKey) {
        dayKey = key;
        // Gunun ilk gordugumuz bari tam 00:00'da acilmiyorsa aralik eksik
        // demektir (veri ortadan basliyor ya da bosluk var).
        dayValid = offset === 0;
        hi = -Infinity;
        lo = Infinity;
        barsInRange = 0;
        broken = false;
      }

      if (offset < rangeMs) {
        // Aralik penceresindeyiz: sadece biriktiriyoruz, henuz kirilim yok.
        // (Pencerenin son bari rangeMs'i asabilir — orn. 4s mumda 6 saatlik
        // pencere. Sorun degil: o bar da yalnizca kendinden SONRAKI barlara
        // referans oluyor, kendi kendini kiramiyor.)
        if (bar.high > hi) hi = bar.high;
        if (bar.low < lo) lo = bar.low;
        barsInRange++;
        continue;
      }

      // Pencere kapandi; aralik artik sabit. Buradaki hi/lo yalnizca i'den
      // ONCEKI barlardan geldigi icin gelecege bakma yok.
      if (!dayValid || barsInRange === 0) continue;

      rangeHigh[i] = hi;
      rangeLow[i] = lo;

      if (broken) continue; // gunun ilk kirilimi zaten olmus

      // Gunun son saatlerindeki kirilimi almiyoruz. Motor girisi BIR SONRAKI
      // mumun acilisindan yaptigi icin 23:00'taki bir sinyalin dolumu ertesi
      // gunun 00:00'ina dusuyor: yani pozisyon, kendi referans araligi
      // biterken aciliyor. Esik olarak aralik penceresi kadar sure
      // kullaniyoruz (ayri bir parametre eklemeye degmez): kirilimin gun
      // icinde calisacak en az o kadar zamani kalmali.
      if (offset >= DAY_MS - rangeMs) continue;

      if (bar.close > hi || bar.close < lo) {
        firstBreak[i] = true;
        broken = true;
      }
    }

    prepared = {
      ref: bars,
      rangeHigh,
      rangeLow,
      firstBreak,
      atr: atrSeries(
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        bars.map((b) => b.close),
        params.atrPeriod,
      ),
    };
    return prepared;
  };

  return {
    name:
      `Gunluk ${params.rangeHours}s acilis araligi kirilimi ` +
      `(stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    // ATR'nin ihtiyaci atrPeriod+1 bar; 24'luk taban ise en az bir tam gunun
    // geride kalmasini garantiler — verinin ilk gunu neredeyse her zaman
    // eksik olur ve eksik aralik uzerinden islem acmak istemiyoruz.
    warmup: Math.max(params.atrPeriod + 2, 24),

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      // Kural 4: gunun ilk kirilimi degilse hesaplamaya bile girmiyoruz.
      if (!p.firstBreak[i]) return null;

      const hi = p.rangeHigh[i];
      const lo = p.rangeLow[i];
      const atrVal = p.atr[i];
      if (hi === null || lo === null || atrVal === null || atrVal <= 0) {
        return null;
      }

      // Kural 5: aralik genisligini ATR ile olcekliyoruz ki ayni esik hem
      // BTC'de hem oynak bir altcoinde ayni seyi ifade etsin.
      const widthAtr = (hi - lo) / atrVal;
      if (widthAtr < params.minRangeAtr || widthAtr > params.maxRangeAtr) {
        return null;
      }

      const bar = bars[i];
      const side: 'LONG' | 'SHORT' = bar.close > hi ? 'LONG' : 'SHORT';
      const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak
      const stopDist = atrVal * params.stopAtr;

      return {
        side,
        stopLoss: side === 'LONG' ? entry - stopDist : entry + stopDist,
        takeProfit:
          side === 'LONG'
            ? entry + stopDist * params.rr
            : entry - stopDist * params.rr,
        reason:
          `Gunun ilk ${params.rangeHours} saatlik araliginin ` +
          `${side === 'LONG' ? 'ustten' : 'alttan'} kirilimi ` +
          `(genislik ${widthAtr.toFixed(1)} ATR)`,
      };
    },
  };
}
