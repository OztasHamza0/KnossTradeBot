import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { sma, atrSeries, rollingExtremes } from '../core/ma';

export interface VolSqueezeParams {
  /**
   * Bollinger orta bandinin, standart sapmanin, ATR'nin ve kirilim
   * kanalinin ortak penceresi. Tek pencere kullaniyoruz cunku sikismayi
   * bir uzunlukta olcup kirilimi baska bir uzunlukta aramak, "hangi
   * pencere kazandirdi" sorusunu cevaplanamaz hale getirir.
   */
  period: number;
  /**
   * Bant genisliginin kendi gecmisiyle karsilastirildigi pencere.
   * Sikisma MUTLAK bir sayi degildir: BTC'nin dar bandi ZRO'nun genis
   * bandidir. Bu yuzden esik hep serinin KENDI gecmisine gore.
   */
  squeezeLookback: number;
  /**
   * Bant genisligi son `squeezeLookback` mumun en dusuk yuzde kacinda
   * olmali. 20 = "son penceredeki en dar %20'lik dilim". 0'a cok yakin
   * bir deger (yalniz mutlak minimum) sinyal sayisini istatistik
   * kurulamayacak kadar azaltir; 50 ise artik sikisma degil "ortalamanin
   * altinda" demektir ve filtre olmaktan cikar.
   */
  squeezePct: number;
  /**
   * Kirilim mumu kendi araliginin ne kadarini yonunde kapatmali (0-1).
   * FAKEOUT SAVUNMASININ KALBI: yanlis kirilim tipik olarak uc noktayi
   * delip uzun bir fitille geri doner, yani araliginin ortasinda ya da
   * ters ucunda kapanir. Gercek kirilim ucta kapanir. 0.6 kasti olarak
   * ilimli; 0.8+ neredeyse fitilsiz mum ister ve sinyalleri kurutur.
   */
  minCloseStrength: number;
  /**
   * Stop kac ATR uzakta. Sabit yuzde stop olmaz: ayni %1 BTC'de genis,
   * oynak altcoinde gurultudur.
   */
  stopAtr: number;
  /** Hedef, riskin kac kati. */
  rr: number;
}

export const DEFAULT_VOL_SQUEEZE: VolSqueezeParams = {
  period: 20,
  // 100 mum ~ 4 gunluk 1h gecmisi: sikismanin "son donemin en dari" olmasi
  // icin yeterince uzun, rejim degisimini kacirmayacak kadar kisa.
  squeezeLookback: 100,
  squeezePct: 20,
  minCloseStrength: 0.6,
  stopAtr: 1.5,
  // Kirilim ailesinde isabet orani dusuktur (yanlis kirilimlar cok), ama
  // tutan islem uzun kosar. Beklentiyi isabetten degil kuyruktan almak
  // gerekir; bu yuzden geri cekilme stratejisinin 2'sinden yuksek.
  rr: 2.5,
};

/**
 * Oynaklik sikismasi kirilimi.
 *
 * Fikir: oynaklik ortalamaya doner. Uzun sure daralan bir piyasa enerji
 * biriktirir ve genisleme genelde tek yonlu, hizli bir hareketle gelir.
 * Kirilim stratejilerinin klasik derdi yatay piyasada surekli tetiklenip
 * komisyonla erimektir; buradaki fark, kirilimi HER ZAMAN degil yalnizca
 * olculmus bir sikismanin ardindan aramak.
 *
 *   1. SIKISMA: Bollinger bant genisligi (ust-alt)/orta, son
 *      `squeezeLookback` mumun en dar %`squeezePct` diliminde mi. Oran
 *      kullaniyoruz cunku mutlak bant genisligi fiyat seviyesiyle olceklenir
 *      ve semboller arasi karsilastirilamaz.
 *   2. SIKISMA BIR ONCEKI MUMDA OLCULUR: kirilim mumunun kendisi bandi
 *      zaten patlatir. Sikismayi i. mumda olcmek, kosuldan gecen hicbir
 *      kirilim birakmaz — filtre kendi tetigini yer.
 *   3. KIRILIM: kapanis, onceki `period` mumun en yuksegini asiyor (LONG)
 *      ya da en dusugunun altina iniyor (SHORT). Uc nokta i-1'e kadar
 *      olculur; bu mumun kendi yuksegini dahil etmek "kendi kendini kirmak"
 *      olur ve her mumda sinyal uretir.
 *   4. FAKEOUT ONAYI — IKI KATMAN:
 *      a) Mum kendi araliginin ucunda kapanmali (`minCloseStrength`).
 *         Fitille delip geri donen mum elenir.
 *      b) Mumun gercek araligi, bir onceki mumun ATR'sinden buyuk olmali.
 *         Sikisma kirilimi TANIMI GEREGI genislemedir; ortalama boyda bir
 *         mumla gelen "kirilim" genisleme degil sizintidir. Esik 1.0 —
 *         "son ortalamadan buyuk" demenin en dogal hali oldugu icin ayri
 *         bir parametreye gerek yok.
 *   5. STOP: ATR ile ve ATR'yi KIRILIM MUMU DAHIL okuyoruz. Sikisma
 *      sirasindaki minik ATR ile stop koymak, genislemenin ilk salinimina
 *      kurban gitmek demektir; dogru referans patlama sonrasi oynakliktir.
 *
 * Gelecege bakma yok: tum seriler yalniz gecmis mumlara dayaniyor, sinyal
 * i. mumun kapanisinda uretiliyor, motor girisi i+1'in acilisinda yapiyor.
 */
