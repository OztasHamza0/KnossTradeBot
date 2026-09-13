import { Executor } from './executor';
import { Signal } from '../backtest/types';

/**
 * Bu kod GOZETIMSIZ ve GERCEK PARAYLA calisacak. Buradaki testlerin her biri,
 * "pozisyon korumasiz kalabilir mi" ya da "beklenmedik sekilde para gidebilir
 * mi" sorusunun bir dalini kapatiyor.
 *
 * Sahte istemci kullaniliyor: gercek borsaya baglanmadan emir akisinin
 * mantigini sinamak icin. Borsa entegrasyonunun kendisi canli borsada ayrica
 * dogrulandi (giris + stop + hedef + iptal, 0.009 USDT maliyetle).
 */

const FILTERS = {
  symbol: 'SOLUSDT',
  stepSize: 0.01,
  tickSize: 0.01,
  minQty: 0.01,
  minNotional: 5,
  quantityPrecision: 2,
  pricePrecision: 2,
};

/**
 * Cagrilari kaydeden sahte istemci.
 *
 * MOCK GERCEGI YANSITMAK ZORUNDA. Onceki hali marketEntry'den
 * `avgPrice: 100` donduruyordu — GERCEK Binance USD-M bunu YAPMAZ:
 * /fapi/v1/order icin varsayilan cevap tipi ACK'tir ve ACK govdesinde
 * `avgPrice` her zaman "0" gelir. Mock iyimser davrandigi icin
 * "gercek dolum fiyati hic okunmuyor" hatasi testlerden GORUNMEDEN
 * gecti ve canliya cikti: kaydedilen giris fiyati dolum degil, karar
 * anindaki MARK idi.
 *
 * @param fillPrice Borsada olusan GERCEK ortalama giris. Bu dosyada varsayilan
 *   olarak mark'a ESIT (100): buradaki testler risk/boyut aritmetigini
 *   olcuyor ve kaymanin sifir olmasi o aritmetigi sadelestiriyor.
 *   Kaymanin KENDISI executor-denetim.spec.ts'te ayrica sinaniyor
 *   (orada fillPrice 100.05) — "giris fiyati borsadan mi okunuyor yoksa
 *   mark'a mi dusuluyor" sorusunun yeri orasi.
 */
function mockClient(over: Record<string, any> = {}, posAmt = 0, fillPrice = 100) {
  const calls: string[] = [];
  // Kapatma emri gonderildikten SONRA pozisyon 0 doner — gercek borsa boyle
  // davranir. Bu bayrak olmadan closeNow dogrulama adiminda 'hala pozisyon
  // var' gorup 'kismi' donuyordu.
  let closed = false;
  // marketEntry sonrasi borsada OLUSAN pozisyon. Gercek borsa emirden sonra
  // pozisyonu gosterir; mock bunu simule etmezse "dolumu borsadan oku"
  // yolu hic sinanamaz.
  let opened = 0;
  const base = {
    calls,
    symbolFilters: async () => FILTERS,
    markPrice: async () => 100,
    setIsolated: async () => { calls.push('setIsolated'); },
    setLeverage: async (_s: string, lev: number) => { calls.push('setLeverage:' + lev); },
    position: async () => {
      // Kapatma emri gonderildiyse pozisyon 0 doner — gercek borsa boyle
      // davranir. closeNow artik kapanmayi DOGRULUYOR, o yuzden mock'un da
      // dogru davranmasi sart; yoksa her kapatma 'kismi' gorunur.
      const amt = closed ? 0 : opened !== 0 ? opened : posAmt;
      return {
        symbol: 'SOLUSDT',
        positionAmt: amt,
        positionAmtRaw: String(amt),
        entryPrice: amt === 0 ? 0 : opened !== 0 ? fillPrice : 100,
        unrealizedProfit: 0,
        leverage: 3,
      };
    },
    closeMarket: async (_s: string, amt: string) => { calls.push('closeMarket:' + amt); closed = true; },
    openOrders: async () => [],
    openAlgoOrders: async () => [],
    cancelAll: async () => { calls.push('cancelAll'); },
    cancelAllAlgo: async () => { calls.push('cancelAllAlgo'); },
    cancelAlgoOrder: async () => { calls.push('cancelAlgoOrder'); },
    marketEntry: async (_s: string, side: string, qty: string) => {
      calls.push(`marketEntry:${side}:${qty}`);
      opened = (side === 'BUY' ? 1 : -1) * parseFloat(qty);
      // ACK cevabi: avgPrice HER ZAMAN 0. Gercek Binance davranisi.
      return { orderId: 1, clientOrderId: 'x', symbol: 'SOLUSDT', side, type: 'MARKET', status: 'NEW', avgPrice: 0, origQty: parseFloat(qty) };
    },
    protectiveOrder: async (_s: string, side: string, type: string, trigger: string) => {
      calls.push(`protective:${type}@${trigger}`);
      return { orderId: 2, clientOrderId: 'y', symbol: 'SOLUSDT', side, type, status: 'NEW', avgPrice: 0, origQty: 0 };
    },
  };
  return { ...base, ...over } as any;
}

