import { runBacktest } from './engine';
import { BacktestConfig, Signal, Strategy } from './types';
import { Bar } from '../data/types';

/**
 * Motorun dogrulugu her sonucu belirliyor.
 *
 * Yanlis bir backtest, backtest olmamasindan KOTUDUR: olmayan bir edge'e
 * guvenip canliya gecmeye ikna eder. Bu yuzden buradaki testler motorun
 * "iyi gorunme" yollarini tek tek kapatiyor.
 */

const bar = (
  openTime: number,
  open: number,
  high: number,
  low: number,
  close: number,
): Bar => ({
  openTime,
  open,
  high,
  low,
  close,
  volume: 1,
  closeTime: openTime + 3_600_000 - 1,
});

/** Maliyetsiz konfig: aritmetigi izole etmek icin. */
const noCost: BacktestConfig = {
  startBalance: 1000,
  riskPct: 1,
  leverage: 5,
  feePct: 0,
  slippagePct: 0,
  fundingPct: 0,
  maxBarsInTrade: 100,
};

/** Verilen indekste tek bir sinyal ureten strateji. */
const onceAt = (index: number, signal: Signal): Strategy => ({
  name: 'test',
  warmup: 0,
  onBar: (_b, i) => (i === index ? signal : null),
});

const flat = (n: number, price = 100): Bar[] =>
  Array.from({ length: n }, (_, i) =>
    bar(i * 3_600_000, price, price, price, price),
  );

describe('motor — giris zamanlamasi', () => {
  it('girisi SINYAL MUMUNUN KAPANISINDAN degil, SONRAKI mumun acilisindan alir', () => {
    const bars = flat(10);
    // 3. mumun acilisi farkli olsun ki hangisinden dolduruldugu belli olsun.
    bars[3] = bar(3 * 3_600_000, 110, 130, 109, 120);
    bars[4] = bar(4 * 3_600_000, 120, 130, 119, 125);

    const r = runBacktest(
      onceAt(2, { side: 'LONG', stopLoss: 90, takeProfit: 125, reason: 't' }),
      bars,
      'X',
      '1h',
      noCost,
    );

    expect(r.trades).toHaveLength(1);
    // Sinyal i=2'de olustu; dolum i=3'un ACILISI (110) olmali, i=2'nin
    // kapanisi (100) DEGIL.
    expect(r.trades[0].entryPrice).toBe(110);
  });

  it('son mumda sinyal olusursa islem acilmaz (dolacak mum yok)', () => {
    const bars = flat(5);
    const r = runBacktest(
      onceAt(4, { side: 'LONG', stopLoss: 90, takeProfit: 110, reason: 't' }),
      bars,
      'X',
      '1h',
      noCost,
    );
    expect(r.trades).toHaveLength(0);
  });
});

describe('motor — ayni mumda hem stop hem hedef', () => {
  it('STOP sayar, hedef degil (mum ici sira bilinmiyor)', () => {
    // Iyimser varsaymak backtest'i sistematik olarak sisiren en yaygin hata.
    const bars = flat(6);
    bars[2] = bar(2 * 3_600_000, 100, 100, 100, 100);
    // Giris mumu: hem 90'a hem 120'ye dokunuyor.
    bars[3] = bar(3 * 3_600_000, 100, 120, 90, 105);

    const r = runBacktest(
      onceAt(2, { side: 'LONG', stopLoss: 95, takeProfit: 115, reason: 't' }),
      bars,
      'X',
      '1h',
      noCost,
    );

    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe('sl');
    expect(r.trades[0].pnl).toBeLessThan(0);
  });
});

describe('motor — gelecege bakma', () => {
  it('stratejiye yalnizca o ana kadarki mumlar gosterilir', () => {
    const bars = flat(30);
    let maxSeen = -1;

    const spy: Strategy = {
      name: 'spy',
      warmup: 0,
      onBar: (b, i) => {
        // Motor diziyi kirpmiyor; sozlesme "i'den sonrasina bakma".
        // Burada dogruladigimiz sey, motorun i'yi dogru ilerlettigi.
        maxSeen = Math.max(maxSeen, i);
        expect(b.length).toBe(bars.length);
        return null;
      },
    };

    runBacktest(spy, bars, 'X', '1h', noCost);
    // Son mumda sinyal ise yaramayacagi icin motor oraya kadar gitmez.
    expect(maxSeen).toBe(bars.length - 2);
  });
});

