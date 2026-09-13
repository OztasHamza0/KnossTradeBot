import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { atrSeries } from '../core/ma';

export interface RsiDivergenceParams {
  rsiPeriod: number;
  /**
   * Bir salinim noktasinin solunda ve saginda kac mum daha kotu olmali.
   * Bu ayni zamanda ONAY GECIKMESIDIR: bir dip, ancak kendisinden
   * `pivotBars` mum SONRA "dip idi" diye bilinebilir.
   */
  pivotBars: number;
  /** Karsilastirilan iki salinim arasindaki en fazla mum mesafesi. */
  maxGap: number;
  atrPeriod: number;
  /** Stop kac ATR uzakta (yapisal stop bundan genisse o kazanir). */
  stopAtr: number;
  /** Hedef, riskin kac kati. */
  rr: number;
}

export const DEFAULT_RSI_DIVERGENCE: RsiDivergenceParams = {
  // 14: Wilder'in orijinal periyodu ve indicators.ts'teki rsi() ile ayni.
  // Iki yerde farkli periyot kullanmak, canli botun gordugu sayi ile
  // backtest'in olctugu sayiyi sessizce ayirirdi.
  rsiPeriod: 14,
  // 3: dibin solunda ve saginda ucer mum. 2 gurultuyu de "salinim" sayar;
  // 5 ise onayi 5 mum geciktirir — bir donus sinyali icin bu, hareketin
  // buyuk kismini kacirtacak kadar uzun bir gecikme.
  pivotBars: 3,
  // 60: iki dip arasinda en fazla 60 mum. Daha uzagindaki bir dip artik
  // "ayni dususun ikinci ayagi" degil, baska bir piyasa rejimidir; onunla
  // uyumsuzluk kurmak sinyal degil gurultu uretir.
  maxGap: 60,
  atrPeriod: 14,
  // 1.5: indicators.ts'teki MIN_STOP_ATR ile ayni taban. Daha yakin bir
  // stop normal oynaklikta supurulur, isabetli tahmin bile zarar yazar.
  stopAtr: 1.5,
  rr: 2,
};

/**
 * Uyumsuzlugun "gercek" sayilmasi icin ILK salinimin RSI'si bu uclarda olmali.
 *
 * NEDEN: uyumsuzluk her yerde gorunur ama anlami yalnizca ucta vardir. RSI
 * 52'den 54'e cikarken olusan "uyumsuzluk" tukenme degil, sadece yatay
 * piyasadir. Sinirlar klasik 30/70 yerine 40/60: 30 esigi saatlik grafikte
 * o kadar az ornek birakiyor ki olcum istatistiksel olarak anlamsizlasiyor.
 */
const RSI_ALT_UC = 40;
const RSI_UST_UC = 60;

/**
 * Iki salinimin RSI'lari arasinda aranan en kucuk fark (puan).
 *
 * NEDEN: 0.2 puanlik fark uyumsuzluk degil yuvarlama gurultusudur; boyle
 * "uyumsuzluk"lardan her veri setinde yuzlercesi bulunur ve strateji
 * yazi-turaya doner.
 */
const MIN_RSI_FARKI = 2;

/**
 * Wilder RSI serisi.
 *
 * indicators.ts'teki rsi() ile ayni sayiyi uretir ama TUM seriyi tek gecisde
 * verir. O fonksiyonu her mumda bars[0..i] ile cagirmak O(n^2) olurdu ve
 * 8760 mumluk bir kosu dakikalarca surerdi.
 *
 * Gelecege bakma yok: out[i] yalnizca closes[0..i]'ye dayanir.
 */
export function rsiSeries(closes: number[], period = 14): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < n; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  // Hic kayip yoksa bolme tanimsizdir. 100 (duz seride 50) donmek
  // indicators.ts'teki davranisin aynisi: iki uygulama ayrisirsa canli bot
  // ile backtest ayni mumda sessizce farkli karar verir.
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Salinim (pivot) noktalari.
 *
 * flags[k] = true demek: values[k], [k-L, k+L] penceresinin ucu. Bu deger
 * k+L. muma kadarki mumlara bakar — yani k. mumda HENUZ BILINEMEZ. Diziyi
 * tum seri icin onceden hesaplamak serbest, ama onBar bunu YALNIZCA
 * k <= i - L kosuluyla okumak zorunda. Bu ailedeki klasik gelecege bakma
 * hatasi tam burada olusur: dibi olustugu anda "gormek" backtest'i kahin
 * yapar, canlida boyle bir bilgi yoktur.
 *
 * Esitlik kurali: solda <=, sagda kesin <. Boylece ayni seviyedeki bitisik
 * diplerden yalnizca SONUNCUSU pivot sayilir; hem tekrarli sinyal onlenir
 * hem onay mumu deterministik kalir.
 */