const build = (client: any, dryRun = false) =>
  new Executor(client, { symbol: 'SOLUSDT', leverage: 3, riskPct: 1, dryRun }, () => undefined);

const sig = (over: Partial<Signal> = {}): Signal => ({
  side: 'LONG',
  stopLoss: 97,
  takeProfit: 106,
  reason: 't',
  ...over,
});

describe('execute — yon kontrolu', () => {
  it('stop girisin YANLIS tarafindaysa islem acmaz', async () => {
    // Sinyal mum kapanisindan, giris guncel mark'tan. Fiyat sicradiysa
    // LONG'un stopu mark'in USTUNDE kalabilir; o pozisyon acilir acilmaz
    // tetiklenir ve daha baslamadan zararla kapanir.
    const c = mockClient({ markPrice: async () => 96 }); // stop 97 > mark 96
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('atlandi');
    expect(r.detail).toContain('siralama bozuk');
    expect(c.calls.filter((x: string) => x.startsWith('marketEntry'))).toHaveLength(0);
  });

  it('SHORT icin de ayni kontrol calisir', async () => {
    const c = mockClient({ markPrice: async () => 104 }); // stop 103 < mark
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig({ side: 'SHORT', stopLoss: 103, takeProfit: 94 }), 1000);
    expect(r.action).toBe('atlandi');
    expect(c.calls.filter((x: string) => x.startsWith('marketEntry'))).toHaveLength(0);
  });

  it('siralama dogruysa gecer', async () => {
    const c = mockClient();
    const e = build(c);
    await e.prepare();
    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('girildi');
  });
});

describe('execute — fiyat kaymasi', () => {
  it('fiyat hedefe cok yaklastiysa kovalamaz', async () => {
    // mark 105.5, hedef 106 -> kalan odul 0.5, risk 8.5 -> 1:0.06
    const c = mockClient({ markPrice: async () => 105.5 });
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('atlandi');
    expect(r.detail).toContain('kovalamaca');
  });
});

describe('execute — koruma emri yazilamazsa', () => {
  it('pozisyonu ANINDA geri kapatir', async () => {
    // Korumasiz pozisyon tasimaktansa islemi hic yapmamak yeglenir.
    const c = mockClient(
      { protectiveOrder: async () => { throw new Error('borsa reddetti'); } },
      0.1, // giris doldu, pozisyon acik
    );
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('hata');
    expect(r.detail).toContain('geri kapatildi');
    // Kapatma emri gercekten gonderildi mi (SELL ile ters yon)?
    expect(c.calls.some((x: string) => x.startsWith('closeMarket'))).toBe(true);
  });

  it('kapatma da basarisiz olursa KRITIK uyarir', async () => {
    let first = true;
    const c = mockClient(
      {
        protectiveOrder: async () => { throw new Error('red'); },
        closeMarket: async () => { first = false; throw new Error('kapatilamadi'); },
      },
      0.1,
    );
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('hata');
    expect(r.detail).toContain('ELLE KAPAT');
  });
});

describe('execute — boyutlandirma', () => {
  it('stop calisirsa tam olarak riskPct kadar kaybettirir', async () => {
    const c = mockClient();
    const e = build(c);
    await e.prepare();

    // bakiye 1000, risk %1 = 10 USDT; stop mesafesi 3 -> qty 3.33
    const r = await e.execute(sig(), 1000);
    expect(r.quantity).toBeCloseTo(3.33, 2);
    expect(r.quantity! * 3).toBeCloseTo(10, 1); // qty x stopDist ~ 10 USDT
  });

  it('asgari emir buyuklugunun altinda islem acmaz', async () => {
    const c = mockClient();
    const e = build(c);
    await e.prepare();
    // bakiye 10 -> risk 0.1 USDT -> qty 0.03 -> 3.3 USDT < minNotional 5
    const r = await e.execute(sig(), 10);
    expect(r.action).toBe('atlandi');
    expect(c.calls.filter((x: string) => x.startsWith('marketEntry'))).toHaveLength(0);
  });

  it('marj tavani asilinca islem REDDEDILMEZ, miktar KUCULTULUR', async () => {
    // Bir guvenlik kapisinin isi islemleri engellemek degil kucultmektir.
    // Onceki hali reddediyordu ve olculdu ki sinyallerin ~%87'sini eliyordu:
    // canli kosuda uretilen tek sinyal de tam buna takildi.
    const c = mockClient();
    const big = new Executor(
      c, { symbol: 'SOLUSDT', leverage: 1, riskPct: 90, dryRun: false }, () => undefined,
    );
    await big.prepare();
    const r = await big.execute(sig(), 100);

    expect(r.action).toBe('girildi');
    // Marj tavani: bakiye 100 x %25 x 1x kaldirac / fiyat 100 = 0.25 adet
    expect(r.quantity).toBeCloseTo(0.25, 2);
    // Gerceklesen risk planlanandan DUSUK — daha guvenli taraf.
    expect(r.quantity! * 3).toBeLessThan(90);
  });
});

