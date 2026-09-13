import {
  evaluate,
  judge,
  baselineSeeds,
  BASELINE_SEED_COUNT,
  MIN_EDGE_R,
  SweepCell,
  Segment,
} from './sweep';
import { randomBaseline } from '../strategies/random-baseline';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { Bar } from '../data/types';

/**
 * OLCUM ALETININ KALIBRASYONU.
 *
 * HATA: `edge` = strateji OOS beklentisi - taban OOS beklentisi, ve taban
 * TEK SABIT TOHUMLA kosuyordu (`randomBaseline(42, ...)`). Tek cekilisin
 * ornekleme gurultusu dogrudan `edge`in icine geciyordu; judge() ise karari
 * sabit 0.02 R esigiyle veriyordu.
 *
 * OLCULDU (`npm run baseline-noise`): yalnizca kontrol grubunun tohumunu
 * degistirmek avgEdge'i donchian-20'de 0.126 R, ts-momentum'da 0.065 R
 * standart sapmayla oynatiyor — esigin 6.3 ve 3.3 KATI. Ayni strateji,
 * ayni veri, ayni kod: 40 tohumun 33'unde "umutlu", 7'sinde "edge-yok".
 *
 * Yani judge() bir eleme mekanizmasi degildi; yazi-turanin o gunku sansini
 * olcuyordu. Elenen adaylar kanitla degil SANSLA elenmis olabilir.
 *
 * NOT — bu, "edge bulundu" demek DEGIL: sans testi (luck-test.ts)
 * `outOfSample.expectancyR` kullaniyor, `edge` degil, yani tabanin tohumu
 * o sonuca hic girmiyor. Projenin "edge yok" hukmu ayakta. Bozuk olan
 * ELEME asamasiydi.
 */

/** Yapay ama gercekci mum serisi — tohumlu, deterministik. */
function bars(n: number, seed = 7): Bar[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 2;
    const open = price;
    const close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rnd();
    const low = Math.min(open, close) - rnd();
    out.push({
      openTime: i * 3600_000,
      open,
      high,
      low,
      close,
      volume: 1000 + rnd() * 100,
      closeTime: i * 3600_000 + 3599_999,
    });
    price = close;
  }
  return out;
}

const strat = () =>
  donchianBreakout({ lookback: 20, atrPeriod: 14, stopAtr: 3, rr: 3, trendEma: 200 });

const fabrika = (sh: any, seed: number) =>
  randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr);

describe('evaluate — taban COK tohumlu olcuyor', () => {
  const B = bars(3000);

  it('varsayilan olarak birden fazla tohum kullanir', () => {
    const c = evaluate(strat(), fabrika, B, 'TESTUSDT', '1h');
    expect(c.baselineSeeds).toBeGreaterThan(1);
    expect(c.baselineSeeds).toBeLessThanOrEqual(BASELINE_SEED_COUNT);
  });

  it('tabanin standart HATASINI bildirir', () => {
    const c = evaluate(strat(), fabrika, B, 'TESTUSDT', '1h');
    expect(Number.isFinite(c.baselineStdErrR as number)).toBe(true);
    expect(c.baselineStdErrR as number).toBeGreaterThan(0);
  });

  it('TEK tohumla cagrilirsa standart hata bilinemez (NaN) ve bu gizlenmez', () => {
    const c = evaluate(strat(), fabrika, B, 'TESTUSDT', '1h', undefined, [42]);
    expect(c.baselineSeeds).toBe(1);
    expect(Number.isFinite(c.baselineStdErrR as number)).toBe(false);
  });

  it('tohum GERCEKTEN kullanilir: farkli tohum farkli taban uretir', () => {
    const a = evaluate(strat(), fabrika, B, 'TESTUSDT', '1h', undefined, [42]);
    const b = evaluate(strat(), fabrika, B, 'TESTUSDT', '1h', undefined, [9999]);
    // Strateji ayni oldugu icin OOS beklentisi ayni; farki YALNIZCA taban
    // uretir. Esitse fabrika tohumu yok sayiyordur ve duzeltme olu koddur.
    expect(a.outOfSample.expectancyR).toBeCloseTo(b.outOfSample.expectancyR, 10);
    expect(a.edge).not.toBeCloseTo(b.edge, 6);
  });

  it('cok tohumlu edge, tek tohumlu edge kadar oynak DEGILDIR', () => {
    const tekler = [42, 1000, 1037, 1074, 1111, 1148].map(
      (s) => evaluate(strat(), fabrika, B, 'TESTUSDT', '1h', undefined, [s]).edge,
    );
    const coklu = [
      baselineSeeds(12),
      baselineSeeds(12).map((s) => s + 1),
      baselineSeeds(12).map((s) => s + 2),
    ].map((ss) => evaluate(strat(), fabrika, B, 'TESTUSDT', '1h', undefined, ss).edge);

    const yayilim = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    // Ortalama almak gurultuyu YOK ETMEZ ama KUCULTUR. Bu testin dustugu
    // gun, evaluate tohumlari gercekten ortalamiyor demektir.
    expect(yayilim(coklu)).toBeLessThan(yayilim(tekler));
  });
});

describe('judge — karar esigi olculen gurultuye bagli', () => {
  const seg = (over: Partial<Segment> = {}): Segment => ({
    trades: 60,
    expectancyR: 0,
    totalR: 0,
    winRatePct: 40,
    returnPct: 0,
    maxDrawdownPct: 5,
    ...over,
  });

  const hucre = (edge: number, se: number | undefined, seeds: number): SweepCell => ({
    strategy: 's',
    symbol: 'X',
    interval: '1h',
    inSample: seg({ expectancyR: 0.05 }),
    outOfSample: seg({ expectancyR: 0.05 }),
    baselineOos: seg(),
    edge,
    baselineStdErrR: se,
    baselineSeeds: seeds,
    overfitGap: 0,
  });

  it('gurultu buyukse esik YUKSELIR ve kucuk bir fark elenir', () => {
    // edge 0.05 R — eski sabit esigi (0.02) rahatca gecerdi.
    // Ama taban gurultusu buyuk: hucre basina 0.10 R standart hata.
    const cells = Array.from({ length: 8 }, () => hucre(0.05, 0.1, 12));
    const v = judge('s', cells);
    expect(v.verdict).toBe('edge-yok');
    expect(v.note).toContain('TABAN GURULTUSU');
  });

  it('gurultu kucukse ayni fark GECER — esik sertlesmiyor, dogru yere konuyor', () => {
    const cells = Array.from({ length: 8 }, () => hucre(0.05, 0.002, 12));
    const v = judge('s', cells);
    expect(v.verdict).toBe('umutlu');
  });

  it('gurultu esigi MIN_EDGE_R altina DUSEMEZ', () => {
    // Gurultu neredeyse sifir olsa bile ekonomik olarak sifir bir fark
    // gecmemeli; MIN_EDGE_R alt sinir olarak duruyor.
    const cells = Array.from({ length: 8 }, () => hucre(MIN_EDGE_R / 2, 1e-9, 12));
    const v = judge('s', cells);
    expect(v.verdict).toBe('edge-yok');
  });

  it('tek tohumla olculmus hucreler NOTTA uyarilir — sessiz kalmak hatayi geri getirir', () => {
    const cells = Array.from({ length: 8 }, () => hucre(0.5, undefined, 1));
    const v = judge('s', cells);
    expect(v.note).toContain('TEK tohumla');
  });
});
