/**
 * Mum verisinden turetilen gostergeler.
 *
 * Ayri dosyada ve saf fonksiyonlar: ag cagrisi olmadan test edilebilsinler.
 * Bot bunlar olmadan tek bir sayiya ("24s degisim") bakip karar vermeye
 * calisiyordu ve "hareket etmis" ile "hareket zaten bitmis" arasindaki farki
 * goremiyordu.
 *
 * ONEMLI: Binance'in dondurdugu son mum HENUZ KAPANMAMISTIR. Gostergeler
 * kapanmis mumlardan hesaplanir; kapanmamis mum yalniz "guncel fiyat" olarak
 * kullanilir. Aksi halde daha olusmakta olan bir mum, sert bir kabul/red
 * esigini besleyen sayilari oynatir.
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

/** Son (kapanmamis) mumu dusurur. Gosterge hesaplari bunu kullanir. */
export function closedOnly(candles: Candle[]): Candle[] {
  return candles.length > 1 ? candles.slice(0, -1) : candles;
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
 * Wilder ATR — gercek oynaklik.
 *
 * Duz ortalama degil Wilder yumusatmasi kullanir: tek bir uc mum sayiyi
 * 14 mum boyunca esit agirlikta tasiyip sonra aniden birakmaz. Bu deger
 * sert bir kabul/red esigini besliyor (stop 1 ATR'den yakin olamaz),
 * o yuzden sicramamasi onemli.
 *
 * Stop mesafesi buna gore konmali: coin saatte %2.3 oynuyorsa %1'lik stop
 * gurultude supurulur, isabetli tahmin bile zararla kapanir.
 */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    trueRanges.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prevClose),
        Math.abs(candles[i].low - prevClose),
      ),
    );
  }

  if (trueRanges.length < period) return null;

  // Ilk deger basit ortalama, sonrasi Wilder yumusatmasi.
  let value = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    value = (value * (period - 1) + trueRanges[i]) / period;
  }
  return value;
}

export interface RangePosition {
  low: number;
  high: number;
  /**
   * Fiyatin aralik icindeki yeri: 0 = dip, 100 = tepe.
   * 100'un ustu = yerlesik araligin USTUNE kirilim,
   * 0'in alti = araligin ALTINA kirilim.
   */
  posPct: number;
  /** Fiyat yerlesik araligin disina ciktiysa hangi yone. */
  breakout: 'above' | 'below' | null;
}

/**
 * Fiyatin, KENDISI HARIC olusmus aralikta nerede durdugu.
 *
 * Onceki hali kendi kendine referansliydi: guncel fiyat, icinde
 * konumlandirildigi pencerenin high/low'una kendisi katki yapiyordu. Sonuc:
 * her yeni zirve otomatik olarak %100 ve "TEPEYE YAPISIK" cikiyordu — yani
 * yerlesik bir tavana dayanmak ile o tavani kirmak ayni sinyali veriyordu.
 * Oysa bunlar zit anlamlar tasir: biri direnc, digeri kirilim.
 *
 * Simdi aralik gecmis mumlardan kuruluyor ve guncel fiyat onun icine
 * yerlestiriliyor; disari tasarsa kirpilmiyor, kirilim olarak bildiriliyor.
 */
export function rangePosition(
  candles: Candle[],
  lastPrice: number,
): RangePosition | null {
  // Aralik, guncel fiyatin ait oldugu mum HARIC olusan mumlardan kurulur.
  const history = closedOnly(candles);
  if (history.length === 0) return null;

  const high = Math.max(...history.map((c) => c.high));
  const low = Math.min(...history.map((c) => c.low));

  if (high === low) {
    return { low, high, posPct: 50, breakout: null };
  }

  const posPct = ((lastPrice - low) / (high - low)) * 100;
  const breakout = posPct > 100 ? 'above' : posPct < 0 ? 'below' : null;

  return { low, high, posPct, breakout };
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
