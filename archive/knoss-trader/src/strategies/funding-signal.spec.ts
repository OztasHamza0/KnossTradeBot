import { hizalaFunding, fundingSignal, DEFAULT_FUNDING_SIGNAL } from './funding-signal';
import { Bar } from '../data/types';
import { FundingPoint } from '../data/funding';

/**
 * Fonlama sinyalinin dogrulugu.
 *
 * EN KRITIK SART: gelecege bakmamak. Fonlama 8 saatte bir yayinlanir;
 * bir mumun kapanisinda YALNIZCA o ana kadar yayinlanmis oranlar bilinir.
 * Kapanistan SONRA yayinlanan bir orani kullanmak backtest'i kahin yapar
 * ve bu hata SESSIZDIR — sonuc harika gorunur, canlida coker.
 *
 * Bu projede ayni hata rsi-divergence'ta (pivot onayi) bir kez yakalandi.
 */

const SAAT = 3600_000;

/** i. mum: [i*1h, i*1h + 1h). closeTime = acilis + 1 saat - 1 ms. */
function bars(n: number, baslangic = 0): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const t = baslangic + i * SAAT;
    out.push({
      openTime: t,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1,
      closeTime: t + SAAT - 1,
    });
  }
  return out;
}

const fp = (saat: number, rate: number): FundingPoint => ({
  time: saat * SAAT,
  rate,
});

describe('hizalaFunding — GELECEGE BAKMA YOK', () => {
  it('mumun kapanisindan SONRA yayinlanan oran KULLANILMAZ', () => {
    const b = bars(10);
    // Fonlama 5. saatte yayinlaniyor. 0-4. mumlar bunu BILEMEZ.
    const f = [fp(5, 0.001)];
    const h = hizalaFunding(b, f, 10);

    for (let i = 0; i < 5; i++) {
      expect(h.rate[i]).toBeNull(); // heniz yayinlanmadi
    }
    // 5. mum [5h, 6h) araliginda, kapanisi 6h-1ms > 5h -> BILINIR
    expect(h.rate[5]).toBeCloseTo(0.001, 10);
  });

  it('tam kapanis anina denk gelen oran BILINIR sayilir (<=)', () => {
    const b = bars(3);
    // 0. mumun kapanisi 1h-1ms. Tam o ana yayinlanan oran bilinir.
    const f = [{ time: SAAT - 1, rate: 0.002 }];
    const h = hizalaFunding(b, f, 10);
    expect(h.rate[0]).toBeCloseTo(0.002, 10);
  });

  it('kapanistan 1 ms SONRA yayinlanan oran bilinmez', () => {
    const b = bars(3);
    const f = [{ time: SAAT, rate: 0.002 }]; // 0. mum kapanisi SAAT-1
    const h = hizalaFunding(b, f, 10);
    expect(h.rate[0]).toBeNull();
    expect(h.rate[1]).toBeCloseTo(0.002, 10);
  });

  it('GELECEGI DEGISTIRMEK gecmisin hizalamasini DEGISTIRMEZ', () => {
    const b = bars(40);
    const temel: FundingPoint[] = [];
    for (let s = 0; s < 40; s += 8) temel.push(fp(s, 0.0001 * (s + 1)));

    // Ayni seriyi al, SON iki fonlama noktasini bambaska yap.
    const degisik = temel.map((p, k) =>
      k < temel.length - 2 ? p : { ...p, rate: 99 },
    );

    const a = hizalaFunding(b, temel, 20);
    const c = hizalaFunding(b, degisik, 20);

    // Degistirilen noktalardan ONCEKI mumlarin orani ve yuzdeligi
    // birebir ayni kalmali.
    const sonDegismeyen = temel[temel.length - 3].time;
    for (let i = 0; i < b.length; i++) {
      if (b[i].closeTime >= sonDegismeyen) break;
      expect(c.rate[i]).toBe(a.rate[i]);
      expect(c.pct[i]).toBe(a.pct[i]);
    }
  });

  it('yuzdelik yalnizca GECMIS pencereden hesaplanir', () => {
    const b = bars(200);
    const f: FundingPoint[] = [];
    // Once 30 dusuk, sonra 1 cok yuksek, sonra 30 dusuk daha.
    for (let k = 0; k < 30; k++) f.push(fp(k * 8, 0.0001));
    f.push(fp(30 * 8, 0.01)); // zirve
    for (let k = 31; k < 61; k++) f.push(fp(k * 8, 0.0001));

    const h = hizalaFunding(b, f, 60);
    // Zirvenin YAYINLANDIGI andan onceki mumlarda yuzdelik yuksek OLMAMALI.
    const zirveZaman = 30 * 8 * SAAT;
    for (let i = 0; i < b.length; i++) {
      if (b[i].closeTime >= zirveZaman) break;
      if (h.pct[i] === null) continue;
      expect(h.pct[i]!).toBeLessThan(100);
    }
  });

  it('bos fonlama serisiyle patlamaz', () => {
    const h = hizalaFunding(bars(5), [], 10);
    expect(h.rate.every((x) => x === null)).toBe(true);
  });

  it('siralanmamis fonlama serisi once siralanir', () => {
    const b = bars(20);
    const karisik = [fp(16, 0.003), fp(0, 0.001), fp(8, 0.002)];
    const h = hizalaFunding(b, karisik, 10);
    expect(h.rate[1]).toBeCloseTo(0.001, 10);
    expect(h.rate[9]).toBeCloseTo(0.002, 10);
    expect(h.rate[17]).toBeCloseTo(0.003, 10);
  });
});

