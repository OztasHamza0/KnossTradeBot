import { segmentOf, judge, SweepCell, measureShape, DEFAULT_SHAPE } from './sweep';
import { Bar } from '../data/types';
import { Trade } from './types';

/**
 * judge() her sonucu belirliyor: bir stratejinin canliya adayi olup
 * olmadigina bu fonksiyon karar veriyor. Yanlissa butun edge aramasi
 * yanlis olur — o yuzden esiklerin her biri ayri ayri test edilmis
 * durumda.
 *
 * Esikler bilerek sert: bu asamada yanlis pozitif, yanlis negatiften cok
 * daha pahalidir. Elenen iyi bir strateji zaman kaybettirir; elenmeyen
 * kotu bir strateji para kaybettirir.
 */

const trade = (r: number, entryTime = 0): Trade => ({
  side: 'LONG',
  reason: 't',
  entryTime,
  entryPrice: 100,
  exitTime: entryTime + 1000,
  exitPrice: 100,
  stopLoss: 97,
  takeProfit: 106,
  exitReason: r > 0 ? 'tp' : 'sl',
  qty: 1,
  margin: 10,
  pnl: r * 10,
  fees: 0,
  funding: 0,
  r,
  balanceAfter: 1000,
  barsHeld: 1,
});

const cell = (over: Partial<SweepCell> = {}): SweepCell => ({
  strategy: 's',
  symbol: 'BTCUSDT',
  interval: '1h',
  inSample: segmentOf([], 1),
  outOfSample: segmentOf([], 1),
  baselineOos: segmentOf([], 1),
  edge: 0,
  overfitGap: 0,
  ...over,
});

/** Belirtilen beklenti ve islem sayisiyla bir hucre uretir. */
const cellWith = (
  oosExp: number,
  baseExp: number,
  n: number,
  isExp = oosExp,
): SweepCell => {
  const mk = (exp: number) => segmentOf(Array.from({ length: n }, () => trade(exp)), 1);
  return cell({
    inSample: mk(isExp),
    outOfSample: mk(oosExp),
    baselineOos: mk(baseExp),
    edge: oosExp - baseExp,
    overfitGap: isExp - oosExp,
  });
};

describe('segmentOf', () => {
  it('bos listede her sey sifir', () => {
    const s = segmentOf([], 1);
    expect(s.trades).toBe(0);
    expect(s.expectancyR).toBe(0);
    expect(s.returnPct).toBe(0);
  });

  it('beklentiyi islem basina ortalama R olarak verir', () => {
    const s = segmentOf([trade(2), trade(-1), trade(-1), trade(2)], 1);
    expect(s.totalR).toBeCloseTo(2, 6);
    expect(s.expectancyR).toBeCloseTo(0.5, 6);
    expect(s.winRatePct).toBeCloseTo(50, 6);
  });

  it('getiriyi BILESIK hesaplar — sabit yuzde risk bakiyeyle buyur', () => {
    // %1 riskle iki kez +1R: 1.01 * 1.01 = 1.0201
    const s = segmentOf([trade(1), trade(1)], 1);
    expect(s.returnPct).toBeCloseTo(2.01, 4);
  });

  it('maksimum dususu tepe noktasindan olcer', () => {
    // +2R sonra -1R -1R: tepe 1.02, dip 1.02*0.99*0.99
    const s = segmentOf([trade(2), trade(-1), trade(-1)], 1);
    expect(s.maxDrawdownPct).toBeCloseTo(1.99, 2);
  });
});

describe('judge — islem sayisi esikleri', () => {
  it('toplam 100 gorulmemis islemin altini reddeder', () => {
    // Beklenti mukemmel ama veri yok.
    const v = judge('s', [cellWith(1.0, 0, 30), cellWith(1.0, 0, 30)]);
    expect(v.verdict).toBe('yetersiz-veri');
    expect(v.note).toContain('anlamsiz');
  });

  it('sembol basina 25 islemin altindaki hucreler OY KULLANMAZ', () => {
    // Bu esik ilk taramanin yanlisini duzeltti: RSI uyumsuzlugu 69 TOPLAM
    // islemle "umutlu" cikmisti — sembol basina ~9 islem. Dokuz islemden
    // hesaplanan beklenti hicbir sey olcmez.
    const v = judge('s', [
      cellWith(0.5, 0, 10), // az islem — oy kullanamaz
      cellWith(0.5, 0, 10),
      cellWith(0.5, 0, 10),
      cellWith(-0.2, 0, 40), // olculebilir tek hucre
      cellWith(-0.2, 0, 40),
      cellWith(-0.2, 0, 40),
    ]);
    // Olculebilir hucrelerin hepsi negatif; az islemli parlak hucreler
    // sonucu kurtarmamali.
    expect(v.verdict).not.toBe('umutlu');
  });

  it('cogu sembolde olcum yapilamiyorsa yetersiz veri der', () => {
    const v = judge('s', [
      // Toplam 120 islem (100 esigini gecer) ama yalnizca BIR hucre
      // 25+ islem tasiyor — sembol bazinda olcum yapilamaz.
      cellWith(0.3, 0, 40),
      cellWith(0.3, 0, 20),
      cellWith(0.3, 0, 20),
      cellWith(0.3, 0, 20),
      cellWith(0.3, 0, 20),
    ]);
    expect(v.verdict).toBe('yetersiz-veri');
    expect(v.note).toContain('guvenilir degil');
  });
});

