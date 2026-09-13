/**
 * Koruma emri tanima — TEK KAYNAK.
 *
 * NEDEN AYRI DOSYA: "bu pozisyon korunuyor mu" sorusu iki yerde AYRI AYRI
 * yazilmisti — executor.ts icinde hasMatchingStop() ve check.ts icinde nobet
 * suzgeci — ve ayrismislardi:
 *
 *   executor.ts  : yalnizca STOP ariyordu, hedefin kaybolmasi fark edilmiyordu
 *   check.ts     : hem stop hem hedef ariyordu, ama hedefte YON ve TARAF
 *                  kontrolu yoktu (ters yondeki bir hedef emri de sayiliyordu)
 *
 * Yani bot "korunuyor" derken nobet araci "KORUMASIZ" diyebiliyordu, ya da
 * tersi. Ayni soruyu iki farkli cevapla yanitlayan bir sistemde hangisinin
 * dogru oldugunu kimse bilemez. Iki cagri yeri de artik buradan okuyor.
 */

/** Ucus oncesi kontrol emirleri 'pf-' onekli; koruma sayilmazlar. */
export function isProbeOrder(o: any): boolean {
  return String(o?.clientAlgoId ?? '').startsWith('pf-');
}

function triggerOf(o: any): number {
  return parseFloat(o?.triggerPrice ?? o?.stopPrice ?? 'NaN');
}

/**
 * Bu emir GERCEKTEN bu pozisyonu koruyor mu?
 *
 * Dort sart: dogru emir tipi, dogru YON, tetik pozisyonun DOGRU TARAFINDA,
 * ve kontrol emri olmamali. "Tipi STOP_MARKET olan bir emir var" yetmez:
 * iptal edilememis bir kontrol emri ya da onceki kosudan kalmis alakasiz
 * bir emir pozisyonu korunuyor gosterirdi.
 */
function matches(
  o: any,
  tip: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
  long: boolean,
  entryPrice: number,
): boolean {
  if ((o?.orderType ?? o?.type) !== tip) return false;
  if (isProbeOrder(o)) return false;
  // LONG'u SELL emri kapatir, SHORT'u BUY.
  if (o?.side !== (long ? 'SELL' : 'BUY')) return false;
  const trigger = triggerOf(o);
  if (!Number.isFinite(trigger) || !(entryPrice > 0)) return false;
  // STOP: LONG'un stopu girisin ALTINDA, SHORT'unki USTUNDE.
  // HEDEF: tam tersi — LONG'un hedefi USTUNDE, SHORT'unki ALTINDA.
  const altinda = trigger < entryPrice;
  return tip === 'STOP_MARKET' ? altinda === long : altinda !== long;
}

export interface KorumaDurumu {
  /** Pozisyonu gercekten koruyan stop emirleri. */
  stops: any[];
  /** Pozisyonun hedefi olan kar-al emirleri. */
  tps: any[];
  /** Stop var mi — YOKSA pozisyon korumasizdir. */
  stopVar: boolean;
  /** Hedef var mi — yoksa pozisyon korunur ama backtest'ten AYRISIR. */
  tpVar: boolean;
  /** Stop tetigi (yoksa NaN) — borsadan olculen risk bunun uzerinden. */
  stopTrigger: number;
}

export function korumaDurumu(
  algo: any[],
  positionAmt: number,
  entryPrice: number,
): KorumaDurumu {
  const long = positionAmt > 0;
  const liste = Array.isArray(algo) ? algo : [];
  const stops = liste.filter((o) => matches(o, 'STOP_MARKET', long, entryPrice));
  const tps = liste.filter((o) => matches(o, 'TAKE_PROFIT_MARKET', long, entryPrice));
  return {
    stops,
    tps,
    stopVar: stops.length > 0,
    tpVar: tps.length > 0,
    stopTrigger: stops.length > 0 ? triggerOf(stops[0]) : NaN,
  };
}