describe('reconcile — koruma ALGO emirlerinde aranir', () => {
  it('algo emri varsa pozisyonu korunmus sayar', async () => {
    // 9 Aralik 2025 sonrasi koruma emirleri normal openOrders'ta GORUNMEZ.
    // Orada aramak, korunan bir pozisyonu "korumasiz" sanip kapatmak demekti.
    const c = mockClient({
      openOrders: async () => [], // normal emirler BOS
      openAlgoOrders: async () => [
        { orderType: 'STOP_MARKET', side: 'SELL', triggerPrice: '97', clientAlgoId: 's-1' },
      ],
    }, 0.1);
    const e = build(c);
    await e.prepare();

    const r = await e.reconcile();
    expect(r.hasPosition).toBe(true);
    expect(c.calls.some((x: string) => x.startsWith('marketEntry'))).toBe(false);
  });

  it('stop yoksa korumasiz pozisyonu kapatir', async () => {
    const c = mockClient({ openAlgoOrders: async () => [] }, 0.1);
    const e = build(c);
    await e.prepare();

    const r = await e.reconcile();
    expect(r.hasPosition).toBe(false);
    expect(r.detail).toContain('kapatildi');
    expect(c.calls.some((x: string) => x.startsWith('closeMarket'))).toBe(true);
  });

  it('algo emri OKUNAMAZSA pozisyona DOKUNMAZ', async () => {
    const c = mockClient({ openAlgoOrders: async () => { throw new Error('ag hatasi'); } }, 0.1);
    const e = build(c);
    await e.prepare();

    const r = await e.reconcile();
    // ESKI DAVRANIS YANLISTI: okuma hatasi 'koruma yok' sayilip pozisyon
    // piyasadan kapatiliyordu. Tek bir gecici ag hatasi, saglam ve korunan
    // bir pozisyonu oldurmeye yetiyordu — ve bunu 'guvenli taraf' diye bir
    // testle sabitlemistim. Guvenli taraf, BILMEDIGIMIZ sey hakkinda karar
    // vermemektir.
    expect(r.state).toBe('bilinmiyor');
    expect(r.hasPosition).toBe(true);
    expect(c.calls.some((x: string) => x.startsWith('marketEntry'))).toBe(false);
  });
});

describe('kuru mod', () => {
  it('hicbir emir gondermez', async () => {
    const c = mockClient();
    const e = build(c, true);
    await e.prepare();
    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('kuru-mod');
    expect(c.calls).toHaveLength(0);
  });
});

describe('canPlaceProtection — -4509 red degildir', () => {
  it('-4509 (pozisyon gerekiyor) OK sayilir', async () => {
    // Kontrol pozisyonsuz yapildigi icin closePosition emri -4509 doner.
    // Bu, emir tipinin KABUL edildigi anlamina gelir. Red sanmak, koruma
    // pekala calisirken botun hic baslamamasina yol acardi.
    const c = mockClient({
      protectiveOrder: async () => {
        throw new Error('Binance -4509: Time in Force (TIF) GTE can only be used with open positions.');
      },
    });
    const e = build(c);
    await e.prepare();
    const r = await e.canPlaceProtection();
    expect(r.ok).toBe(true);
  });

  it('-4120 (uc desteklemiyor) gercek reddir', async () => {
    const c = mockClient({
      protectiveOrder: async () => {
        throw new Error('Binance -4120: Order type not supported for this endpoint.');
      },
    });
    const e = build(c);
    await e.prepare();
    const r = await e.canPlaceProtection();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('-4120');
  });

  it('basarili kontrol emri MUTLAKA iptal edilir', async () => {
    const c = mockClient();
    const e = build(c);
    await e.prepare();
    await e.canPlaceProtection();
    expect(c.calls).toContain('cancelAlgoOrder');
  });
});