describe('judge — eleme esikleri', () => {
  it('gorulmemis veride kaybettireni eler', () => {
    const v = judge('s', [
      cellWith(-0.05, -0.1, 40),
      cellWith(-0.05, -0.1, 40),
      cellWith(-0.05, -0.1, 40),
    ]);
    expect(v.verdict).toBe('edge-yok');
    expect(v.note).toContain('kaybettiriyor');
  });

  it('pozitif ama yazi-turadan ayrismayani eler', () => {
    const v = judge('s', [
      cellWith(0.01, 0.005, 40),
      cellWith(0.01, 0.005, 40),
      cellWith(0.01, 0.005, 40),
    ]);
    expect(v.verdict).toBe('edge-yok');
    expect(v.note).toContain('ayrismiyor');
  });

  it('tek sembolde parlayip digerlerinde soneni asiri uydurma sayar', () => {
    const v = judge('s', [
      cellWith(1.2, 0, 40), // tek basina ortalamayi pozitife cekiyor
      cellWith(-0.1, 0, 40),
      cellWith(-0.1, 0, 40),
      cellWith(-0.1, 0, 40),
    ]);
    expect(v.verdict).toBe('asiri-uydurma');
    expect(v.positiveSymbols).toBe(1);
  });

  it('bilinen donemde iyi, gorulmemiste kotu olani asiri uydurma sayar', () => {
    const v = judge('s', [
      cellWith(0.05, 0, 40, 0.4),
      cellWith(0.05, 0, 40, 0.4),
      cellWith(0.05, 0, 40, 0.4),
    ]);
    expect(v.verdict).toBe('asiri-uydurma');
    expect(v.note).toContain('tasinmiyor');
  });

  it('coklu sembolde tutarli ve tabandan ayrisani umutlu bulur', () => {
    const v = judge('s', [
      cellWith(0.12, 0.0, 40),
      cellWith(0.09, 0.0, 40),
      cellWith(0.11, 0.0, 40),
      cellWith(-0.02, 0.0, 40),
    ]);
    expect(v.verdict).toBe('umutlu');
    expect(v.positiveSymbols).toBe(3);
    expect(v.avgEdge).toBeGreaterThan(0.02);
  });

  it('islem sayisini tum hucrelerden toplar', () => {
    const v = judge('s', [
      cellWith(0.1, 0, 40),
      cellWith(0.1, 0, 40),
      cellWith(0.1, 0, 40),
    ]);
    expect(v.totalOosTrades).toBe(120);
    expect(v.verdict).not.toBe('yetersiz-veri');
  });
});