function pivotFlags(
  values: number[],
  left: number,
  lookForLow: boolean,
): boolean[] {
  const n = values.length;
  const flags: boolean[] = new Array(n).fill(false);

  for (let k = left; k < n - left; k++) {
    let ok = true;
    for (let j = k - left; j < k && ok; j++) {
      ok = lookForLow ? values[k] <= values[j] : values[k] >= values[j];
    }
    for (let j = k + 1; j <= k + left && ok; j++) {
      ok = lookForLow ? values[k] < values[j] : values[k] > values[j];
    }
    flags[k] = ok;
  }
  return flags;
}

/**
 * "k veya oncesindeki en son pivot" tablosu.
 *
 * onBar her mumda geriye dogru tarasaydi maliyet maxGap ile carpilirdi; bu
 * tek gecis ayni cevabi O(1) verir. Diziyi tum seri icin doldurmak gelecege
 * bakma DEGILDIR: her hucre yalnizca kendi indeksine kadarki pivot
 * bayraklarini ozetler, onBar da hucreyi i-L'den ileride okumaz.
 */
function lastPivotIndex(flags: boolean[]): number[] {
  const out: number[] = new Array(flags.length).fill(-1);
  let last = -1;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) last = i;
    out[i] = last;
  }
  return out;
}

/**
 * RSI uyumsuzlugu — donus (mean reversion) stratejisi.
 *
 * EMA geri cekilmesi ve Donchian kirilimi trendle birlikte gider; bu ise
 * trendin BITTIGINI iddia eder. Ucunu birlikte olcmenin sebebi, hangi
 * fikrin bu piyasada calistigina tahminle degil olcumle karar vermek.
 *
 * Kurallar (long icin; short tarafi tam aynasi):
 *   1. Iki ONAYLANMIS salinim dibi bul. Onaylanmis = dipten sonra
 *      `pivotBars` mum gecmis ve hepsi daha yuksek dip yapmis.
 *   2. Fiyat daha DUSUK dip yapmis ama RSI daha YUKSEK dip yapmis: satis
 *      baskisi yeni fiyat dibini artik destekleyemiyor demektir.
 *   3. Ilk dibin RSI'si ucta (< 40) olmali — ortada olusan uyumsuzluk
 *      tukenme degil yatay piyasadir.
 *   4. Sinyal, YENI dibin onaylandigi mumda uretilir (i = dip + pivotBars).
 *      Boylece ayni uyumsuzluk onlarca mum boyunca tekrar tekrar sinyal
 *      vermez ve giris gecikmesi her islemde ayni kalir — olculebilirlik
 *      icin sabit gecikme, degisken gecikmeden iyidir.
 *   5. Fiyat onayi: kapanis, dip mumunun kapanisinin ustunde olmali.
 *      Uyumsuzluk tek basina dusen bicagi yakalatir.
 *   6. Stop hem ATR'ye hem YAPIYA dayanir: dibin biraz altina konur ama
 *      asla `stopAtr` ATR'den yakin olamaz. Dibin USTUNDEKI bir stop, tez
 *      yanlislanmadan once sadece gurultuyle supurulur.
 *
 * Gelecege bakma yok: pivot dizileri tum seriden hesaplansa da onBar
 * yalnizca i - pivotBars indeksine kadar okur, o pivotun bilgisi de en
 * fazla i. muma dayanir. Sinyal i. mumun kapanisinda olusur, motor girisi
 * i+1'in acilisindan yapar.
 */