describe('hasMatchingStop — stop GERCEKTEN bu pozisyonu koruyor mu', () => {
  const withPos = (algo: any[]) =>
    mockClient({ openAlgoOrders: async () => algo }, 0.1);

  const check = async (algo: any[]) => {
    const c = withPos(algo);
    const e = build(c);
    await e.prepare();
    const r = await e.reconcile();
    return { r, c };
  };

  it('ucus oncesi KONTROL emri (pf-) koruma sayilmaz', async () => {
    // canPlaceProtection tetigi piyasanin %50 altinda bir emir acip iptal
    // eder. Iptal basarisiz olursa borsada kalir. Eskiden bu emir "stop var"
    // diye okunuyordu ve pozisyon fiilen savunmasizken korunuyor saniliyordu.
    const { r, c } = await check([
      { orderType: 'STOP_MARKET', side: 'SELL', triggerPrice: '50', clientAlgoId: 'pf-123' },
    ]);
    expect(r.state).toBe('kapatildi');
    expect(c.calls.some((x: string) => x.startsWith('closeMarket'))).toBe(true);
  });

  it('YANLIS YONLU stop koruma sayilmaz', async () => {
    // LONG pozisyonu ancak SELL stop korur. BUY stop alakasizdir.
    const { r } = await check([
      { orderType: 'STOP_MARKET', side: 'BUY', triggerPrice: '97', clientAlgoId: 's-1' },
    ]);
    expect(r.state).toBe('kapatildi');
  });

  it('girisin YANLIS tarafindaki stop koruma sayilmaz', async () => {
    // LONG'un stopu girisin ALTINDA olmali; ustunde olan bir emir koruma
    // degil, tetiklendiginde kar aliyor demektir.
    const { r } = await check([
      { orderType: 'STOP_MARKET', side: 'SELL', triggerPrice: '105', clientAlgoId: 's-1' },
    ]);
    expect(r.state).toBe('kapatildi');
  });

  it('gecerli stop korunuyor sayilir ve pozisyona dokunulmaz', async () => {
    const { r, c } = await check([
      { orderType: 'STOP_MARKET', side: 'SELL', triggerPrice: '97', clientAlgoId: 's-1' },
    ]);
    expect(r.state).toBe('korunuyor');
    expect(c.calls.some((x: string) => x.startsWith('closeMarket'))).toBe(false);
  });

  it('SHORT icin yonler tersine calisir', async () => {
    const c = mockClient({
      position: async () => ({ symbol: 'SOLUSDT', positionAmt: -0.1, positionAmtRaw: '-0.1', entryPrice: 100, unrealizedProfit: 0, leverage: 3 }),
      openAlgoOrders: async () => [
        { orderType: 'STOP_MARKET', side: 'BUY', triggerPrice: '103', clientAlgoId: 's-1' },
      ],
    });
    const e = build(c);
    await e.prepare();
    expect((await e.reconcile()).state).toBe('korunuyor');
  });
});

describe('canPlaceProtection — hangi hata RED, hangisi KANIT', () => {
  /**
   * Bu kontrol botu bir kez 3.7 SAAT ayakta tutmadi.
   *
   * Kontrol her zaman SYMBOLS[0] uzerinde yapiliyordu. O sembolde acik
   * pozisyon ve onun closePosition stop emri varsa Binance -4130 doner:
   * "An open stop or take profit order with GTE and closePosition in the
   * direction is existing."
   *
   * Bu bir RED DEGIL, tam tersi KANIT: borsa emir tipini kabul etti ve
   * yalnizca ayni yonde zaten bir emir oldugu icin reddediyor. Yani
   * yetenek calisiyor VE korunmasi gereken pozisyonun korumasi yerinde.
   * Ayirt edemeyince bot, koruma pekala calisirken "yazamiyorum" deyip
   * hic baslamadi.
   */

  it('-4130 KABUL sayilir (zaten koruma emri var demek)', async () => {
    const c = mockClient({
      protectiveOrder: async () => {
        throw new Error(
          'Binance -4130: An open stop or take profit order with GTE and ' +
            'closePosition in the direction is existing.',
        );
      },
    });
    const e = build(c);
    await e.prepare();
    expect((await e.canPlaceProtection()).ok).toBe(true);
  });

  it('-4509 KABUL sayilir (kontrol pozisyonsuz yapiliyor)', async () => {
    const c = mockClient({
      protectiveOrder: async () => {
        throw new Error('Binance -4509: closePosition requires an open position');
      },
    });
    const e = build(c);
    await e.prepare();
    expect((await e.canPlaceProtection()).ok).toBe(true);
  });

  it('-4120 GERCEK RED — bu uc emir tipini desteklemiyor', async () => {
    // Karsi kontrol: her hatayi "kabul" saymiyoruz. Gercek engel budur
    // ve o durumda bot BASLAMAMALI, cunku stopu borsaya koyamiyoruz.
    const c = mockClient({
      protectiveOrder: async () => {
        throw new Error('Binance -4120: Order type not supported for this endpoint');
      },
    });
    const e = build(c);
    await e.prepare();
    const r = await e.canPlaceProtection();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('-4120');
  });

  it('basarili probe emri IPTAL EDILIR — geride kontrol emri kalmaz', async () => {
    const c = mockClient({});
    const e = build(c);
    await e.prepare();
    expect((await e.canPlaceProtection()).ok).toBe(true);
    expect(c.calls).toContain('cancelAlgoOrder');
  });
});