describe('motor — boyutlandirma riske gore', () => {
  it('stop calisirsa tam olarak riskPct kadar kaybettirir', () => {
    const bars = flat(8);
    bars[3] = bar(3 * 3_600_000, 100, 100, 100, 100);
    bars[4] = bar(4 * 3_600_000, 100, 100, 89, 90); // stopa dokunur

    const r = runBacktest(
      onceAt(2, { side: 'LONG', stopLoss: 90, takeProfit: 130, reason: 't' }),
      bars,
      'X',
      '1h',
      noCost,
    );

    expect(r.trades).toHaveLength(1);
    // Bakiye 1000, risk %1 -> 10 USDT.
    expect(r.trades[0].pnl).toBeCloseTo(-10, 6);
    expect(r.trades[0].r).toBeCloseTo(-1, 6);
  });

  it('hedef tutarsa R:R kadar kazandirir', () => {
    const bars = flat(8);
    bars[3] = bar(3 * 3_600_000, 100, 100, 100, 100);
    bars[4] = bar(4 * 3_600_000, 100, 121, 100, 120);

    const r = runBacktest(
      onceAt(2, { side: 'LONG', stopLoss: 90, takeProfit: 120, reason: 't' }),
      bars,
      'X',
      '1h',
      noCost,
    );

    // Stop 10 birim asagida, hedef 20 birim yukarida -> 2R.
    expect(r.trades[0].r).toBeCloseTo(2, 6);
    expect(r.trades[0].pnl).toBeCloseTo(20, 6);
  });
});

describe('motor — maliyetler', () => {
  it('komisyon ve kayma sonucu KOTULESTIRIR', () => {
    const bars = flat(8);
    bars[3] = bar(3 * 3_600_000, 100, 100, 100, 100);
    bars[4] = bar(4 * 3_600_000, 100, 121, 100, 120);

    const signal: Signal = {
      side: 'LONG',
      stopLoss: 90,
      takeProfit: 120,
      reason: 't',
    };

    const clean = runBacktest(onceAt(2, signal), bars, 'X', '1h', noCost);
    const costly = runBacktest(onceAt(2, signal), bars, 'X', '1h', {
      ...noCost,
      feePct: 0.05,
      slippagePct: 0.02,
    });

    expect(costly.trades[0].pnl).toBeLessThan(clean.trades[0].pnl);
    expect(costly.trades[0].fees).toBeGreaterThan(0);
  });
});

describe('motor — pozisyon cakismasi', () => {
  it('pozisyon acikken yeni pozisyon acmaz', () => {
    const bars = flat(40);
    // Her mumda sinyal ureten strateji; motor yine de ust uste binmemeli.
    const always: Strategy = {
      name: 'always',
      warmup: 0,
      onBar: () => ({
        side: 'LONG',
        stopLoss: 99,
        takeProfit: 101,
        reason: 't',
      }),
    };

    const r = runBacktest(always, bars, 'X', '1h', {
      ...noCost,
      maxBarsInTrade: 5,
    });

    for (let i = 1; i < r.trades.length; i++) {
      expect(r.trades[i].entryTime).toBeGreaterThan(r.trades[i - 1].exitTime);
    }
  });
});

describe('motor — ozet metrikleri', () => {
  it('islem yoksa bakiye degismez ve oranlar sifirdir', () => {
    const r = runBacktest(
      { name: 'hic', warmup: 0, onBar: () => null },
      flat(50),
      'X',
      '1h',
      noCost,
    );
    expect(r.trades).toHaveLength(0);
    expect(r.endBalance).toBe(noCost.startBalance);
    expect(r.returnPct).toBe(0);
    expect(r.winRatePct).toBe(0);
    expect(r.expectancyR).toBe(0);
  });
});

