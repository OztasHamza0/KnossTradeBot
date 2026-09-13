import { Executor } from './executor';
import { Signal } from '../backtest/types';

/**
 * DENETIM TURU REGRESYON TESTLERI.
 *
 * Buradaki her test, denetimde bulunan ve CANLIDA DURAN bir hatayi yakaliyor.
 * Her describe blogunun basinda hatanin ne yaptigi yaziyor.
 *
 * Ayri dosyada tutulmalarinin sebebi: executor.spec.ts'teki sahte istemci
 * marketEntry'den `avgPrice: 100` donduruyordu ve GERCEK Binance bunu yapmaz.
 * Buradaki mock gercek davranisi taklit ediyor — ACK cevabinda avgPrice "0",
 * ve pozisyon emirden SONRA borsada gorunur hale geliyor.
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
 * @param posAmt    Bot girmeden ONCE borsada duran pozisyon.
 * @param fillPrice Girisin borsada olusan GERCEK ortalama fiyati.
 *                  Mark 100; farkli olmasi kaymanin gorulmesini saglar.
 */
function mockClient(over: Record<string, any> = {}, posAmt = 0, fillPrice = 100.05) {
  const calls: string[] = [];
  let closed = false;
  let opened = 0;

  const base: Record<string, any> = {
    calls,
    symbolFilters: async () => FILTERS,
    markPrice: async () => 100,
    setIsolated: async () => {
      calls.push('setIsolated');
    },
    setLeverage: async (_s: string, lev: number) => {
      calls.push('setLeverage:' + lev);
    },
    position: async () => {
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
    closeMarket: async (_s: string, amt: string) => {
      calls.push('closeMarket:' + amt);
      closed = true;
    },
    openOrders: async () => [],
    openAlgoOrders: async () => [],
    cancelAll: async () => {
      calls.push('cancelAll');
    },
    cancelAllAlgo: async () => {
      calls.push('cancelAllAlgo');
    },
    cancelAlgoOrder: async () => {
      calls.push('cancelAlgoOrder');
    },
    marketEntry: async (_s: string, side: string, qty: string) => {
      calls.push(`marketEntry:${side}:${qty}`);
      opened = (side === 'BUY' ? 1 : -1) * parseFloat(qty);
      // GERCEK BINANCE ACK CEVABI: avgPrice HER ZAMAN "0", status "NEW".
      return {
        orderId: 1,
        clientOrderId: 'x',
        symbol: 'SOLUSDT',
        side,
        type: 'MARKET',
        status: 'NEW',
        avgPrice: 0,
        origQty: parseFloat(qty),
      };
    },
    protectiveOrder: async (_s: string, side: string, type: string, trigger: string) => {
      calls.push(`protective:${type}@${trigger}`);
      return {
        orderId: 2,
        clientOrderId: 'y',
        symbol: 'SOLUSDT',
        side,
        type,
        status: 'NEW',
        avgPrice: 0,
        origQty: 0,
      };
    },
  };
  return { ...base, ...over } as any;
}

const build = (client: any, leverage = 3) =>
  new Executor(
    client,
    { symbol: 'SOLUSDT', leverage, riskPct: 1, dryRun: false },
    () => undefined,
  );

const sig = (over: Partial<Signal> = {}): Signal => ({
  side: 'LONG',
  stopLoss: 97,
  takeProfit: 106,
  reason: 't',
  ...over,
});

const stopOrder = {
  orderType: 'STOP_MARKET',
  side: 'SELL',
  triggerPrice: '97',
  clientAlgoId: 's-1',
};
const tpOrder = {
  orderType: 'TAKE_PROFIT_MARKET',
  side: 'SELL',
  triggerPrice: '106',
  clientAlgoId: 't-1',
};

describe('reconcile — SAHIPLIK: bot baskasinin pozisyonuna dokunmaz', () => {
  /**
   * HATA: reconcile() semboldeki HER pozisyonu kendi pozisyonu sayiyordu.
   * Aciliste "botun ACMADIGI pozisyon var -> baslama" kapisi vardi ama
   * CALISMA SIRASINDA hicbir kontrol yoktu. Bot koserken Binance panelinden
   * elle acilan (stopu heniz konmamis) bir pozisyon, bir sonraki tikte bot
   * tarafindan PIYASADAN KAPATILIYORDU. Aciliste reddedilen davranisin
   * calisma sirasinda serbest olmasi, kapinin kendisini anlamsiz kilar.
   */
  it('owned=false ve stop yokken pozisyonu KAPATMAZ', async () => {
    const c = mockClient({ openAlgoOrders: async () => [] }, 5);
    const e = build(c);
    await e.prepare();
    c.calls.length = 0;

    const r = await e.reconcile({ owned: false });

    expect(r.state).toBe('yabanci');
    expect(r.hasPosition).toBe(true);
    expect(c.calls.filter((x: string) => x.startsWith('closeMarket'))).toHaveLength(0);
    expect(c.calls).not.toContain('cancelAllAlgo');
  });

  it('owned=true ve stop yokken korumasiz pozisyonu KAPATIR', async () => {
    const c = mockClient({ openAlgoOrders: async () => [] }, 5);
    const e = build(c);
    await e.prepare();

    const r = await e.reconcile({ owned: true });

    expect(r.state).toBe('kapatildi');
    expect(c.calls.some((x: string) => x.startsWith('closeMarket'))).toBe(true);
  });

  it('owned verilmezse eski davranis korunur (trade.ts gibi cagrilar bozulmaz)', async () => {
    const c = mockClient({ openAlgoOrders: async () => [] }, 5);
    const e = build(c);
    await e.prepare();
    expect((await e.reconcile()).state).toBe('kapatildi');
  });
});

describe('reconcile — HEDEF emri takibi', () => {
  /**
   * HATA: hasMatchingStop yalnizca STOP ariyordu. Hedef emri kaybolsa bot
   * bunu HIC fark etmiyordu. Pozisyon korumasiz kalmaz ama OLCULEN SISTEM
   * degisir: backtest her islemi stop VE hedef ile modelliyor; hedefsiz
   * kalan pozisyon yalnizca stop ya da zaman asimiyla cikar.
   */
  it('stop VE hedef varsa tpEksik false', async () => {
    const c = mockClient({ openAlgoOrders: async () => [stopOrder, tpOrder] }, 5);
    const e = build(c);
    await e.prepare();

    const r = await e.reconcile({ owned: true });

    expect(r.state).toBe('korunuyor');
    expect(r.tpEksik).toBe(false);
  });

  it('stop var hedef YOKSA tpEksik TRUE olur ve pozisyon KAPATILMAZ', async () => {
    const c = mockClient({ openAlgoOrders: async () => [stopOrder] }, 5);
    const e = build(c);
    await e.prepare();
    c.calls.length = 0;

    const r = await e.reconcile({ owned: true });

    expect(r.state).toBe('korunuyor');
    expect(r.tpEksik).toBe(true);
    // Hedef eksikligi kapatma sebebi DEGIL: taker komisyonu odeyip islem
    // tezini bosa dusurmek olurdu.
    expect(c.calls.filter((x: string) => x.startsWith('closeMarket'))).toHaveLength(0);
  });
});

describe('reconcile — pozisyon kapaninca kaldirac tazelenir', () => {
  /**
   * HATA: prepare() yalnizca ACILISTA cagriliyor ve acik pozisyon varken
   * kaldirac ayarina bilerek dokunmuyor (dogru davranis). Ama o pozisyon
   * kapandiktan sonra ayari yapan KIMSE YOKTU: sembol, bot yeniden
   * baslatilana kadar borsadaki ESKI kaldiracla islem acmaya devam ediyordu.
   * "5x ile calisiyorum" diyen bot o sembolde 3x ile giriyor olabilirdi ve
   * checkStopVsLiquidation yanlis likidasyon mesafesiyle karar veriyordu.
   */
  it('borsadaki kaldirac istenenden farkliysa duzeltilir', async () => {
    const c = mockClient({}, 0); // mock her zaman leverage 3 doner
    const e = build(c, 5);
    await e.prepare();
    c.calls.length = 0;

    const r = await e.reconcile({ owned: false });

    expect(r.state).toBe('bos');
    expect(c.calls).toContain('setLeverage:5');
  });

  it('kaldirac zaten dogruysa gereksiz emir gonderilmez', async () => {
    const c = mockClient({}, 0);
    const e = build(c, 3);
    await e.prepare();
    c.calls.length = 0;

    await e.reconcile({ owned: false });

    expect(c.calls.filter((x: string) => x.startsWith('setLeverage'))).toHaveLength(0);
  });
});

describe('execute — GERCEK dolum fiyati borsadan okunur', () => {
  /**
   * HATA: marketEntry newOrderRespType gondermiyordu; Binance USD-M'de
   * varsayilan cevap tipi ACK'tir ve ACK govdesinde avgPrice HER ZAMAN "0"
   * gelir. Kod `entry.avgPrice || mark` ile sessizce MARK fiyatina
   * dusuyordu. Yani kaydedilen "giris fiyati" dolum degil, KARAR ANINDAKI
   * MARK idi; kayma (slippage) gorunmez oluyordu.
   *
   * Kanit kosunun kendi kaydinda: run.log'daki 18 girisin 18'inde de
   * "giris doldu @ X" degeri, ayni islemin plan satirindaki "@ ~mark" ile
   * ondalik ondalik AYNI.
   *
   * Bedeli dogrudan para degil OLCUM: botun tum varlik sebebi olcum yapmak
   * ve DEFAULT_CONFIG'deki slippagePct=0.02 tam da olculemeyen kalem.
   */
  it('avgPrice 0 (ACK) gelse bile entryPrice BORSADAN okunur, mark degil', async () => {
    const c = mockClient({}, 0, 100.05); // mark 100, gercek dolum 100.05
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000, 1000);

    expect(r.action).toBe('girildi');
    expect(r.entryPrice).toBeCloseTo(100.05, 6);
    // Eski hatali davranis tam olarak buydu:
    expect(r.entryPrice).not.toBeCloseTo(100, 6);
  });

  it('gerceklesen risk MARK degil DOLUM fiyatindan hesaplanir', async () => {
    const c = mockClient({}, 0, 100.05);
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig({ stopLoss: 97 }), 1000, 1000);

    // stop 97, dolum 100.05 -> birim risk 3.05 (mark ile olsaydi 3.00)
    expect(r.riskUsdt).toBeCloseTo((r.quantity ?? 0) * 3.05, 6);
  });

  it('borsa okunamazsa mark tahminine duser ama patlamaz', async () => {
    const c = mockClient({}, 0, 100.05);
    const gercek = c.position;
    let n = 0;
    c.position = async () => {
      n++;
      if (n === 1) return gercek(); // prepare()
      throw new Error('ag hatasi');
    };
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000, 1000);

    expect(r.action).toBe('girildi');
    expect(r.entryPrice).toBeCloseTo(100, 6);
  });
});

