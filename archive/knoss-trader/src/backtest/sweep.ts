import { Bar } from '../data/types';
import { runBacktest } from './engine';
import { BacktestConfig, DEFAULT_CONFIG, Strategy, Trade } from './types';
import { atrSeries } from '../core/ma';

/**
 * Edge aramasinin en buyuk dusmani asiri uydurma (overfit) — ve bu dosya
 * tamamen ona karsi.
 *
 * Yeterince parametre denenirse, gecmis veride HER ZAMAN harika gorunen bir
 * kombinasyon bulunur. O kombinasyon bir yasa degil, o donemin gurultusunun
 * ezberlenmis halidir ve canlida hicbir sey ifade etmez. Bu yuzden burada
 * uc ayri filtre var:
 *
 *   1. GORULMEMIS VERI (out-of-sample). Strateji verinin ilk %70'inde
 *      ayarlanir, karar SON %30'a bakilarak verilir. Sadece gorulmemis
 *      kisimda pozitif olan bir sonuc anlamlidir.
 *   2. COKLU SEMBOL. Gercek bir edge birden fazla piyasada gorunur. Tek bir
 *      sembolde parlayip digerlerinde sonen sey, o sembolun gecmisine
 *      uydurulmustur.
 *   3. KONTROL GRUBU. Her hucre yazi-tura tabaniyla kiyaslanir. Mutlak kar
 *      degil, TABANDAN AYRISMA onemli.
 */

/** Gostergeler tum gecmisi gorur (canlida da oyle olur), ama islemler
 *  giris zamanina gore ikiye ayrilir. Boylece OOS olcumu, stratejinin
 *  hic gormedigi donemde ne yaptigini soyler. */
export const OOS_FRACTION = 0.3;

export interface Segment {
  trades: number;
  expectancyR: number;
  totalR: number;
  winRatePct: number;
  /** R'lerin bilesik getirisi — bakiye buyudukce pozisyon da buyur. */
  returnPct: number;
  maxDrawdownPct: number;
}

export interface SweepCell {
  strategy: string;
  symbol: string;
  interval: string;
  inSample: Segment;
  outOfSample: Segment;
  /** Ilk tohumun tabani — yalnizca gosterim icin. Karar buna DAYANMAZ. */
  baselineOos: Segment;
  /** OOS beklentisi eksi taban beklentisinin ORTALAMASI. Asil bakilacak sayi. */
  edge: number;
  /**
   * Tabanin standart HATASI (R).
   *
   * `edge` bir farktir ve farkin guvenilirligi, cikarilan seyin
   * gurultusune baglidir. Taban TEK cekilisken bu sayi hic bilinmiyordu ve
   * `edge` dogrudan sabit bir esikle (0.02 R) kiyaslaniyordu.
   *
   * Olculdu (`npm run baseline-noise`): yalnizca kontrol grubunun tohumunu
   * degistirmek, donchian-20'de avgEdge'i 0.126 R standart sapmayla
   * oynatiyor — karar esiginin 6.3 KATI. Ayni strateji, ayni veri, ayni
   * kod: 40 tohumun 33'unde "umutlu", 7'sinde "edge-yok".
   *
   * Yani judge() bir eleme mekanizmasi DEGILDI; yazi-turanin o gunku
   * sansini olcuyordu. Elenen adaylar kanitla degil sansla elenmis
   * olabilir — arama hic gorundugu kadar kapsamli degildi.
   */
  baselineStdErrR?: number;
  /** Kac tohumla olculdu — tek tohumsa karar guvenilir degildir. */
  baselineSeeds?: number;
  /** IS iyi ama OOS kotu ise asiri uydurma suphesi. */
  overfitGap: number;
}

function emptySegment(): Segment {
  return {
    trades: 0,
    expectancyR: 0,
    totalR: 0,
    winRatePct: 0,
    returnPct: 0,
    maxDrawdownPct: 0,
  };
}

