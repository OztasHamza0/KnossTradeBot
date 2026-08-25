import {
  toCandles,
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
  const candles = [c(200, 100, 150), c(180, 120, 160)];

  it('reports the top of the range', () => {
    expect(rangePosition(candles, 200)!.posPct).toBe(100);
  });

  it('reports the bottom of the range', () => {
    expect(rangePosition(candles, 100)!.posPct).toBe(0);
  });

  it('reports the middle of the range', () => {
    expect(rangePosition(candles, 150)!.posPct).toBe(50);
  });

  // Son mum henuz kapanmadigi icin fiyat pencerenin disina tasabilir.
  it('clamps a price outside the window', () => {
    expect(rangePosition(candles, 250)!.posPct).toBe(100);
    expect(rangePosition(candles, 50)!.posPct).toBe(0);
  });

  it('treats a flat range as the middle rather than dividing by zero', () => {
    const flat = [c(100, 100, 100)];
    expect(rangePosition(flat, 100)!.posPct).toBe(50);
  });

  it('returns null with no candles', () => {
    expect(rangePosition([], 100)).toBeNull();
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