describe('execute — borsada ACIK kalan pozisyon kaybolmaz', () => {
  /**
   * HATA: execute()'un "pozisyon acildi ama geri kapatilamadi / kapatildigi
   * dogrulanamadi" diyen DORT dali da yalnizca 'hata' donuyordu. run.ts bunu
   * gorunce sadece failedAttempts++ yapiyor, state.positions'a HICBIR kayit
   * yazmiyordu.
   *
   * Sonucu: borsada ACIK (ve muhtemelen KORUMASIZ) bir pozisyon var ama
   * openCount() saymiyor, totalRiskUsdt() toplamiyor, portfoy marj butcesi
   * gormuyor. Tavanlar deliniyor ve o artigin USTUNE yeni pozisyon
   * acilabiliyor; koruma emirleri closePosition ile yazildigi icin yeni stop
   * BIRLESIK pozisyonu kapatir — gerceklesen zarar hedeflenen riskin KATI.
   */
  it('koruma yazilamaz VE geri kapatma dogrulanmazsa positionOpen=evet', async () => {
    const c = mockClient(
      {
        protectiveOrder: async () => {
          throw new Error('Binance -4120: desteklenmiyor');
        },
        // Emir gonderilir ama pozisyon HALA durur -> 'kismi'
        closeMarket: async () => undefined,
      },
      0,
      100.05,
    );
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000, 1000);

    expect(r.action).toBe('hata');
    expect(r.positionOpen).toBe('evet');
    expect(r.openQty).toBeGreaterThan(0);
    expect(r.openEntryPrice).toBeCloseTo(100.05, 6);
    expect(r.openSide).toBe('LONG');
  });

  it('koruma yazilamaz ama geri kapatma DOGRULANIRSA positionOpen bos kalir', async () => {
    const c = mockClient(
      {
        protectiveOrder: async () => {
          throw new Error('Binance -4120: desteklenmiyor');
        },
      },
      0,
      100.05,
    );
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000, 1000);

    expect(r.action).toBe('hata');
    expect(r.positionOpen).toBeUndefined();
  });

  it('giris hata verir, pozisyon acilmis ve kapatilamazsa positionOpen=evet', async () => {
    const c = mockClient(
      {
        marketEntry: async () => {
          throw new Error('zaman asimi');
        },
        closeMarket: async () => undefined,
      },
      5, // borsada pozisyon VAR
      100.05,
    );
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000, 1000);

    expect(r.action).toBe('hata');
    expect(r.positionOpen).toBe('evet');
    expect(r.openQty).toBe(5);
  });

  it('giris hata verir VE pozisyon okunamazsa positionOpen=bilinmiyor', async () => {
    const c = mockClient(
      {
        marketEntry: async () => {
          throw new Error('zaman asimi');
        },
      },
      0,
      100.05,
    );
    const gercek = c.position;
    let n = 0;
    c.position = async () => {
      n++;
      if (n === 1) return gercek(); // prepare()
      throw new Error('okunamadi');
    };
    const e = build(c);
    await e.prepare();

    const r = await e.execute(sig(), 1000, 1000);

    expect(r.action).toBe('hata');
    // "Okuyamadim" ile "pozisyon yok" ayni sey degil: var SAYILIR.
    expect(r.positionOpen).toBe('bilinmiyor');
  });
});