/**
 * Islem listesinden segment metrikleri.
 *
 * Getiri R uzerinden BILESIK hesaplaniyor, motorun mutlak bakiyesinden
 * degil: IS islemleri bakiyeyi degistirdigi icin OOS'un mutlak getirisi
 * IS sonucuna bagimli olurdu ve iki donem karsilastirilamazdi. R
 * bakiyeden bagimsizdir.
 */
export function segmentOf(trades: Trade[], riskPct: number): Segment {
  if (trades.length === 0) return emptySegment();

  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const wins = trades.filter((t) => t.r > 0).length;

  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const t of trades) {
    equity *= 1 + (t.r * riskPct) / 100;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, ((peak - equity) / peak) * 100);
  }

  return {
    trades: trades.length,
    expectancyR: totalR / trades.length,
    totalR,
    winRatePct: (wins / trades.length) * 100,
    returnPct: (equity - 1) * 100,
    maxDrawdownPct: maxDd,
  };
}

/** Islemleri giris zamanina gore boler. */
function splitByTime(trades: Trade[], cutoff: number) {
  return {
    is: trades.filter((t) => t.entryTime < cutoff),
    oos: trades.filter((t) => t.entryTime >= cutoff),
  };
}

/** Kontrol grubunun taklit etmesi gereken islem yapisi. */
export interface BaselineShape {
  /** Stop mesafesi, ATR kati olarak. */
  stopAtr: number;
  /** Hedef mesafesi / stop mesafesi. */
  rr: number;
  /** Kac mumda bir islem acilsin — islem sayisini denklestirmek icin. */
  tradeEveryN: number;
}

/** Varsayilan yapi: strateji hic islem uretmediyse kullanilir. */
export const DEFAULT_SHAPE: BaselineShape = { stopAtr: 1.5, rr: 2, tradeEveryN: 20 };

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Stratejinin KENDI islemlerinden stop/hedef yapisini olcer.
 *
 * NEDEN GEREKLI — bu, taramanin en pahali hatasiydi. Onceki halinde her
 * strateji SABIT 1.5 ATR / R:R 2 yapisindaki bir yazi-turayla kiyaslaniyordu,
 * oysa stratejilerin kendi stop yapilari farkli (1.0'dan 3.0'a). "Taban
 * farki" sutunu boylece beceriyi degil STOP GEOMETRISINI olcuyordu.
 *
 * Olculdu: sifir-beceri bir yazi-tura, 3 ATR / R:R 3 yapisinda kosturulup
 * sabit 1.5/2 tabaniyla kiyaslandiginda +0.164 R "edge" gosteriyor ve
 * judge() 20 tohumun 5'inde ona "umutlu" diyor. Ayni yazi-tura KENDI
 * yapisindaki tabana karsi 20/20 eleniyor.
 *
 * Sebep basit: genis stop islem sayisini dusurur, islem sayisi dusunce
 * komisyon yuku duser, yani yazi-tura bile "iyilesir". Gercek soru
 * "strateji, AYNI yapidaki yazi-turadan daha iyi mi" olmali.
 *
 * Islem SIKLIGI da eslestiriliyor: farkli islem sayisi farkli komisyon
 * yuku demek, ve o fark yine beceri gibi gorunur.
 */
