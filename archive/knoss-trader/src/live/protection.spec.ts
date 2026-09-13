import { korumaDurumu, isProbeOrder } from './protection';

/**
 * Bu testler iki GERCEK ayrisma hatasini kapatiyor:
 *
 *  1. executor.ts'teki hasMatchingStop() yalnizca STOP ariyordu. Hedef emri
 *     kaybolmus bir pozisyon "korunuyor" sayiliyor, backtest'in olctugu
 *     stop+hedef geometrisi canlida sessizce tek bacakli hale geliyordu.
 *
 *  2. check.ts'teki nobet suzgeci hedefi YALNIZCA tipine bakarak sayiyordu:
 *     yon ve tetigin hangi tarafta oldugu denetlenmiyordu. Ters yondeki ya da
 *     girisin yanlis tarafindaki bir emir "hedef var" gosteriyordu.
 */

const stop = (over: any = {}) => ({
  orderType: 'STOP_MARKET',
  side: 'SELL',
  triggerPrice: '97',
  clientAlgoId: 's-1',
  ...over,
});
const tp = (over: any = {}) => ({
  orderType: 'TAKE_PROFIT_MARKET',
  side: 'SELL',
  triggerPrice: '106',
  clientAlgoId: 't-1',
  ...over,
});

describe('korumaDurumu — LONG', () => {
  const ENTRY = 100;

  it('dogru stop + dogru hedef: ikisi de sayilir', () => {
    const d = korumaDurumu([stop(), tp()], +1, ENTRY);
    expect(d.stopVar).toBe(true);
    expect(d.tpVar).toBe(true);
    expect(d.stopTrigger).toBe(97);
  });

  it('HEDEF KAYBOLMUSSA stop var ama tpVar false — executor bunu goremiyordu', () => {
    const d = korumaDurumu([stop()], +1, ENTRY);
    expect(d.stopVar).toBe(true);
    expect(d.tpVar).toBe(false);
  });

  it('hedef TERS YONDE (BUY) ise hedef sayilmaz — check.ts bunu sayiyordu', () => {
    const d = korumaDurumu([stop(), tp({ side: 'BUY' })], +1, ENTRY);
    expect(d.tpVar).toBe(false);
  });

  it('hedef girisin ALTINDA ise hedef sayilmaz — check.ts bunu sayiyordu', () => {
    // LONG'un hedefi girisin USTUNDE olmali. Altindaki bir TAKE_PROFIT emri
    // hedef degildir; ilk anda tetiklenip islemi zararla kapatir.
    const d = korumaDurumu([stop(), tp({ triggerPrice: '94' })], +1, ENTRY);
    expect(d.tpVar).toBe(false);
  });

  it('ucus oncesi kontrol emri (pf-) ne stop ne hedef sayilir', () => {
    const d = korumaDurumu(
      [stop({ clientAlgoId: 'pf-9' }), tp({ clientAlgoId: 'pf-9' })],
      +1,
      ENTRY,
    );
    expect(d.stopVar).toBe(false);
    expect(d.tpVar).toBe(false);
  });

  it('stop girisin USTUNDE ise koruma sayilmaz', () => {
    const d = korumaDurumu([stop({ triggerPrice: '103' })], +1, ENTRY);
    expect(d.stopVar).toBe(false);
  });
});

describe('korumaDurumu — SHORT', () => {
  const ENTRY = 100;
  const sStop = stop({ side: 'BUY', triggerPrice: '103' });
  const sTp = tp({ side: 'BUY', triggerPrice: '94' });

  it('SHORT: stop USTUNDE, hedef ALTINDA olmali', () => {
    const d = korumaDurumu([sStop, sTp], -1, ENTRY);
    expect(d.stopVar).toBe(true);
    expect(d.tpVar).toBe(true);
    expect(d.stopTrigger).toBe(103);
  });

  it('SHORT hedefi girisin USTUNDE ise sayilmaz', () => {
    const d = korumaDurumu([sStop, tp({ side: 'BUY', triggerPrice: '106' })], -1, ENTRY);
    expect(d.tpVar).toBe(false);
  });
});

describe('korumaDurumu — bozuk girdi', () => {
  it('tetik ayrisamiyorsa koruma SAYILMAZ', () => {
    const d = korumaDurumu([stop({ triggerPrice: 'abc', stopPrice: undefined })], +1, 100);
    expect(d.stopVar).toBe(false);
  });

  it('entryPrice 0 ise hicbir sey koruma sayilmaz — taraf kararlastirilamaz', () => {
    const d = korumaDurumu([stop(), tp()], +1, 0);
    expect(d.stopVar).toBe(false);
    expect(d.tpVar).toBe(false);
  });

  it('algo listesi dizi degilse patlamaz', () => {
    const d = korumaDurumu(null as any, +1, 100);
    expect(d.stopVar).toBe(false);
    expect(d.tpVar).toBe(false);
  });

  it('stopPrice alani triggerPrice yerine gelirse de okunur', () => {
    const d = korumaDurumu(
      [{ type: 'STOP_MARKET', side: 'SELL', stopPrice: '97', clientAlgoId: 's-2' }],
      +1,
      100,
    );
    expect(d.stopVar).toBe(true);
    expect(d.stopTrigger).toBe(97);
  });

  it('isProbeOrder yalnizca pf- onekini yakalar', () => {
    expect(isProbeOrder({ clientAlgoId: 'pf-1' })).toBe(true);
    expect(isProbeOrder({ clientAlgoId: 's-1' })).toBe(false);
    expect(isProbeOrder({})).toBe(false);
  });
});
