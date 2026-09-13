import {
  liquidationDistancePct,
  checkStopVsLiquidation,
  checkRiskReward,
  checkEntryNearMarket,
  suggestedMargin,
  checkRiskPerTrade,
} from './risk';

describe('liquidationDistancePct', () => {
  it.each([
    [1, 99.5],
    [3, 32.83],
    [10, 9.5],
  ])('at %ix liquidation sits ~%f%% away', (lev, expected) => {
    expect(liquidationDistancePct(lev)).toBeCloseTo(expected, 1);
  });

  it('treats nonsense leverage as unreachable rather than dividing by zero', () => {
    expect(liquidationDistancePct(0)).toBe(Infinity);
    expect(liquidationDistancePct(NaN)).toBe(Infinity);
  });
});

describe('checkStopVsLiquidation', () => {
  // Denetimde bulunan asil tehlike: kaldirac ve stop mesafesi tek tek
  // gecerliyken birlikte calismaz bir kart uretiyorlardi.
  it('rejects a stop that sits beyond liquidation', () => {
    // 10x -> likidasyon %9.5. %20 uzaktaki stop asla tetiklenmez.
    const v = checkStopVsLiquidation(100, 80, 10);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('likide olur');
  });

  it('rejects a stop inside liquidation but too close to it', () => {
    // %8 stop, %9.5 likidasyon: aralarinda fitil payi yok.
    const v = checkStopVsLiquidation(100, 92, 10);
    expect(v.ok).toBe(false);
  });

  it('accepts a stop comfortably inside liquidation', () => {
    // %4 stop, %9.5 likidasyon
    expect(checkStopVsLiquidation(100, 96, 10).ok).toBe(true);
  });

  it('lets a wide stop pass at low leverage', () => {
    // 2x -> likidasyon %49.5; %20 stop sorun degil
    expect(checkStopVsLiquidation(100, 80, 2).ok).toBe(true);
  });

  it('names the highest leverage that stop distance allows', () => {
    const v = checkStopVsLiquidation(100, 80, 10);
    // %20 stop icin guvenli kaldirac ~2x
    expect(v.maxLeverage).toBeLessThanOrEqual(3);
    expect(v.maxLeverage).toBeGreaterThanOrEqual(2);
    expect(v.reason).toContain('en fazla');
  });

  it('works for a short, where the stop sits above entry', () => {
    expect(checkStopVsLiquidation(100, 120, 10).ok).toBe(false);
    expect(checkStopVsLiquidation(100, 104, 10).ok).toBe(true);
  });
});

describe('checkRiskReward', () => {
  it('rejects a card that risks more than it targets', () => {
    // risk 3, odul 2 -> 1:0.67
    const v = checkRiskReward(100, 97, 102);
    expect(v.ok).toBe(false);
    expect(v.ratio).toBeCloseTo(0.67, 2);
  });

  it('rejects a ratio just under the floor', () => {
    expect(checkRiskReward(100, 98, 102.8).ok).toBe(false); // 1:1.4
  });

  it('accepts a ratio at the floor', () => {
    expect(checkRiskReward(100, 98, 103).ok).toBe(true); // 1:1.5
  });

  it('accepts a generous ratio', () => {
    const v = checkRiskReward(100, 98, 106);
    expect(v.ok).toBe(true);
    expect(v.ratio).toBeCloseTo(3);
  });

  it('states the hit rate the ratio demands', () => {
    const v = checkRiskReward(100, 97, 102);
    expect(v.reason).toContain('isabet oranın');
  });

  it('refuses a stop placed at the entry', () => {
    expect(checkRiskReward(100, 100, 110).ok).toBe(false);
  });

  it('works for a short', () => {
    expect(checkRiskReward(100, 102, 94).ok).toBe(true); // risk 2, odul 6
  });
});