describe('bosluk kapisi — giris stopu ya da hedefi ZATEN GECMISSE islem yok', () => {
  /**
   * Motorun en sinsi yalanlarindan biriydi.
   *
   * Sinyal i. mumun kapanisinda olusur, giris i+1'in ACILISINDA. Arada
   * bosluk varsa acilis stopun otesinde olabilir. Motor islemi yine de
   * aciyor, cikis dongusu ilk mumda "stop goruldu" deyip cikisi
   * signal.stopLoss'tan yaziyordu — ki LONG icin bu, giris fiyatinin
   * USTUNDEDIR. Yani stopu boslukla gecen islem defterlere KAR olarak
   * giriyordu: exitReason 'sl' ama r POZITIF.
   *
   * Canli yurutucu bunu zaten atliyor (execute() yon kontrolu). Motorun
   * ayni seyi yapmasi sart; yoksa olculen sistem ile calisan sistem
   * farkli olur.
   *
   * DIKKAT — bu testlerin ilk hali BOS GECIYORDU: sinyal 0. indekste
   * uretiliyordu ama motor dongusu i = max(warmup, 1)'den basliyor, yani
   * sinyal HIC ATESLENMIYORDU ve "islem yok" iddiasi bedavadan dogruydu.
   * Bu yuzden her testte once BOSLUKSUZ halin islem URETTIGI dogrulaniyor:
   * kapinin gercekten calistigini ancak boyle biliriz.
   */

  /** Sinyal 1. indekste; giris 2. mumun acilisindan. */
  const kur = (girisAcilis: number, side: 'LONG' | 'SHORT') => {
    const sig: Signal =
      side === 'LONG'
        ? { side, stopLoss: 97, takeProfit: 106, reason: 't' }
        : { side, stopLoss: 103, takeProfit: 94, reason: 't' };
    const bars: Bar[] = [
      bar(0, 100, 100, 100, 100),
      bar(3_600_000, 100, 100, 100, 100),
      bar(7_200_000, girisAcilis, girisAcilis + 1, girisAcilis - 1, girisAcilis),
      ...Array.from({ length: 20 }, (_, k) =>
        bar((k + 3) * 3_600_000, girisAcilis, girisAcilis + 1, girisAcilis - 1, girisAcilis),
      ),
    ];
    return runBacktest(onceAt(1, sig), bars, 'X', '1h', noCost);
  };

  it('KARSI KONTROL: bosluksuz acilis islem URETIR (test bos gecmesin)', () => {
    expect(kur(100, 'LONG').trades).toHaveLength(1);
    expect(kur(100, 'SHORT').trades).toHaveLength(1);
  });

  it('LONG: acilis stopun ALTINDA ise islem ACILMAZ (KAR yazilmaz)', () => {
    const r = kur(95, 'LONG'); // acilis 95 < stop 97
    expect(r.trades).toHaveLength(0);
  });

  it('SHORT: acilis stopun USTUNDE ise islem ACILMAZ', () => {
    const r = kur(105, 'SHORT'); // acilis 105 > stop 103
    expect(r.trades).toHaveLength(0);
  });

  it('LONG: acilis hedefi GECMISSE de islem acilmaz', () => {
    const r = kur(110, 'LONG'); // acilis 110 > hedef 106
    expect(r.trades).toHaveLength(0);
  });

  it('SHORT: acilis hedefi GECMISSE de islem acilmaz', () => {
    const r = kur(90, 'SHORT'); // acilis 90 < hedef 94
    expect(r.trades).toHaveLength(0);
  });
});

describe('fonlama — her zaman MALIYET, yone gore gelir DEGIL', () => {
  /**
   * Onceki hali `* (long ? 1 : -1)` idi: sabit pozitif oranla her SHORT
   * islem, tuttugu sure boyunca GARANTILI GELIR aliyordu. Motorun kendi
   * ilkesinin ("her belirsizlikte aleyhte varsayim") tam tersi, ve short
   * agirlikli stratejileri sistematik olarak sisiriyordu.
   */
  const fundingCfg: BacktestConfig = { ...noCost, fundingPct: 0.01 };

  const kosu = (side: 'LONG' | 'SHORT') => {
    const sig: Signal =
      side === 'LONG'
        ? { side, stopLoss: 97, takeProfit: 106, reason: 't' }
        : { side, stopLoss: 103, takeProfit: 94, reason: 't' };
    const bars: Bar[] = [
      bar(0, 100, 100, 100, 100),
      bar(3_600_000, 100, 100, 100, 100),
      ...Array.from({ length: 40 }, (_, k) =>
        bar((k + 2) * 3_600_000, 100, 100.5, 99.5, 100),
      ),
    ];
    return runBacktest(onceAt(1, sig), bars, 'X', '1h', fundingCfg);
  };

  it('KARSI KONTROL: iki yon de islem uretiyor', () => {
    expect(kosu('LONG').trades).toHaveLength(1);
    expect(kosu('SHORT').trades).toHaveLength(1);
  });

  it('SHORT fonlamadan GELIR ALMAZ', () => {
    const r = kosu('SHORT');
    expect(r.trades[0].funding).toBeGreaterThan(0); // pozitif = maliyet
    expect(r.totalFunding).toBeGreaterThan(0);
  });

  it('LONG ve SHORT AYNI fonlamayi oder', () => {
    expect(kosu('LONG').trades[0].funding).toBeCloseTo(
      kosu('SHORT').trades[0].funding, 6,
    );
  });
});

