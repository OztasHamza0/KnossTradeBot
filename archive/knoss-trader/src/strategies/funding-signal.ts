import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { FundingPoint } from '../data/funding';
import { atrSeries } from '../core/ma';

/**
 * FONLAMA ORANI — SINYAL olarak (hasat olarak DEGIL).
 *
 * NEDEN BU EKSEN FARKLI: bugune kadar denenen alti hipotezin hepsi islem
 * gorulen varligin kendi OHLCV'sini kullandi. Isimleri zit olsa da
 * (trend takibi / ortalamaya donus / kirilim / sikisma) bilgi kaynagi
 * ayniydi: gecmis fiyat. Hepsi ayni duvara tosladi ve bu tesaduf degil —
 * ayni bilgiden farkli sonuc cikmaz.
 *
 * Fonlama orani fiyatta OLMAYAN bir sey tasir: KONUMLANMA.
 *   Pozitif fonlama = long'lar short'lara oduyor = long tarafi kalabalik
 *   ve o kalabaligin tasima maliyeti var.
 * Bu, mum grafiginden okunamaz. Farkli bir bilgi sinifi.
 *
 * HIPOTEZ (kontrarian): asiri fonlama, asiri kalabalik demektir; kalabalik
 * taraf tasima maliyeti altinda ezilir ve pozisyonlar zorla kapanir.
 * Yani asiri POZITIF fonlamada SHORT, asiri NEGATIF fonlamada LONG.
 *
 * Zit hipotez de (momentum) ayni kodla test edilir — `contrarian: false`.
 * Ikisi birden olculmeli: biri kazandiriyorsa digeri kaybettirir, ve
 * ikisi de kaybettiriyorsa sorun yonde degil MALIYETTEDIR.
 *
 * === GELECEGE BAKMAMA — bu dosyanin en kritik yeri ===
 * Fonlama 8 SAATTE BIR yayinlanir (00:00, 08:00, 16:00 UTC). Bir mumun
 * kapanisinda YALNIZCA o ana kadar YAYINLANMIS oranlar bilinir.
 * `bars[i].closeTime`'dan SONRA yayinlanan bir orani kullanmak, backtest'i
 * kahin yapar — ve bu hata sessizdir: sonuc harika gorunur, canlida coker.
 *
 * Hizalama ZAMANA gore yapiliyor, indekse gore DEGIL. Yuzdelik de yalnizca
 * GECMIS fonlama noktalarindan hesaplaniyor.
 */

export interface FundingSignalParams {
  /** Yuzdelik hesabinda kac gecmis fonlama noktasi kullanilsin. */
  lookback: number;
  /** Uc dilim genisligi (%). 20 = en ust %20 ve en alt %20. */
  edgePct: number;
  atrPeriod: number;
  stopAtr: number;
  rr: number;
  /** true = kalabaligin TERSINE, false = fonlama yonunde. */
  contrarian: boolean;
  /**
   * Asgari mutlak fonlama orani (donem basina, 0.0001 = %0.01).
   * Sifira yakin oranlarda "uc dilim" gurultudur: sakin bir donemde en
   * yuksek %20 bile hicbir kalabalik anlatmaz. Bu kapi, sinyali gercekten
   * dikkate deger fonlama seviyeleriyle sinirlar.
   */
  minAbsRate: number;
}

export const DEFAULT_FUNDING_SIGNAL: FundingSignalParams = {
  lookback: 90, // 90 x 8 saat = 30 gun
  edgePct: 20,
  atrPeriod: 14,
  stopAtr: 2,
  rr: 2,
  contrarian: true,
  minAbsRate: 0.0001, // %0.01 donem basina
};

/**
 * Her mum icin: o mumun KAPANISINDA bilinen en son fonlama orani ve o
 * oranin gecmis penceredeki yuzdeligi.
 *
 * Donen dizi bars ile ayni uzunlukta. Bilinmiyorsa null.
 */
