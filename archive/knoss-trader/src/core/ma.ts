/**
 * Hareketli ortalamalar.
 *
 * Tek bir deger degil TUM seriyi donduruyorlar: backtest her mumda yeniden
 * hesaplasaydi O(n^2) olurdu ve 100 bin mumluk bir kosu dakikalar surerdi.
 * Seri bir kez hesaplanip strateji indeksle okuyor.
 */

/** Basit hareketli ortalama. index < period-1 icin null. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Ussel hareketli ortalama.
 *
 * Cekirdek ilk `period` degerin basit ortalamasi; sonrasi k katsayisiyla
 * yumusatma. Ilk degeri dogrudan values[0] almak seriyi baslangicta
 * carpitir ve o carpiklik yuzlerce mum tasinir.
 */
export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder ATR serisi.
 *
 * indicators.ts'teki atr() tek bir deger donduruyor ve her mumda cagrilmasi
 * gerekiyordu; bu, ayni sonucu tek gecisde uretir.
 */
export function atrSeries(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < period + 1) return out;

  const tr: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const pc = closes[i - 1];
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - pc),
      Math.abs(lows[i] - pc),
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** N mumluk en yuksek/en dusuk — kirilim stratejileri icin. */
export function rollingExtremes(
  highs: number[],
  lows: number[],
  period: number,
): { highest: (number | null)[]; lowest: (number | null)[] } {
  const highest: (number | null)[] = new Array(highs.length).fill(null);
  const lowest: (number | null)[] = new Array(lows.length).fill(null);

  for (let i = period - 1; i < highs.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    highest[i] = hi;
    lowest[i] = lo;
  }
  return { highest, lowest };
}