describe('fundingSignal — sinyal mantigi', () => {
  /**
   * Once DALGALI bir taban, sonra ANI bir zirve.
   *
   * Ilk hali surekli artan bir seriydi ve hicbir sinyal uretmiyordu —
   * dogru sebeple: her yeni deger penceresinin en buyugu oldugu icin
   * yuzdelik HEP %100'de kaliyor, yani "dilime GECIS" hic olmuyor.
   * Kod dogruydu, testin kurgusu yanlisti. Gecis olmasi icin once
   * dilimin DISINDA bir donem gerekiyor.
   */
  function seri(n: number): FundingPoint[] {
    const f: FundingPoint[] = [];
    // SABIT taban: midrank sayesinde yuzdelik %50'de durur, gecis olmaz.
    // (Dalgali taban denenmisti; sinus uc dilimlere girip cikiyor ve ilk
    //  sinyal zirveden ONCE olusuyordu — test yanlis tarafi olcuyordu.)
    for (let k = 0; k < n - 3; k++) f.push(fp(k * 8, 0.0002));
    // Ani zirve: yuzdelik ust dilime GECER.
    for (let k = n - 3; k < n; k++) f.push(fp(k * 8, 0.006));
    return f;
  }

  it('SABIT fonlama penceresi %50 verir — sahte uc deger uretmez', () => {
    const b = bars(400);
    const sabit: FundingPoint[] = [];
    for (let k = 0; k < 50; k++) sabit.push(fp(k * 8, 0.0003));
    const h = hizalaFunding(b, sabit, 40);
    const dolu = h.pct.filter((x): x is number => x !== null);
    expect(dolu.length).toBeGreaterThan(0);
    for (const x of dolu) expect(x).toBeCloseTo(50, 6);
  });

  it('kontrarian: asiri POZITIF fonlamada SHORT acar', () => {
    const b = bars(400);
    const s = fundingSignal(seri(50), {
      ...DEFAULT_FUNDING_SIGNAL,
      contrarian: true,
      lookback: 40,
      edgePct: 20,
    });
    let bulundu: string | null = null;
    for (let i = s.warmup; i < b.length; i++) {
      const sig = s.onBar(b, i);
      if (sig) { bulundu = sig.side; break; }
    }
    expect(bulundu).toBe('SHORT');
  });

  it('momentum: ayni durumda LONG acar (zit hipotez)', () => {
    const b = bars(400);
    const s = fundingSignal(seri(50), {
      ...DEFAULT_FUNDING_SIGNAL,
      contrarian: false,
      lookback: 40,
      edgePct: 20,
    });
    let bulundu: string | null = null;
    for (let i = s.warmup; i < b.length; i++) {
      const sig = s.onBar(b, i);
      if (sig) { bulundu = sig.side; break; }
    }
    expect(bulundu).toBe('LONG');
  });

  it('minAbsRate altindaki sakin fonlamada sinyal URETMEZ', () => {
    const b = bars(400);
    // Hepsi cok kucuk oranlar — yuzdelik uc dilime girse bile gurultu.
    const f: FundingPoint[] = [];
    for (let k = 0; k < 50; k++) f.push(fp(k * 8, 0.0000001 * k));
    const s = fundingSignal(f, {
      ...DEFAULT_FUNDING_SIGNAL,
      lookback: 40,
      minAbsRate: 0.0001,
    });
    let sayac = 0;
    for (let i = s.warmup; i < b.length; i++) if (s.onBar(b, i)) sayac++;
    expect(sayac).toBe(0);
  });

  it('uc dilimde DURMAK degil, dilime GECMEK tetikler', () => {
    const b = bars(600);
    // Fonlama yuksek kalip sabitleniyor: tek bir gecis olmali, seri degil.
    const f: FundingPoint[] = [];
    for (let k = 0; k < 30; k++) f.push(fp(k * 8, 0.0001));
    for (let k = 30; k < 70; k++) f.push(fp(k * 8, 0.005)); // yuksek ve SABIT
    const s = fundingSignal(f, { ...DEFAULT_FUNDING_SIGNAL, lookback: 40 });
    let sayac = 0;
    for (let i = s.warmup; i < b.length; i++) if (s.onBar(b, i)) sayac++;
    // Dilimin icinde durmak her mumda sinyal uretseydi yuzlerce olurdu.
    expect(sayac).toBeLessThan(10);
  });

  it('negatif stop uretmez (ts-momentum dersi)', () => {
    // Fiyat cok dusuk, ATR fiyatin yarisindan buyuk olacak sekilde.
    const b: Bar[] = [];
    for (let i = 0; i < 400; i++) {
      const t = i * SAAT;
      b.push({ openTime: t, open: 1, high: 50, low: 0.5, close: 1, volume: 1, closeTime: t + SAAT - 1 });
    }
    const s = fundingSignal(seri(50), { ...DEFAULT_FUNDING_SIGNAL, lookback: 40, stopAtr: 5 });
    for (let i = s.warmup; i < b.length; i++) {
      const sig = s.onBar(b, i);
      if (sig) {
        expect(sig.stopLoss).toBeGreaterThan(0);
        expect(sig.takeProfit).toBeGreaterThan(0);
      }
    }
  });
});
