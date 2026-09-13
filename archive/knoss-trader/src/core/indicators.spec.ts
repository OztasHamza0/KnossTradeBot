import {
  toCandles,
  closedOnly,
  rsi,
  atr,
  rangePosition,
  judgeStopDistance,
  Candle,
} from './indicators';

const c = (high: number, low: number, close: number): Candle => ({
  high,
  low,
  close,
});

/** Sabit adimla artan/azalan kapanislar — RSI'nin uc degerlerini zorlar. */
const trend = (start: number, step: number, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const close = start + step * i;
    return c(close + 1, close - 1, close);
  });

describe('toCandles', () => {
  it('maps Binance kline rows to candles', () => {
    const raw = [
      [0, '100', '110', '90', '105', '1'],
      [0, '105', '115', '95', '108', '1'],
    ];
    expect(toCandles(raw)).toEqual([
      { high: 110, low: 90, close: 105 },
      { high: 115, low: 95, close: 108 },
    ]);
  });

  it('drops rows with unparseable numbers', () => {
    const raw = [
      [0, '100', 'yok', '90', '105', '1'],
      [0, '105', '115', '95', '108', '1'],
    ];
    expect(toCandles(raw)).toHaveLength(1);
  });
});

describe('rsi', () => {
  it('returns null without enough candles', () => {
    expect(rsi(trend(100, 1, 5))).toBeNull();
  });

  it('reads near 100 when every candle rises', () => {
    const r = rsi(trend(100, 2, 40));
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(95);
  });

  it('reads near 0 when every candle falls', () => {
    const r = rsi(trend(200, -2, 40));
    expect(r!).toBeLessThan(5);
  });

  it('sits mid-range on a flat series', () => {
    const r = rsi(Array.from({ length: 40 }, () => c(101, 99, 100)));
    expect(r!).toBeGreaterThan(40);
    expect(r!).toBeLessThan(60);
  });
});

describe('atr', () => {
  it('returns null without enough candles', () => {
    expect(atr([c(10, 9, 9.5)])).toBeNull();
  });

  it('measures the average true range', () => {
    // Her mumun yuksek-dusuk farki tam 10
    const candles = Array.from({ length: 20 }, () => c(105, 95, 100));
    expect(atr(candles)).toBeCloseTo(10, 5);
  });

  it('counts gaps between candles, not just the bar height', () => {
    const candles: Candle[] = [
      ...Array.from({ length: 15 }, () => c(101, 99, 100)),
      c(130, 128, 129), // yukari boslukla acilis
    ];
    // Bosluk sayilmasaydi ~2 cikardi
    expect(atr(candles)!).toBeGreaterThan(2);
  });
});

describe('rangePosition', () => {
  // Son mum kapanmamis sayilir ve araliga KATILMAZ; aralik ondan onceki
  // mumlardan kurulur. Asagida son eleman her zaman "guncel mum".
  const candles = [c(200, 100, 150), c(180, 120, 160), c(0, 0, 0)];

  it('reports the top of the established range', () => {
    expect(rangePosition(candles, 200)!.posPct).toBe(100);
  });

  it('reports the bottom of the established range', () => {
    expect(rangePosition(candles, 100)!.posPct).toBe(0);
  });

  it('reports the middle of the range', () => {
    expect(rangePosition(candles, 150)!.posPct).toBe(50);
  });

  // Eski hali kendi kendine referansliydi: guncel fiyat kendi penceresinin
  // high/low'una katki yapiyor, her yeni zirve otomatik %100 ve "tepeye
  // yapisik" cikiyordu. Yerlesik bir tavana dayanmak ile onu kirmak zit
  // anlamlar tasir.
  it('reports a break above the range instead of clamping to 100', () => {
    const r = rangePosition(candles, 250)!;
    expect(r.posPct).toBeGreaterThan(100);
    expect(r.breakout).toBe('above');
  });

  it('reports a break below the range', () => {
    const r = rangePosition(candles, 50)!;
    expect(r.posPct).toBeLessThan(0);
    expect(r.breakout).toBe('below');
  });

  it('reports no breakout while price is inside the range', () => {
    expect(rangePosition(candles, 150)!.breakout).toBeNull();
    expect(rangePosition(candles, 200)!.breakout).toBeNull();
  });

  it('does not let the current candle widen its own range', () => {
    // Guncel mum 500'e ciksa bile aralik gecmisten kurulur.
    const withSpike = [c(200, 100, 150), c(180, 120, 160), c(500, 90, 480)];
    const r = rangePosition(withSpike, 480)!;
    expect(r.high).toBe(200);
    expect(r.breakout).toBe('above');
  });

  it('treats a flat range as the middle rather than dividing by zero', () => {
    const flat = [c(100, 100, 100)];
    expect(rangePosition(flat, 100)!.posPct).toBe(50);
  });

  it('returns null with no candles', () => {
    expect(rangePosition([], 100)).toBeNull();
  });
});