describe('portfoy marj butcesi', () => {
  /**
   * MAX_MARGIN_RATIO (%25) yalnizca ISLEM BASINA tavandi; portfoy
   * toplaminda hicbir sinir yoktu. Dort es zamanli pozisyonun her biri
   * ozkaynagin %25'ini kullanabilseydi hesabin TAMAMI kilitlenirdi:
   * kullanilabilir nakit sifir, acil kapatma icin manevra alani yok,
   * marj cagrisina karsi tampon yok.
   */

  it('butce, islem basi tavandan KUCUKse miktari kirpar', async () => {
    const c = mockClient({ markPrice: async () => 100 });
    // kaldirac 3, risk %1, stop 3 uzakta -> riske gore 3.33 adet,
    // notional 333, marj 111. Butce 50 USDT verirsek kirpilmali.
    const e = build(c);
    await e.prepare();
    const bol = await e.execute(sig(), 1000, 1000, 50);
    const dar = await e.execute(sig(), 1000, 1000, Infinity);
    expect(bol.action).toBe('girildi');
    expect(dar.action).toBe('girildi');
    expect(bol.quantity!).toBeLessThan(dar.quantity!);
    // Marj = miktar x fiyat / kaldirac; butceyi asmamali.
    expect((bol.quantity! * 100) / 3).toBeLessThanOrEqual(50 + 0.01);
  });

  it('butce BOLSA islem basi tavan gecerli kalir', async () => {
    // Karsi kontrol: butce, mevcut korumayi GEVSETMEMELI.
    const c = mockClient({ markPrice: async () => 100 });
    const e = new Executor(
      c, { symbol: 'SOLUSDT', leverage: 1, riskPct: 5, dryRun: false }, () => undefined,
    );
    await e.prepare();
    // Islem basi tavan: 1000 x %25 x 1 / 100 = 2.5 adet.
    const r = await e.execute(sig(), 1000, 1000, 999999);
    expect(r.quantity).toBeCloseTo(2.5, 2);
  });

  it('butce verilmezse eski davranis korunur', async () => {
    const c = mockClient({ markPrice: async () => 100 });
    const e = build(c);
    await e.prepare();
    const a = await e.execute(sig(), 1000, 1000);
    const b = await e.execute(sig(), 1000, 1000, Infinity);
    expect(a.quantity).toBeCloseTo(b.quantity!, 6);
  });
});

describe('prepare — acik pozisyonda kaldiraca DOKUNMAZ', () => {
  /**
   * prepare() her acilista cagriliyor. Bot acik bir pozisyonla yeniden
   * baslarsa setLeverage o pozisyonun LIKIDASYON MESAFESINI degistirir;
   * kaldirac yukseltilirse likidasyon fiyata YAKLASIR ve kullanici bunu
   * gormez — borsadaki stop yerinde durdugu icin her sey normal gorunur.
   */

  it('pozisyon YOKKEN izole marj ve kaldirac ayarlanir', () => {
    // Karsi kontrol once: bu olmadan asagidaki test "zaten hic
    // cagrilmiyor" diye de gecebilirdi.
    const c = mockClient({}, 0);
    return build(c).prepare().then(() => {
      // Kaldirac DEGERI de kaydediliyor: 'ayarlandi mi' ile 'DOGRU deger
      // ayarlandi mi' ayri sorular, ve reconcile artik kapali pozisyonda
      // kaldirac tazeliyor — hangi degerle cagrildigi onemli.
      expect(c.calls).toContain('setLeverage:3');
      expect(c.calls).toContain('setIsolated');
    });
  });

  it('ACIK pozisyon varken setLeverage CAGRILMAZ', async () => {
    const c = mockClient({}, 0.5);
    await build(c).prepare();
    expect(c.calls).not.toContain('setLeverage');
    expect(c.calls).not.toContain('setIsolated');
  });

  it('pozisyon OKUNAMAZSA da dokunulmaz — belirsizlikte ayar degistirilmez', async () => {
    const c = mockClient({ position: async () => { throw new Error('ag hatasi'); } }, 0);
    await build(c).prepare();
    expect(c.calls).not.toContain('setLeverage');
  });
});