export function measureShape(trades: Trade[], bars: Bar[]): BaselineShape {
  if (!trades.length || bars.length < 30) return DEFAULT_SHAPE;

  const stopPct: number[] = [];
  const rrs: number[] = [];
  for (const t of trades) {
    const stopDist = Math.abs(t.entryPrice - t.stopLoss);
    if (!(stopDist > 0) || !(t.entryPrice > 0)) continue;
    stopPct.push(stopDist / t.entryPrice);
    const rewardDist = Math.abs(t.takeProfit - t.entryPrice);
    if (rewardDist > 0) rrs.push(rewardDist / stopDist);
  }
  if (!stopPct.length) return DEFAULT_SHAPE;

  const a = atrSeries(
    bars.map((b) => b.high),
    bars.map((b) => b.low),
    bars.map((b) => b.close),
    14,
  );
  const atrPct: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const v = a[i];
    if (v === null || !Number.isFinite(v) || !(bars[i].close > 0)) continue;
    atrPct.push(v / bars[i].close);
  }

  const medStopPct = median(stopPct);
  const medAtrPct = median(atrPct);
  const stopAtr =
    Number.isFinite(medStopPct) && Number.isFinite(medAtrPct) && medAtrPct > 0
      ? medStopPct / medAtrPct
      : DEFAULT_SHAPE.stopAtr;

  const medRr = median(rrs);

  // Yazi-tura da islem tutar, yani bars/islem oraninin tamamini
  // kullanamaz; yine de sabit 20'den cok daha yakin bir eslesme.
  const everyN = Math.round(bars.length / trades.length);

  return {
    stopAtr: Math.min(10, Math.max(0.2, stopAtr)),
    rr: Number.isFinite(medRr) && medRr > 0 ? Math.min(10, Math.max(0.2, medRr)) : DEFAULT_SHAPE.rr,
    tradeEveryN: Math.min(500, Math.max(2, Number.isFinite(everyN) ? everyN : 20)),
  };
}

/**
 * Tabanin kac farkli tohumla kosulacagi.
 *
 * TEK TOHUM YETMEZ ve bu olculdu. `edge` bir FARKTIR; cikarilan sey tek bir
 * yazi-tura cekilisiyse, o cekilisin ornekleme gurultusu farkin icine
 * dogrudan gecer. `npm run baseline-noise` ile olculdu: yalnizca tohumu
 * degistirmek avgEdge'i donchian-20'de 0.126 R, ts-momentum'da 0.065 R
 * standart sapmayla oynatiyor — judge()'un karar esigi ise 0.02 R.
 * Yani esik, gurultunun ucte biriydi ve karar sansla veriliyordu.
 *
 * Tohum ve islem SIKLIGI birlikte degisiyor: yalnizca tohumu degistirmek
 * ayni mumlarda islem acan cok benzer kosular uretir ve dagilimi YAPAY
 * OLARAK DARALTIR — luck-test.ts'te ogrenilen ders.
 *
 * 12 tohum: standart hatayi ~3.5 kat kuculturur (sqrt(12)), maliyeti hucre
 * basina 12 backtest. Olculdu, saniyeler mertebesinde.
 */
export const BASELINE_SEED_COUNT = 12;

export function baselineSeeds(n = BASELINE_SEED_COUNT): number[] {
  return Array.from({ length: n }, (_, i) => 1000 + i * 37);
}

