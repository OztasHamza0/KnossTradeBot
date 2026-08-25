/**
 * Kart guvenligi matematigi.
 *
 * Saf fonksiyonlar: her biri tek basina test edilebilsin, ve hicbiri modelin
 * iyi niyetine bagli olmasin.
 *
 * Buradaki kontrollerin ortak temasi su: validateSignal her alani AYRI AYRI
 * denetliyordu (kaldirac 1-10 arasi mi, stop 1 ATR'den uzak mi, margin
 * bakiyenin yarisini asiyor mu) ama BIRLESIMLERINI hic denetlemiyordu.
 * Tek tek gecerli degerler bir araya gelince calismaz bir kart uretebiliyor.
 */

/**
 * Binance izole marjda bakim marji yaklasik %0.5.
 * Likidasyon, fiyat aleyhine ~(100/kaldirac - 0.5)% hareket edince olur.
 */
const MAINTENANCE_MARGIN_PCT = 0.5;

/**
 * Stop, likidasyon mesafesinin en fazla bu kadarinda olabilir.
 * %60'ta biraktim: piyasa stop ile likidasyon arasinda nefes alabilsin,
 * fitil (wick) stopu tetikledikten sonra likidasyona kadar pay kalsin.
 */
const MAX_STOP_OF_LIQUIDATION = 0.6;

export function liquidationDistancePct(leverage: number): number {
  if (!Number.isFinite(leverage) || leverage <= 0) return Infinity;
  return 100 / leverage - MAINTENANCE_MARGIN_PCT;
}

/**
 * Stop likidasyondan once tetiklenir mi.
 *
 * Bu kontrol olmadan 10x + genis stop kombinasyonu "gecerli" sayiliyordu:
 * kaldirac tek basina kurallara uygun, stop mesafesi tek basina oynakliga
 * uygun, ama ikisi birlikte stopun HIC calismadigi bir kart uretiyor.
 * Pozisyon stopa varmadan likide oluyor ve zarar "stop buradaydi" denen
 * yerin cok otesine gecmis oluyor.
 */
export function checkStopVsLiquidation(
  entry: number,
  stopLoss: number,
  leverage: number,
): { ok: boolean; stopPct: number; liqPct: number; maxLeverage: number; reason?: string } {
  const stopPct = (Math.abs(entry - stopLoss) / entry) * 100;
  const liqPct = liquidationDistancePct(leverage);
  const limit = liqPct * MAX_STOP_OF_LIQUIDATION;

  // Bu stop mesafesiyle guvenli kalinabilecek en yuksek kaldirac.
  const maxLeverage = Math.floor(
    100 / (stopPct / MAX_STOP_OF_LIQUIDATION + MAINTENANCE_MARGIN_PCT),
  );

  if (stopPct > limit) {
    return {
      ok: false,
      stopPct,
      liqPct,
      maxLeverage,
      reason:
        `Stop ${stopPct.toFixed(1)}% uzakta ama ${leverage}x kaldıraçta ` +
        `likidasyon ${liqPct.toFixed(1)}%'te. Fiyat stopa varmadan pozisyon ` +
        `likide olur — bu stop koruma sağlamaz. ` +
        `Bu stop mesafesi için kaldıraç en fazla ${Math.max(1, maxLeverage)}x olmalı.`,
    };
  }

  return { ok: true, stopPct, liqPct, maxLeverage };
}

/**
 * Risk/odul orani.
 *
 * Denetci prompt'unda "en az 1:1.5" yaziyordu ama kodda hicbir kontrol
 * yoktu; prompt'un kendi ornek karti bile 1:1.64 idi ve 1:0.67'lik bir kart
 * sorunsuz geciyordu. Kotu oranli isler uzun vadede isabet orani yuksek olsa
 * bile para kaybettirir.
 */