describe('boyutlandirma — OZKAYNAKTAN, kullanilabilir nakitten DEGIL', () => {
  /**
   * Canli kosuda yakalandi: ayni tikte acilan 4 pozisyonun ilk ucu ~49 USDT
   * riskle acildi, dorduncusu 38.52 USDT ile. Sebep, boyutun availableBalance
   * uzerinden hesaplanmasiydi — acilan her pozisyonun bloke ettigi marj nakdi
   * dusuruyor, sonraki pozisyon sebepsiz kuculuyordu.
   *
   * Bu, "her islemde esit risk" ilkesini bozar. Backtest tam %1 risk aliyor;
   * canli %0.77 ile %1 arasinda savruluyorsa iki sistem ayni seyi olcmez.
   *
   * Ayni hata daha once zarar sinirinda yakalanmisti (ping() availableBalance
   * donuyordu); boyutlandirma tarafi o zaman duzeltilmemisti.
   */

  it('marj bloke olsa bile risk AYNI kalir', async () => {
    const c = mockClient({ markPrice: async () => 100 });
    const e = build(c); // kaldirac 3, risk %1, stop 3 uzakta

    await e.prepare();
    // Hic pozisyon yokken: kullanilabilir = ozkaynak = 1000 -> risk 10 USDT
    const bos = await e.execute(sig(), 1000, 1000);

    const c2 = mockClient({ markPrice: async () => 100 });
    const e2 = build(c2);
    await e2.prepare();
    // Uc pozisyon acilmis: nakit 400'e dusmus ama OZKAYNAK hala 1000.
    const dolu = await e2.execute(sig(), 400, 1000);

    expect(bos.action).toBe('girildi');
    expect(dolu.action).toBe('girildi');
    // Ikisi de ayni riski almali — marj blokesi boyutu DEGISTIRMEMELI.
    expect(dolu.riskUsdt).toBeCloseTo(bos.riskUsdt!, 6);
    expect(dolu.quantity).toBeCloseTo(bos.quantity!, 6);
    expect(dolu.riskUsdt).toBeCloseTo(10, 1);
  });

  it('marji karsilayamiyorsa yine de REDDEDER — odenebilirlik nakde bakar', async () => {
    // Karsi kontrol: boyut ozkaynaktan hesaplanir ama emri gercekten
    // acabilmek nakit ister. Bu kapi kaldirilirsa borsa emri reddeder ve
    // bot "emir gitti" sanip korumasiz kalabilir.
    const c = mockClient({ markPrice: async () => 100 });
    const e = build(c);
    await e.prepare();
    // Ozkaynak 1000 -> miktar 3.33, notional 333, marj 111.
    // Kullanilabilir nakit yalnizca 50 -> karsilanamaz.
    const r = await e.execute(sig(), 50, 1000);
    expect(r.action).toBe('atlandi');
    expect(r.detail).toContain('kullanilabilir');
    expect(c.calls.filter((x: string) => x.startsWith('marketEntry'))).toHaveLength(0);
  });

  it('ozkaynak verilmezse kullanilabilir nakde duser (acik pozisyon yokken dogru)', async () => {
    const c = mockClient({ markPrice: async () => 100 });
    const e = build(c);
    await e.prepare();
    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('girildi');
    expect(r.riskUsdt).toBeCloseTo(10, 1);
  });
});

