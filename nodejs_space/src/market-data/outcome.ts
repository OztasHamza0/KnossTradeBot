import { Candle } from './indicators';

export type SignalStatus = 'open' | 'tp' | 'sl' | 'expired' | 'unknown';

export interface OutcomeVerdict {
  status: SignalStatus;
  /** Sonuc belirlendiginde ilgili fiyat (TP ya da SL seviyesi). */
  price: number | null;
  /** Kac R kazanildi/kaybedildi. TP = +risk_odul, SL = -1. */
  rMultiple: number | null;
  note?: string;
}

/**
 * Bir kartin sonucunu mum verisinden okur.
 *
 * Anlik fiyata bakmak yetmez: fiyat once stopa dokunup sonra hedefe gitmis
 * olabilir ve o durumda islem zararla kapanmistir. Bu yuzden kart
 * gonderildikten sonraki mumlar SIRAYLA gezilir ve hangisine once
 * dokunuldugu tespit edilir.
 *
 * Ayni mumun icinde hem stop hem hedef gorulduyse hangisinin once oldugu
 * mum verisinden bilinemez. O durumda KARAMSAR varsayim yapilir (stop),
 * cunku kendi performansini oldugundan iyi gostermek, yanlis bir stratejiyi
 * surdurmenin en kolay yoludur.
 */
export function judgeOutcome(
  direction: string,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
): OutcomeVerdict {
  const isLong = direction.toUpperCase() === 'LONG';
  const risk = Math.abs(takeProfit - stopLoss);

  for (const candle of candles) {
    const hitStop = isLong ? candle.low <= stopLoss : candle.high >= stopLoss;
    const hitTarget = isLong
      ? candle.high >= takeProfit
      : candle.low <= takeProfit;

    if (hitStop && hitTarget) {
      return {
        status: 'sl',
        price: stopLoss,
        rMultiple: -1,
        note:
          'Aynı mumda hem stop hem hedef görüldü; hangisinin önce olduğu ' +
          'mum verisinden bilinemez. Karamsar varsayım yapıldı (stop).',
      };
    }
    if (hitStop) {
      return { status: 'sl', price: stopLoss, rMultiple: -1 };
    }
    if (hitTarget) {
      // R = odul / risk. Risk mesafesi entry-stop degil, burada
      // TP-SL uzerinden normalize ediliyor; cagiran taraf entry'yi de
      // biliyorsa daha kesin hesaplayabilir.
      return { status: 'tp', price: takeProfit, rMultiple: null };
    }
  }

  return { status: 'open', price: null, rMultiple: null };
}

/**
 * Girise gore R katsayisi.
 * TP'de +odul/risk, SL'de -1.
 */
export function rMultiple(
  entry: number,
  stopLoss: number,
  takeProfit: number,
  status: SignalStatus,
): number | null {
  const risk = Math.abs(entry - stopLoss);
  if (risk === 0) return null;
  if (status === 'sl') return -1;
  if (status === 'tp') return Math.abs(takeProfit - entry) / risk;
  return null;
}

export interface Performance {
  total: number;
  wins: number;
  losses: number;
  open: number;
  expired: number;
  winRatePct: number | null;
  /** Toplam R. Pozitifse strateji R bazinda kazandiriyor. */
  totalR: number;
  avgR: number | null;
}

/**
 * Kapanmis kartlardan performans ozeti.
 *
 * Isabet orani tek basina yaniltici: %70 isabetle de para kaybedilebilir
 * eger kayiplar kazanclardan buyukse. O yuzden R toplami da veriliyor.
 */
export function summarize(
  rows: { status: string; rMultiple: number | null }[],
): Performance {
  const wins = rows.filter((r) => r.status === 'tp').length;
  const losses = rows.filter((r) => r.status === 'sl').length;
  const open = rows.filter((r) => r.status === 'open').length;
  const expired = rows.filter((r) => r.status === 'expired').length;
  const closed = wins + losses;

  const rValues = rows
    .map((r) => r.rMultiple)
    .filter((r): r is number => r !== null && Number.isFinite(r));
  const totalR = rValues.reduce((a, b) => a + b, 0);

  return {
    total: rows.length,
    wins,
    losses,
    open,
    expired,
    winRatePct: closed > 0 ? (wins / closed) * 100 : null,
    totalR,
    avgR: rValues.length > 0 ? totalR / rValues.length : null,
  };
}