export function hizalaFunding(
  bars: Bar[],
  funding: FundingPoint[],
  lookback: number,
): { rate: (number | null)[]; pct: (number | null)[] } {
  const rate: (number | null)[] = new Array(bars.length).fill(null);
  const pct: (number | null)[] = new Array(bars.length).fill(null);
  if (!bars.length || !funding.length) return { rate, pct };

  // Fonlama zaman sirali olmali; garanti altina al.
  const f = [...funding].sort((a, b) => a.time - b.time);

  let j = 0; // f icinde ilerleyen imlec
  for (let i = 0; i < bars.length; i++) {
    const kapanis = bars[i].closeTime;
    // KAPANISTAN SONRA yayinlanani ASLA alma. `<=` sart.
    while (j < f.length && f[j].time <= kapanis) j++;
    // j simdi ilk "gelecek" noktayi gosteriyor; bilinen son nokta j-1.
    const bilinen = j - 1;
    if (bilinen < 0) continue;

    rate[i] = f[bilinen].rate;

    // Yuzdelik YALNIZCA gecmis noktalardan — bilinen dahil, sonrasi haric.
    const bas = Math.max(0, bilinen - lookback + 1);
    const pencere = f.slice(bas, bilinen + 1);
    if (pencere.length < Math.min(20, lookback)) continue;

    /**
     * ORTANCA-SIRA (midrank) — esitler yok sayilamaz.
     *
     * Ilk hali yalnizca `rate < su` sayiyordu. Fonlamanin SABIT kaldigi
     * bir donemde (ki olur: sakin piyasada oran gunlerce ayni cakilir)
     * hicbir deger digerinden kucuk olmaz, yuzdelik %0 cikar ve strateji
     * bunu "asiri DUSUK fonlama" sanip ALT dilim sinyali uretir.
     * Yani sabit ve olagan bir fonlama, sahte bir uc deger gibi okunur.
     *
     * Esitlerin yarisini saymak (standart midrank) bunu duzeltir:
     * tamamen sabit bir pencere %50 verir — yani "ortada", ki dogrusu bu.
     */
    const su = f[bilinen].rate;
    let kucuk = 0;
    let esit = 0;
    for (const p of pencere) {
      if (p.rate < su) kucuk++;
      else if (p.rate === su) esit++;
    }
    pct[i] = ((kucuk + esit / 2) / pencere.length) * 100;
  }

  return { rate, pct };
}

export function fundingSignal(
  funding: FundingPoint[],
  params: FundingSignalParams = DEFAULT_FUNDING_SIGNAL,
): Strategy {
  let prepared: {
    ref: Bar[];
    rate: (number | null)[];
    pct: (number | null)[];
    atr: (number | null)[];
  } | null = null;

  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const h = hizalaFunding(bars, funding, params.lookback);
    prepared = {
      ref: bars,
      rate: h.rate,
      pct: h.pct,
      atr: atrSeries(
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        bars.map((b) => b.close),
        params.atrPeriod,
      ),
    };
    return prepared;
  };

  const yon = params.contrarian ? 'kontrarian' : 'momentum';

  return {
    name:
      `Fonlama ${yon} (pencere ${params.lookback}, uc %${params.edgePct}, ` +
      `stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    warmup: Math.max(params.atrPeriod, 30) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);
      const atrVal = p.atr[i];
      if (atrVal === null || !(atrVal > 0)) return null;

      const su = p.pct[i];
      const onceki = i > 0 ? p.pct[i - 1] : null;
      const oran = p.rate[i];
      if (su === null || onceki === null || oran === null) return null;

      // Sakin donemde "uc dilim" gurultudur.
      if (Math.abs(oran) < params.minAbsRate) return null;

      const ust = 100 - params.edgePct;
      const alt = params.edgePct;

      // UC DILIME GECIS tetikler — dilimin ICINDE durmak degil.
      // Icinde durmak her mumda sinyal uretirdi ve strateji, fonlama
      // yuksek kaldigi surece ayni yonde ust uste girerdi.
      const ustGecis = onceki < ust && su >= ust;
      const altGecis = onceki > alt && su <= alt;
      if (!ustGecis && !altGecis) return null;

      // Asiri POZITIF fonlama = long kalabaligi.
      //   kontrarian -> SHORT ;  momentum -> LONG
      let side: 'LONG' | 'SHORT';
      if (ustGecis) side = params.contrarian ? 'SHORT' : 'LONG';
      else side = params.contrarian ? 'LONG' : 'SHORT';

      const entry = bars[i].close;
      const stopDist = atrVal * params.stopAtr;

      // ts-momentum'daki dersin aynisi: cokus mumlarinda ATR fiyatin
      // yarisini asabilir ve stop sifirin altina duser. Motor stopu
      // `low <= stopLoss` diye aradigi icin boyle bir islem ASLA zararla
      // kapanmaz — olcumu sessizce sisirir.
      const stopLoss = side === 'LONG' ? entry - stopDist : entry + stopDist;
      const takeProfit =
        side === 'LONG' ? entry + stopDist * params.rr : entry - stopDist * params.rr;
      if (stopLoss <= 0 || takeProfit <= 0) return null;

      return {
        side,
        stopLoss,
        takeProfit,
        reason:
          `fonlama ${(oran * 100).toFixed(4)}% ` +
          `(yuzdelik ${su.toFixed(0)}, ${ustGecis ? 'ust' : 'alt'} dilime gecis)`,
      };
    },
  };
}
