import { Bar } from '../data/types';
import { runBacktest } from './engine';
import { BacktestConfig, DEFAULT_CONFIG, Strategy, Trade } from './types';

/**
 * ILERI-YURUYEN (WALK-FORWARD) DOGRULAMA.
 *
 * Projenin hafizasinda "hic yapilmadi, bir sonraki adim" diye duruyordu.
 * Sabit %70/%30 ayrimindan daha dogru bir soru soruyor.
 *
 * SABIT AYRIM NEYI OLCEMEZ:
 *   Tek bir kesme noktasi secip "son %30'da iyi mi" diye sormak, o TEK
 *   donemin hakkinda bir sey soyler. Eger o donem tesadufen stratejiye
 *   uygunsa sonuc parlar. Ustelik kesme noktasi da bir parametredir ve
 *   sen onu secersin — yani secim yanliligi oraya da sizar.
 *
 *   Daha onemlisi: gercek hayatta strateji BIR KEZ secilip sonsuza kadar
 *   kosulmaz. Periyodik olarak "hangisi iyi calisiyor" diye bakip yeniden
 *   secersin. Sabit ayrim bu SURECI hic olcmez.
 *
 * ILERI-YURUYEN NE OLCER:
 *   Zamani dilimlere boler. Her dilimde:
 *     1. YALNIZCA o ana kadarki veriye bakarak adaylardan birini SECER,
 *     2. secilen adayi BIR SONRAKI dilimde kosar ve sonucu kaydeder,
 *     3. dilim ilerler, secim yeniden yapilir.
 *   Sonunda elde kalan, hicbiri secim aninda gorulmemis islemlerin
 *   birlesik dokumudur. Bu, "bu stratejiyi kullansaydim ne olurdu"
 *   sorusunun degil, **"bu YONTEMI kullansaydim ne olurdu"** sorusunun
 *   cevabidir. Ve gercekte yapilan sey yontemdir.
 *
 * NEDEN KONTROL GRUBU SART — ve neden AYNI SEKILDE secilmeli:
 *   N aday arasindan "en iyi"yi secmek, hicbirinde edge olmasa bile
 *   pozitif bir egilim uretir: egitim doneminde sansi yaver giden aday
 *   secilir. Bu yanlilik yontemin KENDISINDE vardir.
 *   Bu yuzden taban da AYNI SAYIDA yazi-tura arasindan AYNI kuralla
 *   secilir. Karsilastirma "strateji vs yazi-tura" degil,
 *   **"N strateji arasindan secmek vs N yazi-tura arasindan secmek"**
 *   olmali. Aksi halde olculen sey beceri degil secim yanliligidir.
 */

export interface WalkForwardFold {
  index: number;
  /** Egitim penceresinin bittigi (= test penceresinin basladigi) zaman. */
  trainEnd: number;
  testEnd: number;
  /** Bu dilimde egitim verisine bakarak secilen aday. */
  secilen: string;
  /** Secilenin EGITIM donemindeki beklentisi — secim kriteri. */
  egitimBeklentisi: number;
  /** Secilenin TEST donemindeki beklentisi — asil sonuc. */
  testBeklentisi: number;
  testIslem: number;
  /** Secim yapilabildi mi (yeterli egitim islemi var miydi). */
  secimYapildi: boolean;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  /** Tum test dilimlerinin BIRLESIK islemleri. */
  tumTestIslemleri: Trade[];
  toplamTestIslem: number;
  /** Birlesik beklenti — yontemin gercek ciktisi. */
  beklentiR: number;
  /** Kac dilimde secim yapilabildi. */
  gecerliDilim: number;
  /** Secilen adaylarin dagilimi — hep ayni mi seciliyor, savruluyor mu? */
  secimDagilimi: Record<string, number>;
}

export interface WalkForwardOptions {
  /** Kac test dilimi. */
  folds?: number;
  /** Ilk egitim penceresi, serinin orani olarak. */
  ilkEgitimOrani?: number;
  /** Bir adayin secilebilmesi icin egitim doneminde gereken asgari islem. */
  minEgitimIslem?: number;
  cfg?: BacktestConfig;
}

export const WF_DEFAULTS = {
  folds: 6,
  ilkEgitimOrani: 0.4,
  minEgitimIslem: 20,
};

/** Islemleri [bas, son) zaman araligina gore suzer. */
function araliktakiler(trades: Trade[], bas: number, son: number): Trade[] {
  return trades.filter((t) => t.entryTime >= bas && t.entryTime < son);
}

function beklenti(trades: Trade[]): number {
  if (!trades.length) return 0;
  return trades.reduce((s, t) => s + t.r, 0) / trades.length;
}