export function evaluate(
  strategy: Strategy,
  /**
   * Kontrol grubunu URETEN fabrika — hazir bir Strategy DEGIL.
   * Stratejinin olculen stop/hedef yapisi verilerek cagrilir, boylece
   * yazi-tura AYNI geometride kosar. Bkz. measureShape().
   *
   * TOHUM DA PARAMETRE: taban tek cekilis degil, COK cekilisin ortalamasi.
   * Fabrikanin tohumu KULLANMASI sart; kullanmazsa 12 kosu ayni sonucu
   * verir, standart hata 0 cikar ve asagidaki guard uyarir.
   */
  makeBaseline: (shape: BaselineShape, seed: number) => Strategy,
  bars: Bar[],
  symbol: string,
  interval: string,
  cfg: BacktestConfig = DEFAULT_CONFIG,
  seeds: number[] = baselineSeeds(),
): SweepCell {
  const cutoffIndex = Math.floor(bars.length * (1 - OOS_FRACTION));
  const cutoff = bars[cutoffIndex]?.openTime ?? 0;

  const full = runBacktest(strategy, bars, symbol, interval, cfg);
  const shape = measureShape(full.trades, bars);

  const split = splitByTime(full.trades, cutoff);
  const inSample = segmentOf(split.is, cfg.riskPct);
  const outOfSample = segmentOf(split.oos, cfg.riskPct);

  // --- Taban: her tohum icin ayri kosu ---
  const kullanilan = seeds.length ? seeds : [42];
  const tabanBeklentileri: number[] = [];
  let ilkTaban: Segment | null = null;

  for (const seed of kullanilan) {
    const base = runBacktest(makeBaseline(shape, seed), bars, symbol, interval, cfg);
    const seg = segmentOf(splitByTime(base.trades, cutoff).oos, cfg.riskPct);
    if (ilkTaban === null) ilkTaban = seg;
    // Islem uretmemis bir taban kosusu beklenti tasimaz; ortalamayi
    // sifira dogru cekmesi olcumu bozar.
    if (seg.trades > 0) tabanBeklentileri.push(seg.expectancyR);
  }

  const n = tabanBeklentileri.length;
  const ortTaban = n ? tabanBeklentileri.reduce((a, b) => a + b, 0) / n : 0;
  // Iki gecisli varyans; tek gecisli (sum, sumSq) formulu birbirine cok
  // yakin iki buyuk sayinin farki olur ve hata birikir.
  const varyans =
    n > 1
      ? tabanBeklentileri.reduce((s, x) => s + (x - ortTaban) * (x - ortTaban), 0) / (n - 1)
      : 0;
  const stdErr = n > 1 ? Math.sqrt(varyans / n) : NaN;

  return {
    strategy: strategy.name,
    symbol,
    interval,
    inSample,
    outOfSample,
    baselineOos: ilkTaban ?? emptySegment(),
    edge: outOfSample.expectancyR - ortTaban,
    baselineStdErrR: stdErr,
    baselineSeeds: n,
    overfitGap: inSample.expectancyR - outOfSample.expectancyR,
  };
}

export interface StrategyVerdict {
  strategy: string;
  cells: SweepCell[];
  /**
   * Kac sembolde OOS beklentisi pozitif — OY KULLANAN hucreler icinde.
   *
   * votingSymbols ile birlikte okunmali. Onceki halinde bu sayi oy
   * kullanan hucrelerden hesaplanip TUM sembol sayisina bolunerek
   * yaziliyordu: 6 oy kullanan hucrenin 3'u pozitifken rapor "3/8
   * sembolde pozitif" diyordu. Ayni tabloda listelenen sembollerin
   * 5'i pozitif gorunuyordu — okuyani sayilarin hangisine guvenecegi
   * konusunda tereddutte birakan bir tutarsizlik.
   */
  positiveSymbols: number;
  /** Yeterli islem sayisina sahip, yani oy kullanan hucre sayisi. */
  votingSymbols: number;
  /** Taranan toplam sembol sayisi (oy kullanmayanlar dahil). */
  totalSymbols: number;
  /** Sembol ortalamasi OOS beklentisi. */
  avgOosExpectancy: number;
  avgEdge: number;
  totalOosTrades: number;
  verdict: 'umutlu' | 'yetersiz-veri' | 'asiri-uydurma' | 'edge-yok';
  note: string;
}

/**
 * Bir stratejinin tum sembollerdeki sonucundan tek bir karar.
 *
 * Esikler bilerek sert: bu asamada yanlis pozitif, yanlis negatiften cok
 * daha pahali. Elenen bir strateji sadece zaman kaybettirir; elenmeyen
 * kotu bir strateji para kaybettirir.
 */
/**
 * Bir hucrenin "pozitif sembol" sayilabilmesi icin gereken en az islem.
 *
 * Bu esik sonradan eklendi ve ilk taramanin yanlisini duzeltti: eski surumde
 * 30 islem alt siniri SEKIZ SEMBOLUN TOPLAMI icin bakiliyordu. RSI
 * uyumsuzlugu 69 toplam islemle "umutlu" cikti — sembol basina ~9 islem.
 * Dokuz islemden hesaplanan bir beklenti hicbir sey olcmez; "4/8 sembolde
 * pozitif" ifadesi de o durumda dort tane yazi-turadan ibaret olur.
 */