export function rsiDivergence(
  params: RsiDivergenceParams = DEFAULT_RSI_DIVERGENCE,
): Strategy {
  let prepared: {
    ref: Bar[];
    rsi: (number | null)[];
    atr: (number | null)[];
    lastLow: number[];
    lastHigh: number[];
  } | null = null;

  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);
    prepared = {
      ref: bars,
      rsi: rsiSeries(closes, params.rsiPeriod),
      atr: atrSeries(highs, lows, closes, params.atrPeriod),
      lastLow: lastPivotIndex(pivotFlags(lows, params.pivotBars, true)),
      lastHigh: lastPivotIndex(pivotFlags(highs, params.pivotBars, false)),
    };
    return prepared;
  };

  return {
    name:
      `RSI${params.rsiPeriod} uyumsuzlugu (pivot ${params.pivotBars}, ` +
      `stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    // Iki pivot + aralarindaki mesafe + gostergelerin kendi isinmasi.
    // Yalnizca rsiPeriod yazsaydik ilk sinyaller tek pivotla, yani
    // yarim hesaplanmis bir yapiyla uretilirdi.
    warmup:
      Math.max(params.rsiPeriod, params.atrPeriod) +
      params.maxGap +
      params.pivotBars * 2 +
      2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      // Bu mumda onayi tamamlanmis OLABILECEK en yeni pivot indeksi.
      // Bundan ilerisini okumak dogrudan gelecege bakmaktir.
      const confirmable = i - params.pivotBars;
      if (confirmable < 1) return null;

      const atrVal = p.atr[i];
      if (atrVal === null || atrVal <= 0) return null;

      // BOGACI (long): daha dusuk fiyat dibi + daha yuksek RSI dibi.
      // Kural 4: yalnizca pivotun tam onaylandigi mumda tetikle.
      const lowNew = p.lastLow[confirmable];
      if (lowNew === confirmable) {
        const lowOld = lowNew > 0 ? p.lastLow[lowNew - 1] : -1;
        const sig = check(bars, p, params, i, lowOld, lowNew, atrVal, 'LONG');
        if (sig) return sig;
      }

      // AYICI (short): daha yuksek fiyat tepesi + daha dusuk RSI tepesi.
      // Ayni mumda ikisi de cikarsa long once degerlendirilir; motor tek
      // sinyal aliyor ve rastgele degil sabit bir oncelik gerekiyor.
      const highNew = p.lastHigh[confirmable];
      if (highNew === confirmable) {
        const highOld = highNew > 0 ? p.lastHigh[highNew - 1] : -1;
        return check(bars, p, params, i, highOld, highNew, atrVal, 'SHORT');
      }

      return null;
    },
  };
}

/**
 * Tek yon icin uyumsuzluk kontrolu.
 *
 * Long ve short kurallari birebir simetrik oldugu icin ortak fonksiyon:
 * iki ayri kopya yazilirsa biri duzeltilip digeri unutulur ve backtest
 * yonlere gore farkli kural uygular.
 */
function check(
  bars: Bar[],
  p: { rsi: (number | null)[] },
  params: RsiDivergenceParams,
  i: number,
  oldIdx: number,
  newIdx: number,
  atrVal: number,
  side: 'LONG' | 'SHORT',
): Signal | null {
  if (oldIdx < 0) return null;

  const gap = newIdx - oldIdx;
  // Alt sinir 2*pivotBars: bundan yakin iki pivotun pencereleri ust uste
  // biner, yani ayni salinimi iki kez saymis oluruz.
  if (gap < params.pivotBars * 2 || gap > params.maxGap) return null;

  const rsiOld = p.rsi[oldIdx];
  const rsiNew = p.rsi[newIdx];
  if (rsiOld === null || rsiNew === null) return null;

  const long = side === 'LONG';
  const bar = bars[i];
  const pivotBar = bars[newIdx];
  const oldBar = bars[oldIdx];

  if (long) {
    if (!(pivotBar.low < oldBar.low)) return null; // 2: daha dusuk fiyat dibi
    if (!(rsiNew >= rsiOld + MIN_RSI_FARKI)) return null; // 2: daha yuksek RSI dibi
    if (!(rsiOld < RSI_ALT_UC)) return null; // 3: uyumsuzluk ucta
    if (!(bar.close > pivotBar.close)) return null; // 5: fiyat onayi
  } else {
    if (!(pivotBar.high > oldBar.high)) return null;
    if (!(rsiNew <= rsiOld - MIN_RSI_FARKI)) return null;
    if (!(rsiOld > RSI_UST_UC)) return null;
    if (!(bar.close < pivotBar.close)) return null;
  }

  const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak
  const atrStop = atrVal * params.stopAtr;
  // 6: dibin/tepenin hemen otesi tezin yanlislandigi yerdir. 0.25 ATR
  // tampon, tam seviyeye yigilan stop avini bir nebze asmak icin.
  const structStop = long
    ? entry - (pivotBar.low - atrVal * 0.25)
    : pivotBar.high + atrVal * 0.25 - entry;
  const stopDist = Math.max(atrStop, structStop);
  if (!Number.isFinite(stopDist) || stopDist <= 0) return null;

  return {
    side,
    stopLoss: long ? entry - stopDist : entry + stopDist,
    takeProfit: long
      ? entry + stopDist * params.rr
      : entry - stopDist * params.rr,
    reason:
      `${long ? 'Bogaci' : 'Ayici'} RSI uyumsuzlugu: fiyat ` +
      `${long ? 'daha dusuk dip' : 'daha yuksek tepe'}, RSI ` +
      `${rsiOld.toFixed(1)} -> ${rsiNew.toFixed(1)} (${gap} mum arayla)`,
  };
}
