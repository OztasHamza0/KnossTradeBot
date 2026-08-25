/**
 * Mum verisinden turetilen gostergeler.
 *
 * Ayri dosyada ve saf fonksiyonlar: ag cagrisi olmadan test edilebilsinler.
 * Bot bunlar olmadan tek bir sayiya ("24s degisim") bakip karar vermeye
 * calisiyordu ve "hareket etmis" ile "hareket zaten bitmis" arasindaki farki
 * goremiyordu.
 */

/** Binance klines dizisinden ihtiyacimiz olan alanlar. */
export interface Candle {
  high: number;
  low: number;
  close: number;
}

/** Binance'in ham kline dizisini Candle'a cevirir. */
export function toCandles(raw: any[][]): Candle[] {
  return raw
    .map((c) => ({
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close),
    );
}

/**
 * Wilder RSI. 70 uzeri asiri alim, 30 alti asiri satim kabul edilir.
 *
 * Tam da AAVE vakasinin kacirdigi olcu: %15 kosmus bir coinde RSI 75+ olur ve
 * "guclu momentum" ile "asiri gerilmis" ayrimini bu sayi yapar.
 */
export function rsi(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const closes = candles.map((c) => c.close);
  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  // Wilder yumusatmasi
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/**
 * Average True Range — gercek oynaklik.
 *
 * Stop mesafesi buna gore konmali: coin saatte %2.3 oynuyorsa %1'lik stop
 * gurultude supurulur, isabetli tahmin bile zararla kapanir.
 */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const trueRange = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
    sum += trueRange;
  }
  return sum / period;
}

export interface RangePosition {
  low: number;
  high: number;
  /** Fiyatin aralik icindeki yeri: 0 = dip, 100 = tepe. */
  posPct: number;
}

/**
 * Fiyatin verilen penceredeki dip-tepe araliginda nerede durdugu.
 *
 * Ayni coin ayni anda gunluk pencerede %14 (ucuz), 3 aylik pencerede %86
 * (pahali) olabilir — AAVE'de tam olarak bu oldu. Tek pencereye bakmak bu
 * yuzden yaniltici.
 */
export function rangePosition(
  candles: Candle[],
  lastPrice: number,
): RangePosition | null {
  if (candles.length === 0) return null;

  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));

  // Duz bir aralikta bolme tanimsiz; ortada kabul et.
  if (high === low) return { low, high, posPct: 50 };

  const posPct = ((lastPrice - low) / (high - low)) * 100;
  // Fiyat pencerenin disina tasmis olabilir (son mum henuz kapanmadi).
  return { low, high, posPct: Math.max(0, Math.min(100, posPct)) };
}

/**
 * Bir stop mesafesinin oynakliga gore makul olup olmadigi.
 *
 * 1 ATR'den yakin stop gurultude supurulur; 6 ATR'den uzak stop ise
 * "stop koydum" demenin oteye gecmeyen bir sekli olur.
 */
export function judgeStopDistance(
  entry: number,
  stopLoss: number,
  atrValue: number,
): { ok: boolean; atrMultiple: number; reason?: string } {
  if (!Number.isFinite(atrValue) || atrValue <= 0) {
    return { ok: true, atrMultiple: 0 };
  }

  const distance = Math.abs(entry - stopLoss);
  const atrMultiple = distance / atrValue;

  if (atrMultiple < 1) {
    return {
      ok: false,
      atrMultiple,
      reason:
        `Stop girişe çok yakın: ${atrMultiple.toFixed(2)} ATR. ` +
        `Bu parite saatte ortalama ${atrValue.toFixed(4)} oynuyor, ` +
        `stop normal gürültüde süpürülür.`,
    };
  }

  if (atrMultiple > 6) {
    return {
      ok: false,
      atrMultiple,
      reason:
        `Stop aşırı uzak: ${atrMultiple.toFixed(1)} ATR. ` +
        `Bu mesafede stop koruma sağlamaz, sadece zararı büyütür.`,
    };
  }

  return { ok: true, atrMultiple };
}
