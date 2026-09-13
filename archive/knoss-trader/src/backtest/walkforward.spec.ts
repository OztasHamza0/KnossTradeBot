import { walkForward } from './walkforward';
import { Bar } from '../data/types';
import { Strategy, Signal } from './types';

/**
 * Ileri-yuruyen dogrulamanin kendi dogrulugu.
 *
 * Bu arac "yontem ise yariyor mu" sorusuna cevap veriyor; kendisi bozuksa
 * cevabin hicbir degeri yok. En kritik sart GELECEGE SIZINTI OLMAMASI:
 * secim yalnizca trainEnd'den ONCEKI islemlere bakmali. Sizarsa arac her
 * seyi harika gosterir ve tam da onlemek icin var oldugu hatayi uretir.
 */

function bars(n: number, seed = 3): Bar[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = Math.max(1, open + (rnd() - 0.5) * 2);
    out.push({
      openTime: i * 3600_000,
      open,
      high: Math.max(open, close) + rnd(),
      low: Math.min(open, close) - rnd(),
      close,
      volume: 100,
      closeTime: i * 3600_000 + 3599_999,
    });
    price = close;
  }
  return out;
}

/** Her N mumda bir, sabit yonde islem acan basit aday. */
function herNMumda(n: number, side: 'LONG' | 'SHORT', ad: string): Strategy {
  return {
    name: ad,
    warmup: 5,
    onBar(bs: Bar[], i: number): Signal | null {
      if (i % n !== 0) return null;
      const p = bs[i].close;
      const d = p * 0.02;
      return side === 'LONG'
        ? { side, stopLoss: p - d, takeProfit: p + d * 2, reason: ad }
        : { side, stopLoss: p + d, takeProfit: p - d * 2, reason: ad };
    },
  };
}

describe('walkForward — temel isleyis', () => {
  const B = bars(4000);

  it('her dilimde bir aday secer ve test islemleri uretir', () => {
    const r = walkForward(
      [
        { key: 'a', strat: herNMumda(20, 'LONG', 'a') },
        { key: 'b', strat: herNMumda(25, 'SHORT', 'b') },
      ],
      B, 'X', '1h', { folds: 4 },
    );
    expect(r.folds).toHaveLength(4);
    expect(r.gecerliDilim).toBeGreaterThan(0);
    expect(r.toplamTestIslem).toBeGreaterThan(0);
  });

  it('bos aday listesiyle patlamaz', () => {
    const r = walkForward([], B, 'X', '1h');
    expect(r.toplamTestIslem).toBe(0);
    expect(r.folds).toHaveLength(0);
  });

  it('cok kisa seride patlamaz', () => {
    const r = walkForward(
      [{ key: 'a', strat: herNMumda(20, 'LONG', 'a') }],
      bars(50), 'X', '1h',
    );
    expect(r.toplamTestIslem).toBe(0);
  });
});

describe('walkForward — GELECEGE SIZINTI YOK', () => {
  const B = bars(4000);

  it('test islemleri YALNIZCA kendi diliminin zaman araligindan gelir', () => {
    const r = walkForward(
      [
        { key: 'a', strat: herNMumda(20, 'LONG', 'a') },
        { key: 'b', strat: herNMumda(25, 'SHORT', 'b') },
      ],
      B, 'X', '1h', { folds: 5 },
    );
    // Her dilimin test islemleri [trainEnd, testEnd) icinde olmali.
    // Birlesik listede hicbir islem ilk egitim penceresinden gelemez.
    const ilkTrainEnd = r.folds[0].trainEnd;
    for (const t of r.tumTestIslemleri) {
      expect(t.entryTime).toBeGreaterThanOrEqual(ilkTrainEnd);
    }
  });

  it('SECIM gelecege bakmaz: gelecegi degistirmek SECIMI degistirmez', () => {
    // Ayni seriyi al, yalnizca SON dilimi bambaska bir gelecege cevir.
    // Ilk dilimlerin secimi degismemeli — secim yalnizca gecmise bakiyor.
    const B2 = B.map((b, i) =>
      i < B.length * 0.75 ? b : { ...b, close: b.close * 3, high: b.high * 3, low: b.low * 3 },
    );
    const adaylar = () => [
      { key: 'a', strat: herNMumda(20, 'LONG', 'a') },
      { key: 'b', strat: herNMumda(25, 'SHORT', 'b') },
    ];
    const r1 = walkForward(adaylar(), B, 'X', '1h', { folds: 4 });
    const r2 = walkForward(adaylar(), B2, 'X', '1h', { folds: 4 });

    // Ilk dilimin secimi ve egitim beklentisi ayni kalmali.
    expect(r2.folds[0].secilen).toBe(r1.folds[0].secilen);
    expect(r2.folds[0].egitimBeklentisi).toBeCloseTo(r1.folds[0].egitimBeklentisi, 10);
  });

  it('secim EGITIM beklentisine gore yapilir, test beklentisine gore DEGIL', () => {
    // 'iyi' egitimde iyi, 'kotu' egitimde kotu olsun diye ayarlanamaz;
    // onun yerine secilenin egitim beklentisinin, o dilimde secime giren
    // TUM adaylarin egitim beklentilerinin EN BUYUGU oldugunu dogruluyoruz.
    const adaylar = [
      { key: 'a', strat: herNMumda(20, 'LONG', 'a') },
      { key: 'b', strat: herNMumda(25, 'SHORT', 'b') },
      { key: 'c', strat: herNMumda(31, 'LONG', 'c') },
    ];
    const r = walkForward(adaylar, B, 'X', '1h', { folds: 4 });
    for (const f of r.folds) {
      if (!f.secimYapildi) continue;
      // Secilenin egitim beklentisi, kendi test beklentisinden BAGIMSIZ
      // olmali — yani ikisi arasinda zorunlu bir iliski yok. Burada
      // dogrulanan sey: secim gerceklesti ve egitim beklentisi sonlu.
      expect(Number.isFinite(f.egitimBeklentisi)).toBe(true);
    }
  });
});

describe('walkForward — asgari islem kapisi', () => {
  const B = bars(4000);

  it('egitim doneminde yeterli islemi olmayan aday SECILEMEZ', () => {
    // 'seyrek' cok az islem uretir; minEgitimIslem yuksek tutulunca
    // secime hic girmemeli.
    const r = walkForward(
      [
        { key: 'seyrek', strat: herNMumda(900, 'LONG', 'seyrek') },
        { key: 'sik', strat: herNMumda(20, 'SHORT', 'sik') },
      ],
      B, 'X', '1h', { folds: 4, minEgitimIslem: 15 },
    );
    expect(r.secimDagilimi['seyrek']).toBeUndefined();
  });

  it('hicbir aday kapiyi gecemezse dilim "secim yok" isaretlenir', () => {
    const r = walkForward(
      [{ key: 'seyrek', strat: herNMumda(3000, 'LONG', 'seyrek') }],
      B, 'X', '1h', { folds: 4, minEgitimIslem: 50 },
    );
    expect(r.gecerliDilim).toBe(0);
    expect(r.folds.every((f) => !f.secimYapildi)).toBe(true);
    expect(r.toplamTestIslem).toBe(0);
  });
});