describe('checkEntryNearMarket', () => {
  it('accepts an entry at the market price', () => {
    expect(checkEntryNearMarket(100, 100).ok).toBe(true);
  });

  it('accepts a small deviation', () => {
    expect(checkEntryNearMarket(102, 100).ok).toBe(true);
  });

  it('rejects a stale entry', () => {
    const v = checkEntryNearMarket(110, 100);
    expect(v.ok).toBe(false);
    expect(v.deviationPct).toBeCloseTo(10);
  });

  // Arastirma modu CoinGecko'nun birim fiyatini prompt'a koyuyordu; Binance
  // paritesi 1000PEPEUSDT ve fiyati 1000 kat farkli.
  it('catches the multiplied-pair mixup and says so', () => {
    const v = checkEntryNearMarket(0.00000398, 0.0039771);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('çarpanlı parite');
  });

  it('catches the mixup in the other direction too', () => {
    const v = checkEntryNearMarket(0.0039771, 0.00000398);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('çarpanlı parite');
  });

  it('stays out of the way when the market price is unknown', () => {
    expect(checkEntryNearMarket(100, 0).ok).toBe(true);
    expect(checkEntryNearMarket(100, NaN).ok).toBe(true);
  });
});

describe('suggestedMargin', () => {
  // Eski davranis: margin sadece bakiyenin yarisini asmasin diye
  // denetleniyordu, gercek risk %2 ile %50 arasinda savruluyordu.
  it('sizes the position so the loss is the intended slice of balance', () => {
    // 100 USDT bakiye, %2 risk, %4 stop, 3x -> margin*3*4% = 2 USDT
    const m = suggestedMargin(100, 100, 96, 3, 2);
    expect(m).toBeCloseTo(16.67, 1);
    // Dogrulama: bu marginle stop'ta kaybedilen tam olarak 2 USDT
    expect(m! * 3 * 0.04).toBeCloseTo(2, 5);
  });

  it('shrinks the position when the stop is wider', () => {
    const tight = suggestedMargin(100, 100, 98, 3, 2)!;
    const wide = suggestedMargin(100, 100, 90, 3, 2)!;
    expect(wide).toBeLessThan(tight);
  });

  it('shrinks the position when leverage rises', () => {
    const low = suggestedMargin(100, 100, 96, 2, 2)!;
    const high = suggestedMargin(100, 100, 96, 10, 2)!;
    expect(high).toBeLessThan(low);
  });

  it('returns null when the numbers make no sense', () => {
    expect(suggestedMargin(100, 100, 100, 3, 2)).toBeNull();
    expect(suggestedMargin(100, 100, 96, 0, 2)).toBeNull();
  });
});

describe('checkRiskPerTrade', () => {
  it('kurallara uyan ama bakiyenin %75ini riske atan karti reddeder', () => {
    // margin 50 (bakiye 100 -> tavana esit), 10x, stop %15 uzakta.
    // Eski kontrollerin hepsinden geciyordu.
    const r = checkRiskPerTrade(100, 50, 100, 85, 10, 10);
    expect(r.ok).toBe(false);
    expect(Math.round(r.riskPct)).toBe(50); // margin'in tamamiyla sinirli
    expect(r.reason).toContain('kaybettirir');
  });

  it('makul boyutlandirmayi gecirir', () => {
    // margin 20, 5x, stop %3 -> 3 USDT = bakiyenin %3'u
    const r = checkRiskPerTrade(100, 20, 100, 97, 5, 10);
    expect(r.ok).toBe(true);
    expect(r.riskUsdt).toBeCloseTo(3, 5);
    expect(r.riskPct).toBeCloseTo(3, 5);
  });

  it('kaybi margin ile sinirlar — izole marjda daha fazlasi kaybedilemez', () => {
    const r = checkRiskPerTrade(1000, 10, 100, 50, 10, 100);
    // 10 x 10 x 0.5 = 50 olurdu ama izole marjda tavan 10 USDT.
    expect(r.riskUsdt).toBe(10);
  });

  it('tavani tam tutturan kart gecer', () => {
    // 10 USDT risk = bakiyenin tam %10'u
    const r = checkRiskPerTrade(100, 20, 100, 95, 10, 10);
    expect(r.riskUsdt).toBeCloseTo(10, 5);
    expect(r.ok).toBe(true);
  });

  it('olculemeyen girdide yoldan cekilir', () => {
    expect(checkRiskPerTrade(0, 20, 100, 97, 5, 10).ok).toBe(true);
    expect(checkRiskPerTrade(100, 0, 100, 97, 5, 10).ok).toBe(true);
    expect(checkRiskPerTrade(100, 20, 100, 100, 5, 10).ok).toBe(true);
  });
});