describe('closeNow — kapatma dogrulanmadan koruma silinmez', () => {
  it('pozisyon kapanmadiysa koruma emirleri IPTAL EDILMEZ', async () => {
    // BU TEST BIR DONEM BOS GECIYORDU: posAmt varsayilani 0 oldugu icin
    // reconcile() 'bos' donup closeNow'a HIC ULASMIYORDU, ve "cancelAllAlgo
    // cagrilmadi" iddiasi bedavadan dogruydu. Adini verdigi korumayi hic
    // sinamayan bir test, o korumanin var oldugu yanilsamasini uretir —
    // bu projede tam olarak bu yuzden bir hata iki tur boyunca yasadi.
    //
    // Simdi gercekten kosuyor: acik pozisyon var, koruma yok, kapatma
    // emri gonderiliyor ama pozisyon KAPANMIYOR (closeMarket bilerek etkisiz).
    const c = mockClient(
      {
        openAlgoOrders: async () => [],
        // Kapatma emri "gidiyor" ama pozisyon duruyor — kismi dolum ya da
        // reddedilen reduceOnly emri boyle gorunur.
        closeMarket: async (_s: string, amt: string) => {
          c.calls.push('closeMarket:' + amt);
        },
      },
      0.1,
    );
    const e = build(c);
    await e.prepare();
    const rec = await e.reconcile();

    // Kapatma GERCEKTEN denendi mi (test bos gecmesin diye):
    expect(c.calls.some((x: string) => x.startsWith('closeMarket'))).toBe(true);
    // Ama pozisyon durdugu icin koruma emirleri SILINMEMELI:
    expect(c.calls).not.toContain('cancelAllAlgo');
    // Ve durum "kapatildi" DEGIL: pozisyon var sayilmali.
    expect(rec.state).toBe('bilinmiyor');
    expect(rec.hasPosition).toBe(true);
  });

  it('closePosition() KAPANMA SONUCUNU doner, void degil', async () => {
    // run.ts zaman asimli cikista bunu cagirip kaydi siliyordu. Sonuc
    // donmezse "kapatildi" varsayilir, kayit silinir, openCount ve toplam
    // risk o pozisyonu saymayi birakir ve hala acik pozisyonun USTUNE
    // yenisi acilabilir. Koruma emirleri closePosition kullandigi icin yeni
    // stop BIRLESIK pozisyonu kapatir — zarar hedeflenen riskin kati olur.
    const c = mockClient(
      {
        closeMarket: async (_s: string, amt: string) => {
          c.calls.push('closeMarket:' + amt);
        },
      },
      0.1,
    );
    const e = build(c);
    await e.prepare();
    expect(await e.closePosition()).toBe('kismi');
  });

  it('closePosition() pozisyon yokken bos doner', async () => {
    const c = mockClient({}, 0);
    const e = build(c);
    await e.prepare();
    expect(await e.closePosition()).toBe('bos');
    expect(c.calls.some((x: string) => x.startsWith('closeMarket'))).toBe(false);
  });

  it('closePosition() gercekten kapaninca kapandi doner', async () => {
    const c = mockClient({}, 0.1);
    const e = build(c);
    await e.prepare();
    expect(await e.closePosition()).toBe('kapandi');
  });

  it('koruma yazilamaz VE geri kapatma dogrulanmazsa KRITIK bildirir', async () => {
    // Ucuncu cagri yeri: koruma emri reddedilince pozisyon geri kapatiliyor.
    // Bu dal closeNow'un sonucunu ATIYOR ve kosulsuz "geri kapatildi"
    // diyordu — kapatma basarisiz olsa bile. Log "kapatildi" derken borsada
    // KORUMASIZ pozisyon duruyordu.
    const c = mockClient(
      {
        protectiveOrder: async () => {
          throw new Error('Binance -4120: not supported');
        },
        closeMarket: async (_s: string, amt: string) => {
          c.calls.push('closeMarket:' + amt);
        },
      },
      0,
    );
    // Giris dolduktan SONRA pozisyon var gorunmeli; mock'un posAmt'ini
    // marketEntry sonrasi elle aciyoruz.
    let acik = 0;
    c.position = async () => ({
      symbol: 'SOLUSDT',
      positionAmt: acik,
      positionAmtRaw: String(acik),
      entryPrice: acik === 0 ? 0 : 100,
      unrealizedProfit: 0,
      leverage: 3,
    });
    const asilEntry = c.marketEntry;
    c.marketEntry = async (sym: string, side: string, qty: string, id: string) => {
      acik = parseFloat(qty);
      return asilEntry(sym, side, qty, id);
    };

    const e = build(c);
    await e.prepare();
    const r = await e.execute(sig(), 1000);

    expect(r.action).toBe('hata');
    expect(r.detail).toContain('KRITIK');
    expect(r.detail).toContain('KORUMASIZ');
    // Koruma emirleri silinmemis olmali (pozisyon kapandigi dogrulanmadi).
    expect(c.calls).not.toContain('cancelAllAlgo');
  });

  it('kapatirken borsanin verdigi miktar YENIDEN YUVARLANMAZ', async () => {
    const c = mockClient({
      position: async () => ({ symbol: 'SOLUSDT', positionAmt: 0.043, positionAmtRaw: '0.043', entryPrice: 100, unrealizedProfit: 0, leverage: 3 }),
      openAlgoOrders: async () => [],
    });
    const e = build(c);
    await e.prepare();
    await e.reconcile();
    // Yuvarlansaydi 0.042 olurdu ve 0.001'lik artik korumasiz kalirdi.
    expect(c.calls).toContain('closeMarket:0.043');
  });
});