/**
 * judge()'un TABAN esigi (R) — tek basina karar esigi DEGIL.
 *
 * Gercek esik bundan buyuk olabilir: taban gurultusu olculup 2 standart
 * hataya bakiliyor ve IKISININ BUYUGU aliniyor. Bu sabit yalnizca bir ALT
 * SINIR: "olculebilir ama ekonomik olarak sifir" bir farki gecirmemek icin.
 *
 * Eskiden karar esiginin KENDISIYDI ve olculdu ki tabanin gurultusu bu
 * sayinin 3-6 katiydi (bkz. npm run baseline-noise).
 */
export const MIN_EDGE_R = 0.02;

export const MIN_TRADES_PER_CELL = 25;
/** Tum semboller toplaminda gereken en az gorulmemis islem. */
export const MIN_TOTAL_OOS_TRADES = 100;

export function judge(strategy: string, cells: SweepCell[]): StrategyVerdict {
  const totalOosTrades = cells.reduce((s, c) => s + c.outOfSample.trades, 0);
  // Yalnizca yeterli islem sayisina sahip hucreler oy kullanir.
  const votingCells = cells.filter(
    (c) => c.outOfSample.trades >= MIN_TRADES_PER_CELL,
  );
  const positiveSymbols = votingCells.filter(
    (c) => c.outOfSample.expectancyR > 0,
  ).length;
  /**
   * ORTALAMALAR YALNIZCA OY KULLANAN HUCRELERDEN.
   *
   * votingCells filtresi kurulmustu ama SADECE positiveSymbols sayiminda
   * kullaniliyordu; kararin asil iki kapisi (avgOosExpectancy, avgEdge)
   * hala TUM hucreler uzerinden ortalaniyordu — yani "dokuz islemden
   * hesaplanan bir beklenti hicbir sey olcmez" diyen kurali koyup, tam o
   * dokuz islemi karara sokuyorduk.
   *
   * Yeniden uretildi: 5 hucre x 40 islem (edge -0.014 R, esigin ALTINDA)
   * + 3 hucre x 3 islem (sansli +0.8 R) -> judge() "umutlu", avgEdge
   * +0.291 R. Oy kullanan bes hucrenin gercek avgEdge'i -0.014 R idi.
   * Dokuz islemlik sans, iki yuz islemlik olcumu bastiriyordu.
   *
   * votingCells bos olamaz: yukaridaki ikinci kapi (votingCells.length <
   * ceil(cells.length/2)) bos durumu zaten eliyor.
   */
  const oy = votingCells.length ? votingCells : cells;
  const avgOosExpectancy =
    oy.reduce((s, c) => s + c.outOfSample.expectancyR, 0) / (oy.length || 1);
  const avgEdge = oy.reduce((s, c) => s + c.edge, 0) / (oy.length || 1);
  const avgOverfitGap =
    oy.reduce((s, c) => s + c.overfitGap, 0) / (oy.length || 1);

  /**
   * KARAR ESIGI ARTIK SABIT DEGIL — OLCULEN GURULTUYE BAGLI.
   *
   * Eski hali `avgEdge <= 0.02` idi. 0.02 R sezgiyle konmus bir sayiydi ve
   * olculdu ki tabanin kendi gurultusu ondan 3-6 kat BUYUK: yalnizca
   * kontrol grubunun tohumunu degistirmek avgEdge'i donchian-20'de
   * 0.126 R, ts-momentum'da 0.065 R standart sapmayla oynatiyordu.
   * Ayni strateji, ayni veri, ayni kod — 40 tohumun 33'unde "umutlu",
   * 7'sinde "edge-yok". Karar beceriyi degil, 42 numarali cekilisin
   * sansini olcuyordu.
   *
   * Dogru esik, cikarilan seyin standart HATASINA gore konur. Hucrelerin
   * standart hatalari bagimsiz oldugundan ortalamanin hatasi
   * sqrt(sum(se^2))/k; 2 katini aliyoruz (~%95 tek yonlu).
   *
   * Taban artik cok tohumlu oldugu icin bu esik, eski sabit esikten
   * genellikle DAHA KUCUK cikar: gurultuyu olcmek onu ortadan kaldirmaz
   * ama ORTALAMAYLA kucultur (12 tohum -> ~3.5 kat). Yani duzeltme
   * elemeyi sertlestirmiyor, DOGRU yere koyuyor.
   */
  const seList: number[] = oy
    .map((c) => c.baselineStdErrR)
    .filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0);
  const gurultuEsigi = seList.length
    ? (2 * Math.sqrt(seList.reduce((s, x) => s + x * x, 0))) / oy.length
    : NaN;
  const edgeEsigi = Number.isFinite(gurultuEsigi)
    ? Math.max(MIN_EDGE_R, gurultuEsigi)
    : MIN_EDGE_R;

  // Tek tohumla olculmus hucre varsa karar guvenilir degildir; sessiz
  // kalmak, tam da duzeltilen hatayi geri getirmek olur.
  const tekTohumlu = oy.filter((c) => (c.baselineSeeds ?? 0) < 2).length;

  let verdict: StrategyVerdict['verdict'];
  let note: string;

  if (totalOosTrades < MIN_TOTAL_OOS_TRADES) {
    verdict = 'yetersiz-veri';
    note = `Yalnizca ${totalOosTrades} gorulmemis islem — istatistiksel olarak anlamsiz.`;
  } else if (votingCells.length < Math.ceil(cells.length / 2)) {
    verdict = 'yetersiz-veri';
    note =
      `${cells.length} sembolden yalnizca ${votingCells.length}'inde ` +
      `${MIN_TRADES_PER_CELL}+ islem var — sembol bazinda olcum guvenilir degil.`;
  } else if (avgOosExpectancy <= 0) {
    verdict = 'edge-yok';
    note = `Gorulmemis veride ortalama beklenti ${avgOosExpectancy.toFixed(3)} R — kaybettiriyor.`;
  } else if (avgEdge <= edgeEsigi) {
    verdict = 'edge-yok';
    note =
      `Pozitif ama yazi-turadan ayrismiyor (fark ${avgEdge.toFixed(3)} R, ` +
      `esik ${edgeEsigi.toFixed(3)} R${
        Number.isFinite(gurultuEsigi) && gurultuEsigi > MIN_EDGE_R
          ? ` — esigi TABAN GURULTUSU belirledi, sabit ${MIN_EDGE_R} degil`
          : ''
      }).`;
  } else if (positiveSymbols < Math.ceil(votingCells.length / 2)) {
    verdict = 'asiri-uydurma';
    note =
      `Oy kullanan ${votingCells.length} sembolden yalnizca ${positiveSymbols}'inde ` +
      `pozitif — tek piyasaya uydurulmus olabilir.`;
  } else if (avgOverfitGap > 0.15) {
    verdict = 'asiri-uydurma';
    note = `Bilinen donemde ${avgOverfitGap.toFixed(3)} R daha iyi — gorulmemis veriye tasinmiyor.`;
  } else {
    verdict = 'umutlu';
    note =
      `Oy kullanan ${votingCells.length} sembolun ${positiveSymbols}'inde pozitif ` +
      `(taranan toplam ${cells.length}), taban farki ${avgEdge.toFixed(3)} R.`;
  }

  // Tek tohumla olculmus hucre varsa SESSIZ KALINMAZ: o hucrelerin edge'i
  // gurultuden ayirt edilemez ve sessizlik, duzeltilen hatayi geri getirir.
  if (tekTohumlu > 0) {
    note +=
      ` !! ${tekTohumlu} hucrede taban TEK tohumla olculdu — ` +
      `o hucrelerin farki gurultuden ayirt edilemez.`;
  }

  return {
    strategy,
    cells,
    positiveSymbols,
    votingSymbols: votingCells.length,
    totalSymbols: cells.length,
    avgOosExpectancy,
    avgEdge,
    totalOosTrades,
    verdict,
    note,
  };
}