export function checkRiskReward(
  entry: number,
  stopLoss: number,
  takeProfit: number,
  minRatio = 1.5,
): { ok: boolean; ratio: number; reason?: string } {
  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);

  if (risk === 0) {
    return { ok: false, ratio: 0, reason: 'Stop girişle aynı — risk hesaplanamaz.' };
  }

  const ratio = reward / risk;
  if (ratio < minRatio) {
    return {
      ok: false,
      ratio,
      reason:
        `Risk/ödül oranı 1:${ratio.toFixed(2)} — en az 1:${minRatio} olmalı. ` +
        `Bu oranla kazanmak için isabet oranın %${((1 / (1 + ratio)) * 100).toFixed(0)}'in ` +
        `üzerinde olmak zorunda.`,
    };
  }

  return { ok: true, ratio };
}

/**
 * Girisin gercek piyasa fiyatina yakinligi.
 *
 * Iki ayri arizayi ayni anda yakaliyor:
 *
 * 1. Bayat veri. Piyasa verisi 15 dakikaya kadar eski sunulabiliyor; o
 *    fiyattan uretilen bir kart, gercek fiyat kaymissa yanlis yerden giris
 *    onerir. Tek engel prompt'taki bir cumleydi.
 *
 * 2. Carpanli parite hatasi. PEPE'nin birim fiyati $0.00000398, Binance'teki
 *    paritesi 1000PEPEUSDT ve fiyati $0.0039771 — 999 kat fark. Arastirma
 *    modu prompt'a birim fiyati koyup yanina "1000PEPEUSDT olarak islem
 *    goruyor" yaziyordu. Model birim fiyattan kart verirse eski kontrollerin
 *    hicbiri bunu yakalamiyordu.
 */
export function checkEntryNearMarket(
  entry: number,
  marketPrice: number,
  maxDeviationPct = 3,
): { ok: boolean; deviationPct: number; reason?: string } {
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) {
    return { ok: true, deviationPct: 0 };
  }

  const deviationPct = ((entry - marketPrice) / marketPrice) * 100;
  const abs = Math.abs(deviationPct);

  if (abs > maxDeviationPct) {
    // Buyuk kat farklari neredeyse her zaman birim/parite karisikligidir.
    const ratio = marketPrice / entry;
    const looksLikeMultiplier =
      ratio > 100 || ratio < 0.01
        ? ` Giriş fiyatı piyasa fiyatının ${ratio > 1 ? `1/${Math.round(ratio)}` : `${Math.round(1 / ratio)} katı`} kadarı — ` +
          `çarpanlı parite (1000X gibi) fiyatı karışmış olabilir.`
        : '';

    return {
      ok: false,
      deviationPct,
      reason:
        `Giriş ${entry}, güncel piyasa fiyatı ${marketPrice} — ` +
        `%${abs.toFixed(1)} sapma.${looksLikeMultiplier}`,
    };
  }

  return { ok: true, deviationPct };
}

/**
 * Riske gore pozisyon buyuklugu.
 *
 * Eski davranis: margin sadece "bakiyenin yarisini asmasin" diye
 * denetleniyordu, yani islem basina gercek risk stop mesafesine gore %2 ile
 * %50 arasinda savruluyordu. Ayni "kurallara uygun" iki kart, biri bakiyenin
 * %2'sini biri %40'ini riske atabiliyordu.
 *
 * Onerilen margin: bakiyenin belirli bir yuzdesi RISKE atilacak sekilde.
 */
export function suggestedMargin(
  balance: number,
  entry: number,
  stopLoss: number,
  leverage: number,
  riskPct = 2,
): number | null {
  const stopPct = (Math.abs(entry - stopLoss) / entry) * 100;
  if (stopPct <= 0 || !Number.isFinite(leverage) || leverage <= 0) return null;

  // Margin uzerinden zarar orani = stop yuzdesi x kaldirac
  const lossPctOfMargin = stopPct * leverage;
  if (lossPctOfMargin <= 0) return null;

  return (balance * riskPct) / lossPctOfMargin;
}