describe('cikis kurallari — basabas ve geri cekilme', () => {
  /**
   * Kullanicinin fikri: "hedefe %60 yaklasti ama duseceGini dusunuyorsak
   * %50'de satabilelim; her zaman hedefe ulasamiyoruz."
   *
   * Bu, hic bakilmamis bir eksen: 12 stratejide hep GIRIS kurali
   * degistirildi, CIKIS mekanizmasi ayni kaldi.
   *
   * BU AILE BACKTEST'I KOLAYCA YALANCI YAPAR. Mum icindeki fiyat YOLU
   * bilinmez; bir mum hem tetik hem cikis seviyesine degdiyse hangisinin
   * once oldugunu soyleyemeyiz. Motor bu yuzden tetiklenmeyi bir mum
   * GECIKMELI isler, ve asagidaki testlerin ikisi tam olarak bunu koruyor.
   */

  /** Giris 2. mumun acilisinda, 100'den. Stop 97 (3), hedef 106 (6). */
  const sig2: Signal = { side: 'LONG', stopLoss: 97, takeProfit: 106, reason: 't' };

  /** bars[2] giris mumu; sonrasi disaridan verilir. */
  const kur = (sonrasi: Bar[]): Bar[] => [
    bar(0, 100, 100, 100, 100),
    bar(3_600_000, 100, 100, 100, 100),
    ...sonrasi,
  ];

  const kos = (bars: Bar[], exit: BacktestConfig['exit']) =>
    runBacktest(onceAt(1, sig2), bars, 'X', '1h', { ...noCost, exit });

  it('geri cekilme: %60 gorulup %50 ye donunce ORADA cikar', () => {
    const bars = kur([
      // giris mumu: 103.6'yi gecti (tetik), ama cikis seviyesine (103) inmedi
      bar(7_200_000, 100, 104, 103.8, 104),
      // sonraki mum 103'e iniyor -> geri cekilme cikisi
      bar(10_800_000, 104, 104, 102, 102),
      // devaminda stopa gitse bile bizi ilgilendirmez
      // Stop mumu BOSLUKSUZ (102 acilis): boslugun etkisi ayri testte olculuyor.
      ...Array.from({ length: 5 }, (_, k) => bar((k + 4) * 3_600_000, 102, 102, 95, 96)),
    ]);
    const r = kos(bars, { kind: 'geri-cekilme', activateAtPct: 0.6, exitAtPct: 0.5 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitReason).toBe('geri-cekilme');
    expect(r.trades[0].exitPrice).toBeCloseTo(103, 6);
    // Risk 3 birim; 3 birim kar -> +1 R.
    expect(r.trades[0].r).toBeCloseTo(1, 2);
  });

  it('KARSI KONTROL: ayni mumlarda SABIT kural stopa gider', () => {
    // Bu olmadan yukaridaki test "zaten stop olmuyordu" diye de gecerdi.
    const bars = kur([
      bar(7_200_000, 100, 104, 103.8, 104),
      bar(10_800_000, 104, 104, 102, 102),
      // Stop mumu BOSLUKSUZ (102 acilis): boslugun etkisi ayri testte olculuyor.
      ...Array.from({ length: 5 }, (_, k) => bar((k + 4) * 3_600_000, 102, 102, 95, 96)),
    ]);
    const r = kos(bars, { kind: 'sabit' });
    expect(r.trades[0].exitReason).toBe('sl');
    expect(r.trades[0].r).toBeCloseTo(-1, 2);
  });

  it('GELECEGE BAKMA YOK: ayni mumda tetiklenip ayni mumda CIKAMAZ', () => {
    /**
     * Asil koruma bu. Giris mumu hem %60 seviyesini (103.6) hem %50
     * seviyesini (103) iceriyor — ama hangisinin once oldugunu BILMIYORUZ.
     * Ayni mumda cikmaya izin verilseydi motor, kanitlayamayacagi bir kari
     * defterlere yazardi.
     *
     * Bir sonraki mum dogrudan hedefe gidiyor: dogru davranis 'tp'.
     */
    const bars = kur([
      bar(7_200_000, 100, 104, 102, 104), // hem 103.6 hem 103 bu mumun icinde
      bar(10_800_000, 104, 107, 104, 107), // hedefe (106) gidiyor
      ...Array.from({ length: 3 }, (_, k) => bar((k + 4) * 3_600_000, 107, 107, 107, 107)),
    ]);
    const r = kos(bars, { kind: 'geri-cekilme', activateAtPct: 0.6, exitAtPct: 0.5 });
    expect(r.trades[0].exitReason).toBe('tp');
  });

  it('basabas: tetiklendikten sonra geri donus GIRISTE kapanir, stopta degil', () => {
    const bars = kur([
      bar(7_200_000, 100, 104, 103.8, 104), // tetik (103.6 asildi)
      bar(10_800_000, 104, 104, 96, 96),    // giris (100) ve stop (97) ikisi de bu mumda
      ...Array.from({ length: 3 }, (_, k) => bar((k + 4) * 3_600_000, 96, 96, 96, 96)),
    ]);
    const r = kos(bars, { kind: 'basabas', activateAtPct: 0.6 });
    expect(r.trades[0].exitReason).toBe('basabas');
    expect(r.trades[0].exitPrice).toBeCloseTo(100, 6);
    expect(r.trades[0].r).toBeCloseTo(0, 2);
  });

  it('basabas tetiklenmemisse ASIL stop gecerlidir', () => {
    const bars = kur([
      bar(7_200_000, 100, 102, 99, 100),  // %60 (103.6) hic gorulmedi
      bar(10_800_000, 100, 100, 96, 96),
      ...Array.from({ length: 3 }, (_, k) => bar((k + 4) * 3_600_000, 96, 96, 96, 96)),
    ]);
    const r = kos(bars, { kind: 'basabas', activateAtPct: 0.6 });
    expect(r.trades[0].exitReason).toBe('sl');
    expect(r.trades[0].r).toBeCloseTo(-1, 2);
  });
});

describe('bosluk: aleyhte onurlandirilir, lehte ONURLANDIRILMAZ', () => {
  const sig2: Signal = { side: 'LONG', stopLoss: 97, takeProfit: 106, reason: 't' };
  const kur = (sonrasi: Bar[]): Bar[] => [
    bar(0, 100, 100, 100, 100),
    bar(3_600_000, 100, 100, 100, 100),
    ...sonrasi,
  ];

  it('stopun ALTINDA acilan mumda dolum ACILIStan olur, stoptan degil', () => {
    /**
     * Onceki hali cikisi her zaman tam signal.stopLoss'tan yaziyordu.
     * Fiyat boslukla stopun altina acildiginda gercekte o fiyattan
     * dolamazsin — daha kotusunden dolarsin. Iyimser varsayim, olmayan
     * bir kayip azaltmasi uretiyordu.
     */
    const bars = kur([
      bar(7_200_000, 100, 100, 100, 100),
      bar(10_800_000, 94, 95, 93, 94), // stop 97'nin ALTINDA aciliyor
      ...Array.from({ length: 3 }, (_, k) => bar((k + 4) * 3_600_000, 94, 94, 94, 94)),
    ]);
    const r = runBacktest(onceAt(1, sig2), bars, 'X', '1h', noCost);
    expect(r.trades[0].exitReason).toBe('sl');
    expect(r.trades[0].exitPrice).toBeCloseTo(94, 6); // 97 DEGIL
    expect(r.trades[0].r).toBeLessThan(-1); // 1R'den fazla kayip
  });

  it('hedefi boslukla gecen mumda FAZLADAN kar yazilmaz', () => {
    // Lehte bosluk onurlandirilsaydi 110'dan cikardik; yolu bilmedigimiz
    // icin lehte varsayimi almiyoruz.
    const bars = kur([
      bar(7_200_000, 100, 100, 100, 100),
      bar(10_800_000, 110, 111, 109, 110), // hedef 106'nin USTUNDE aciliyor
      ...Array.from({ length: 3 }, (_, k) => bar((k + 4) * 3_600_000, 110, 110, 110, 110)),
    ]);
    const r = runBacktest(onceAt(1, sig2), bars, 'X', '1h', noCost);
    expect(r.trades[0].exitReason).toBe('tp');
    expect(r.trades[0].exitPrice).toBeCloseTo(106, 6); // 110 DEGIL
    expect(r.trades[0].r).toBeCloseTo(2, 2);
  });
});