describe('execute — core/risk.ts kapilari artik CANLI yolda cagriliyor', () => {
  // Bu kontroller yazilmis ve test edilmisti ama canli yolda hic
  // cagrilmiyordu: olu koddu. Backtest'te uygulanan kurallarin canlida
  // uygulanmamasi, test edilen sistemle calisan sistemin farkli olmasidir.

  it('stop likidasyonun otesindeyse islem acmaz', async () => {
    // 10x kaldiracta likidasyon ~%9.5'te; stop %20 uzakta olursa stop
    // HIC calismaz, pozisyon likide olur.
    const c = mockClient();
    const e = new Executor(
      c, { symbol: 'SOLUSDT', leverage: 10, riskPct: 1, dryRun: false }, () => undefined,
    );
    await e.prepare();
    const r = await e.execute(sig({ stopLoss: 80, takeProfit: 160 }), 1000);
    expect(r.action).toBe('atlandi');
    expect(r.detail).toMatch(/likide|kaldıraç|kaldirac/i);
    expect(c.calls.filter((x: string) => x.startsWith('marketEntry'))).toHaveLength(0);
  });

  it('risk/odul 1:1.5 altindaysa islem acmaz', async () => {
    const c = mockClient();
    const e = build(c);
    await e.prepare();
    // stop 3 asagi, hedef 3 yukari -> 1:1
    const r = await e.execute(sig({ stopLoss: 97, takeProfit: 103 }), 1000);
    expect(r.action).toBe('atlandi');
    expect(r.detail).toContain('Risk/ödül');
  });

  it('marj tavani miktari kirpar, gerceklesen riski DUSURUR', async () => {
    // "Risk %1" yalnizca stop tam fiyatindan dolarsa dogrudur; boslukta
    // kayip marjin tamamina kadar cikar, o yuzden marj da sinirlanir.
    // Ama sinir islemi REDDETMEZ — miktari kirpar, boylece gerceklesen
    // risk planlanandan dusuk olur.
    const c = mockClient({ markPrice: async () => 100 });
    const e = new Executor(
      c, { symbol: 'SOLUSDT', leverage: 1, riskPct: 5, dryRun: false }, () => undefined,
    );
    await e.prepare();
    // Riske gore: 50 USDT / stop 3 = 16.67 adet.
    // Marj tavani : 1000 x %25 x 1x / 100 = 2.5 adet -> kirpilir.
    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('girildi');
    expect(r.quantity).toBeCloseTo(2.5, 2);
    expect(r.quantity! * 3).toBeLessThan(50); // gerceklesen risk < planlanan
  });

  it('kirpilan islemde GERCEKLESEN riski dondurur, planlanani degil', async () => {
    // Canli kosuda yakalandi: 4 acik pozisyonda kayitli toplam risk 143.60
    // USDT gorunurken gerceklesen 46.40 USDT idi. Cunku kayda planlanan risk
    // (bakiye x riskPct) yaziliyordu ve marj tavaninin miktari kirptigi
    // hesaba katilmiyordu. Sonucu iki katliydi: toplam risk tavani gereginden
    // erken kapanip islem kaciriyordu, ve R muhasebesi -- botun tum varlik
    // sebebi -- yanlis cikiyordu.
    const c = mockClient({ markPrice: async () => 100 });
    const e = new Executor(
      c, { symbol: 'SOLUSDT', leverage: 1, riskPct: 5, dryRun: false }, () => undefined,
    );
    await e.prepare();
    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('girildi');
    // Planlanan 50 USDT; miktar 2.5'e kirpildi, stop 3 uzakta -> 7.5 USDT.
    expect(r.riskUsdt).toBeCloseTo(7.5, 2);
    expect(r.riskUsdt).toBeLessThan(1000 * 0.05);
  });

  it('kirpilmayan islemde gerceklesen risk planlanana esittir', async () => {
    // Karsi kontrol: duzeltme, kirpma olmadigi durumda riski degistirmemeli.
    const c = mockClient({ markPrice: async () => 100 });
    const e = build(c); // kaldirac 3, risk %1
    await e.prepare();
    const r = await e.execute(sig(), 1000); // 10 USDT / stop 3 = 3.33 adet
    expect(r.action).toBe('girildi');
    expect(r.riskUsdt).toBeCloseTo(10, 1);
  });

  it('NaN miktar borsaya gonderilmez', async () => {
    // NaN her karsilastirmada false doner, yani "< minQty" kontrolunden
    // SESSIZCE geciyordu.
    const c = mockClient({ markPrice: async () => NaN });
    const e = build(c);
    await e.prepare();
    const r = await e.execute(sig(), 1000);
    expect(r.action).toBe('atlandi');
    expect(c.calls.filter((x: string) => x.startsWith('marketEntry'))).toHaveLength(0);
  });
});