describe('judge — ortalamalar YALNIZCA oy kullanan hucrelerden', () => {
  /**
   * votingCells filtresi kurulmustu ama SADECE positiveSymbols sayiminda
   * kullaniliyordu; kararin asil iki kapisi (avgOosExpectancy, avgEdge)
   * hala TUM hucreler uzerinden ortalaniyordu. Yani "dokuz islemden
   * hesaplanan bir beklenti hicbir sey olcmez" kurali konulup, tam o dokuz
   * islem karara sokuluyordu.
   */

  it('az islemli SANSLI hucreler karari BASTIRAMAZ', () => {
    // Bes hucre x 40 islem: edge -0.014 R (esigin ALTINDA, elenmeli).
    const cok = Array.from({ length: 5 }, () => cellWith(0.001, 0.015, 40));
    // Uc hucre x 3 islem: sansli +0.8 R. Toplam 9 islem.
    const az = Array.from({ length: 3 }, () => cellWith(0.8, 0, 3));

    const v = judge('s', [...cok, ...az]);

    // Oy kullanan bes hucrenin gercek edge'i negatif -> elenmeli.
    expect(v.verdict).not.toBe('umutlu');
    // Ve raporlanan ortalama, 9 islemlik sansla sisirilmemis olmali.
    expect(v.avgEdge).toBeLessThan(0.02);
    expect(v.avgOosExpectancy).toBeLessThan(0.1);
  });

  it('KARSI KONTROL: oy kullanan hucreler gercekten pozitifse umutlu kalir', () => {
    // Bu olmadan yukaridaki test "her seyi eliyor" diye de gecebilirdi.
    const cok = Array.from({ length: 6 }, () => cellWith(0.3, 0.05, 40));
    const v = judge('s', cok);
    expect(v.verdict).toBe('umutlu');
    expect(v.avgEdge).toBeCloseTo(0.25, 2);
  });

  it('az islemli hucreler overfitGap ortalamasini da bozmaz', () => {
    const cok = Array.from({ length: 5 }, () => cellWith(0.3, 0.05, 40, 0.32));
    const az = Array.from({ length: 3 }, () => cellWith(0.3, 0.05, 3, 5.0));
    const v = judge('s', [...cok, ...az]);
    // Oy kullanan hucrelerin asiri-uydurma bosluğu 0.02 (esik 0.15).
    // Az islemli hucrelerin 4.7'lik boslugu ortalamaya girseydi strateji
    // haksiz yere 'asiri-uydurma' damgasi yerdi.
    expect(v.verdict).toBe('umutlu');
  });
});

describe('measureShape — taban, stratejinin KENDI yapisini taklit etmeli', () => {
  /**
   * Taramanin en pahali hatasi: her strateji SABIT 1.5 ATR / R:R 2
   * yazi-turasiyla kiyaslaniyordu. Genis stop islem sayisini dusurur,
   * komisyon yuku duser, yani yazi-tura BILE "iyilesir" — ve o iyilesme
   * beceri gibi gorunur. Olculdu: sifir-beceri bir yazi-tura, 3 ATR / R:R 3
   * yapisinda sabit tabana karsi +0.164 R "edge" gosteriyordu.
   */

  /** ATR'si yaklasik 1.0 olan duz seri (fiyat 100 -> ATR %1). */
  const bars: Bar[] = Array.from({ length: 300 }, (_, i) => ({
    openTime: i * 3_600_000,
    open: 100,
    high: 100.5,
    low: 99.5,
    close: 100,
    volume: 1,
    closeTime: i * 3_600_000 + 3_599_999,
  }));

  const tr = (entry: number, stop: number, target: number): Trade => ({
    ...trade(0),
    entryPrice: entry,
    stopLoss: stop,
    takeProfit: target,
  });

  it('stop mesafesini ATR kati olarak olcer', () => {
    // Stop 3 uzakta, fiyat 100 -> %3. ATR %1 -> stopAtr ~3.
    const sh = measureShape(Array.from({ length: 50 }, () => tr(100, 97, 109)), bars);
    expect(sh.stopAtr).toBeCloseTo(3, 0);
  });

  it('R:R oranini olcer', () => {
    // stop 3, hedef 9 -> rr 3.
    const sh = measureShape(Array.from({ length: 50 }, () => tr(100, 97, 109)), bars);
    expect(sh.rr).toBeCloseTo(3, 2);
  });

  it('FARKLI yapiyi FARKLI olcer (sabit deger dondurmuyor)', () => {
    const dar = measureShape(Array.from({ length: 50 }, () => tr(100, 98.5, 101.5)), bars);
    const genis = measureShape(Array.from({ length: 50 }, () => tr(100, 94, 112)), bars);
    expect(genis.stopAtr).toBeGreaterThan(dar.stopAtr * 2);
    expect(dar.rr).toBeCloseTo(1, 1);
    expect(genis.rr).toBeCloseTo(2, 1);
  });

  it('islem sikligini da eslestirir', () => {
    // 300 mum, 30 islem -> her ~10 mumda bir.
    const sh = measureShape(Array.from({ length: 30 }, () => tr(100, 97, 109)), bars);
    expect(sh.tradeEveryN).toBe(10);
  });

  it('islem yoksa varsayilan yapiya duser, cokmez', () => {
    expect(measureShape([], bars)).toEqual(DEFAULT_SHAPE);
  });

  it('bozuk islem (stop = giris) cokme yaratmaz', () => {
    const sh = measureShape([tr(100, 100, 106), tr(100, 97, 109)], bars);
    expect(Number.isFinite(sh.stopAtr)).toBe(true);
    expect(Number.isFinite(sh.rr)).toBe(true);
  });
});