describe('closedOnly', () => {
  it('drops the still-forming candle', () => {
    const cs = [c(1, 1, 1), c(2, 2, 2), c(3, 3, 3)];
    expect(closedOnly(cs)).toHaveLength(2);
    expect(closedOnly(cs)[1].close).toBe(2);
  });

  it('keeps a single candle rather than returning nothing', () => {
    expect(closedOnly([c(1, 1, 1)])).toHaveLength(1);
  });
});

describe('atr Wilder yumusatmasi', () => {
  // Duz ortalamada tek bir uc mum 14 mum boyunca esit agirlikta tasinir ve
  // sonra aniden birakilir; bu deger sert bir kabul/red esigini besliyor.
  it('does not let one spike dominate for exactly 14 bars then vanish', () => {
    const calm = Array.from({ length: 40 }, () => c(101, 99, 100));
    const withSpike = [...calm];
    withSpike[20] = c(140, 60, 100);

    const a = atr(withSpike)!;
    const base = atr(calm)!;
    // Sicrama etkisi hala hissediliyor ama sonsuza kadar degil
    expect(a).toBeGreaterThan(base);
    expect(a).toBeLessThan(base * 3);
  });
});

describe('judgeStopDistance', () => {
  // AAVE saatte ~%2 oynuyordu; oradaki %1'lik bir stop gurultude supurulurdu.
  it('rejects a stop inside one ATR', () => {
    const v = judgeStopDistance(100, 99, 2);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('çok yakın');
  });

  it('accepts a stop at a sane multiple', () => {
    expect(judgeStopDistance(100, 96, 2).ok).toBe(true);
  });

  it('rejects an absurdly wide stop', () => {
    const v = judgeStopDistance(100, 80, 2);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('aşırı uzak');
  });

  it('reports the multiple it measured', () => {
    expect(judgeStopDistance(100, 94, 2).atrMultiple).toBeCloseTo(3);
  });

  it('works the same for a short, where the stop sits above entry', () => {
    expect(judgeStopDistance(100, 104, 2).ok).toBe(true);
    expect(judgeStopDistance(100, 100.5, 2).ok).toBe(false);
  });

  // Analiz alinamadiginda kart bu yuzden elenmemeli.
  it('stays out of the way when ATR is unknown', () => {
    expect(judgeStopDistance(100, 99.9, 0).ok).toBe(true);
    expect(judgeStopDistance(100, 99.9, NaN).ok).toBe(true);
  });
});

describe('judgeStopDistance — alt sinir prompt ile ayni (1.5 ATR)', () => {
  // Kod 1.0, prompt 1.5 diyordu. Aradaki boslugu gecen kartlar denetci
  // modele "bu oynaklikta supurulur" diye elettiriliyordu: olculen ornek
  // ZRO, ATR %4.41/saat, stop %4.5 = 1.02 ATR.
  it('1.02 ATR artik kodda eleniyor (eskiden geciyordu)', () => {
    const v = judgeStopDistance(100, 95.9, 4);
    expect(v.ok).toBe(false);
    expect(v.atrMultiple).toBeCloseTo(1.025, 2);
    expect(v.reason).toContain('1.5');
  });

  it('tam 1.5 ATR gecer', () => {
    expect(judgeStopDistance(100, 94, 4).ok).toBe(true);
  });

  it('1.49 ATR gecmez', () => {
    expect(judgeStopDistance(100, 94.04, 4).ok).toBe(false);
  });

  it('ust sinir 6 ATR degismedi', () => {
    expect(judgeStopDistance(100, 76, 4).ok).toBe(true);
    expect(judgeStopDistance(100, 74, 4).ok).toBe(false);
  });
});