/**
 * @param adaylar Secim havuzu. Her dilimde bunlardan BIRI secilir.
 *   Kontrol grubu icin ayni sayida yazi-tura verilmeli.
 */
export function walkForward(
  adaylar: { key: string; strat: Strategy }[],
  bars: Bar[],
  symbol: string,
  interval: string,
  opts: WalkForwardOptions = {},
): WalkForwardResult {
  const folds = opts.folds ?? WF_DEFAULTS.folds;
  const ilkEgitimOrani = opts.ilkEgitimOrani ?? WF_DEFAULTS.ilkEgitimOrani;
  const minEgitimIslem = opts.minEgitimIslem ?? WF_DEFAULTS.minEgitimIslem;
  const cfg = opts.cfg ?? DEFAULT_CONFIG;

  const bos: WalkForwardResult = {
    folds: [],
    tumTestIslemleri: [],
    toplamTestIslem: 0,
    beklentiR: 0,
    gecerliDilim: 0,
    secimDagilimi: {},
  };
  if (bars.length < 100 || !adaylar.length) return bos;

  /**
   * HER ADAY BIR KEZ kosulur, sonra islemleri zamana gore dilimlenir.
   *
   * Alternatif — her dilim icin backtest'i yeniden kosmak — ayni sonucu
   * verir ama dilim x aday kadar kosu demektir. Motor zaten islemlerin
   * GIRIS ZAMANINI kaydettigi icin tek kosu yeterli.
   *
   * Gostergeler tum gecmisi gorur; canlida da oyle olur (bot her tikte
   * 1200 mumluk pencere cekiyor). Ayrim islemin GIRIS ZAMANINA gore.
   */
  const tumIslemler = new Map<string, Trade[]>();
  for (const a of adaylar) {
    tumIslemler.set(a.key, runBacktest(a.strat, bars, symbol, interval, cfg).trades);
  }

  const ilkIndeks = Math.floor(bars.length * ilkEgitimOrani);
  const kalan = bars.length - ilkIndeks;
  const adim = Math.floor(kalan / folds);
  if (adim < 10) return bos;

  const sonuc: WalkForwardFold[] = [];
  const testIslemleri: Trade[] = [];
  const dagilim: Record<string, number> = {};

  for (let k = 0; k < folds; k++) {
    const trainEndIdx = ilkIndeks + k * adim;
    const testEndIdx = k === folds - 1 ? bars.length - 1 : trainEndIdx + adim;
    const trainEnd = bars[trainEndIdx]?.openTime ?? 0;
    const testEnd = bars[testEndIdx]?.openTime ?? Number.MAX_SAFE_INTEGER;

    // --- SECIM: yalnizca trainEnd'den ONCEKI islemlere bakarak ---
    let enIyi: { key: string; exp: number } | null = null;
    for (const a of adaylar) {
      const hepsi = tumIslemler.get(a.key) ?? [];
      const egitim = hepsi.filter((t) => t.entryTime < trainEnd);
      // Az islemden hesaplanan beklenti hicbir sey olcmez; o adayi
      // secime SOKMUYORUZ. (sweep'te ogrenilen ders: dokuz islemlik
      // bir hucre, iki yuz islemlik olcumu bastirabiliyordu.)
      if (egitim.length < minEgitimIslem) continue;
      const exp = beklenti(egitim);
      if (!enIyi || exp > enIyi.exp) enIyi = { key: a.key, exp };
    }

    if (!enIyi) {
      sonuc.push({
        index: k,
        trainEnd,
        testEnd,
        secilen: '(secim yok)',
        egitimBeklentisi: NaN,
        testBeklentisi: NaN,
        testIslem: 0,
        secimYapildi: false,
      });
      continue;
    }

    // --- TEST: secilen adayin BIR SONRAKI dilimdeki islemleri ---
    const test = araliktakiler(tumIslemler.get(enIyi.key) ?? [], trainEnd, testEnd);
    testIslemleri.push(...test);
    dagilim[enIyi.key] = (dagilim[enIyi.key] ?? 0) + 1;

    sonuc.push({
      index: k,
      trainEnd,
      testEnd,
      secilen: enIyi.key,
      egitimBeklentisi: enIyi.exp,
      testBeklentisi: beklenti(test),
      testIslem: test.length,
      secimYapildi: true,
    });
  }

  return {
    folds: sonuc,
    tumTestIslemleri: testIslemleri,
    toplamTestIslem: testIslemleri.length,
    beklentiR: beklenti(testIslemleri),
    gecerliDilim: sonuc.filter((f) => f.secimYapildi).length,
    secimDagilimi: dagilim,
  };
}