export function volSqueeze(
  params: VolSqueezeParams = DEFAULT_VOL_SQUEEZE,
): Strategy {
  let prepared: {
    ref: Bar[];
    /** Bant genisligi orani; sikismanin ham olcusu. */
    width: (number | null)[];
    /** width[i], son penceresinin en dar %X'inde mi. */
    squeezed: boolean[];
    highest: (number | null)[];
    lowest: (number | null)[];
    atr: (number | null)[];
  } | null = null;

  // Onbellek: seriler mum dizisi basina BIR KEZ hesaplanir. Her onBar
  // cagrisinda yeniden hesaplansaydi kosu O(n^2) olur, 8760 mumluk bir
  // backtest dakikalar surerdi.
  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;

    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);
    const n = bars.length;

    const middle = sma(closes, params.period);

    // Standart sapmayi pencere pencere, iki gecisde hesapliyoruz. Kayan
    // sum/sumSq numarasi daha hizli olurdu ama 100k'lik fiyatlarda karelerin
    // farki hassasiyet kaybettirir ve varyans negatife bile dusebilir;
    // O(n*period) burada zaten ihmal edilebilir bir maliyet.
    const width: (number | null)[] = new Array(n).fill(null);
    for (let i = params.period - 1; i < n; i++) {
      const mean = middle[i];
      if (mean === null || mean <= 0) continue;
      let acc = 0;
      for (let j = i - params.period + 1; j <= i; j++) {
        const d = closes[j] - mean;
        acc += d * d;
      }
      const sd = Math.sqrt(acc / params.period);
      // Bant carpani (2sd) oranin hem payinda hem paydasinda sabit oldugu
      // icin sadelesir; genisligi dogrudan sd/orta tutmak bizi gereksiz
      // bir parametreden kurtariyor.
      width[i] = sd / mean;
    }

    // Yuzdelik sira: width[i], kendi penceresindeki degerlerin en dusuk
    // yuzde kacinda. Mutlak esik yerine sira kullanmak stratejiyi sembolden
    // ve fiyat rejiminden bagimsiz kilar.
    const squeezed: boolean[] = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const w = width[i];
      if (w === null) continue;
      const start = i - params.squeezeLookback + 1;
      if (start < 0) continue;
      let total = 0;
      let below = 0;
      for (let j = start; j <= i; j++) {
        const v = width[j];
        if (v === null) continue;
        total++;
        if (v <= w) below++;
      }
      // Pencere tam dolmadiysa yuzdelik yaniltir (3 degerin en dari her
      // zaman "en dar %33"tur); eksik veriyle sinyal uretmektense hic
      // uretmemek dogru.
      if (total < params.squeezeLookback) continue;
      squeezed[i] = (below / total) * 100 <= params.squeezePct;
    }

    const ext = rollingExtremes(highs, lows, params.period);

    prepared = {
      ref: bars,
      width,
      squeezed,
      highest: ext.highest,
      lowest: ext.lowest,
      atr: atrSeries(highs, lows, closes, params.period),
    };
    return prepared;
  };

  return {
    name:
      `Oynaklik sikismasi kirilimi (BB${params.period}, ` +
      `en dar %${params.squeezePct}/${params.squeezeLookback}, ` +
      `stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    // Bant genisligi `period` mum sonra baslar, yuzdelik sirasi da onun
    // uzerine `squeezeLookback` mum ister; warmup toplamdan buyuk olmali.
    warmup: params.period + params.squeezeLookback + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      // Kural 2: sikisma ONCEKI mumda olculur.
      if (!p.squeezed[i - 1]) return null;

      const prevHigh = p.highest[i - 1];
      const prevLow = p.lowest[i - 1];
      const atrVal = p.atr[i];
      const prevAtr = p.atr[i - 1];

      if (
        prevHigh === null ||
        prevLow === null ||
        atrVal === null ||
        atrVal <= 0 ||
        prevAtr === null ||
        prevAtr <= 0
      ) {
        return null;
      }

      const bar = bars[i];
      const range = bar.high - bar.low;
      // Araligi sifir olan mumda kapanis gucu tanimsiz (0/0); boyle bir mum
      // zaten genisleme degil, veri boslugudur.
      if (range <= 0) return null;

      // Kural 4b: mum, sikisma donemindeki ortalama mumdan buyuk olmali.
      // Gercek araligi kullaniyoruz cunku bosluklu acilan mumun asil
      // hareketi kendi high-low'unda gorunmez.
      const trueRange = Math.max(
        range,
        Math.abs(bar.high - bars[i - 1].close),
        Math.abs(bar.low - bars[i - 1].close),
      );
      if (trueRange <= prevAtr) return null;

      // Kural 4a: kapanis kendi araliginin ucunda mi.
      const closeUpStrength = (bar.close - bar.low) / range;
      const closeDownStrength = (bar.high - bar.close) / range;

      const longSetup =
        bar.close > prevHigh && closeUpStrength >= params.minCloseStrength;
      const shortSetup =
        bar.close < prevLow && closeDownStrength >= params.minCloseStrength;

      if (!longSetup && !shortSetup) return null;

      const side = longSetup ? 'LONG' : 'SHORT';
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
          `Sikisma sonrasi ${side === 'LONG' ? 'yukari' : 'asagi'} kirilim ` +
          `(${params.period} mumluk ${side === 'LONG' ? 'tepe' : 'dip'}, guclu kapanis)`,
      };
    },
  };
}
