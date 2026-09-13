import { Bar } from '../data/types';
import {
  BacktestConfig,
  BacktestResult,
  DEFAULT_CONFIG,
  Signal,
  Strategy,
  Trade,
} from './types';

/**
 * Bar-bar backtest motoru.
 *
 * Buradaki her kural, backtest'i kolayca YALANCI yapan bir seyi engellemek
 * icin var. Bir backtest'in isi guzel gorunmek degil, canlida ne olacagini
 * onceden soylemektir; o yuzden her belirsizlikte aleyhte varsayim yapiyoruz.
 *
 * 1. GELECEGE BAKMA YOK. Strateji i. mumun kapanisinda cagriliyor ve
 *    bars[0..i]'yi goruyor. Sinyal o mumun KAPANISINDA olusuyor.
 * 2. GIRIS BIR SONRAKI MUMUN ACILISINDA. Sinyalin olustugu mumun kapanisindan
 *    dolum almak mumkun degil: o fiyati gordugunde mum zaten kapanmistir.
 * 3. AYNI MUMDA HEM STOP HEM HEDEF GORULURSE STOP SAYILIR. Mum icindeki sira
 *    bilinmiyor; iyimser varsaymak backtest'i sistematik olarak sisirir.
 * 4. HER IKI YONDE KOMISYON + KAYMA. Piyasa emri tam fiyattan dolmaz.
 * 5. FONLAMA. 8 saatte bir, pozisyon acikken.
 * 6. TEK POZISYON. Kucuk hesapta gercek olan bu; ayrica ust uste pozisyon
 *    maruziyeti gizlice buyutur.
 */
export function runBacktest(
  strategy: Strategy,
  bars: Bar[],
  symbol: string,
  interval: string,
  cfg: BacktestConfig = DEFAULT_CONFIG,
): BacktestResult {
  const trades: Trade[] = [];
  let balance = cfg.startBalance;
  let peak = balance;
  let maxDrawdownPct = 0;

  const fee = cfg.feePct / 100;
  const slip = cfg.slippagePct / 100;
  const funding8h = cfg.fundingPct / 100;

  let i = Math.max(strategy.warmup, 1);

  while (i < bars.length - 1) {
    const signal = strategy.onBar(bars, i);
    if (!signal) {
      i++;
      continue;
    }

    const outcome = simulateTrade(
      signal,
      bars,
      i,
      balance,
      cfg,
      fee,
      slip,
      funding8h,
    );

    if (!outcome) {
      i++;
      continue;
    }

    balance = outcome.balanceAfter;
    trades.push(outcome);

    peak = Math.max(peak, balance);
    const dd = peak > 0 ? ((peak - balance) / peak) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);

    // Pozisyon kapandiktan SONRAKI mumdan devam; ayni mumda yeni pozisyon
    // acmak gercekte de mumkun degil.
    i = outcome.exitIndex + 1;
  }

  return summarize(strategy.name, symbol, interval, bars, trades, cfg, maxDrawdownPct);
}

interface Outcome extends Trade {
  exitIndex: number;
}

function simulateTrade(
  signal: Signal,
  bars: Bar[],
  signalIndex: number,
  balance: number,
  cfg: BacktestConfig,
  fee: number,
  slip: number,
  funding8h: number,
): Outcome | null {
  const entryBar = bars[signalIndex + 1];
  if (!entryBar) return null;

  const long = signal.side === 'LONG';

  // Kural 2 + 4: bir sonraki mumun acilisi, aleyhte kayma ile.
  const entryPrice = long
    ? entryBar.open * (1 + slip)
    : entryBar.open * (1 - slip);

  /**
   * BOSLUK KAPISI — giris fiyati stopu ya da hedefi ZATEN GECMISSE islem yok.
   *
   * Sinyal i. mumun kapanisinda olusuyor, giris i+1'in acilisinda. Arada
   * bosluk varsa acilis stopun OTESINDE olabilir. Onceki halinde motor bunu
   * yine de acip cikis dongusune giriyordu; dongu ilk mumda "stop gorundu"
   * deyip cikisi signal.stopLoss'tan yaziyordu — ki LONG icin bu, giris
   * fiyatinin USTUNDEDIR. Yani stopu boslukla gecen islem backtest'te KAR
   * olarak defterlere giriyordu.
   *
   * Canli yurutucu bu durumda islemi zaten ATLIYOR (execute() icindeki yon
   * kontrolu: LONG icin stop < mark < hedef). Backtest'in ayni seyi yapmasi
   * sart; yoksa olculen sistem ile calisan sistem farkli olur.
   */
  const ordered = long
    ? signal.stopLoss < entryPrice && entryPrice < signal.takeProfit
    : signal.takeProfit < entryPrice && entryPrice < signal.stopLoss;
  if (!ordered) return null;

  const stopDist = Math.abs(entryPrice - signal.stopLoss);
  if (stopDist <= 0) return null;

  // Boyutlandirma riske gore: stop calisirsa bakiyenin riskPct'si gitsin.
  // Bu, eski botun hic yapmadigi sey — orada boyut margin tavanina bagliydi
  // ve islem basina gercek risk %2 ile %50 arasinda savruluyordu.
  const riskUsdt = balance * (cfg.riskPct / 100);
  const qty = riskUsdt / stopDist;
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const notional = qty * entryPrice;
  const margin = notional / cfg.leverage;
  // Bakiyenin uzerinde pozisyon acilamaz.
  if (margin > balance) return null;

  let exitPrice = 0;
  let exitIndex = -1;
  let exitReason: Trade['exitReason'] = 'timeout';

  const lastIndex = Math.min(
    bars.length - 1,
    signalIndex + 1 + cfg.maxBarsInTrade,
  );

  const kural = cfg.exit ?? { kind: 'sabit' as const };
  const tpDist = Math.abs(signal.takeProfit - entryPrice);

  /** Basabas kurali stopu tasiyabilir; asil stop degismez. */
  let aktifStop = signal.stopLoss;
  let stopTasindi = false;

  /**
   * KAPANMIS mumlardan olculen en iyi lehte gidis (hedef mesafesinin orani).
   *
   * Neden yalnizca kapanmis mumlar: bir mumun hem tetik seviyesine hem
   * cikis seviyesine degdigini gorursek, mum icindeki SIRAYI bilemeyiz.
   * Ayni mumda tetiklenip ayni mumda cikmaya izin vermek, gercekte
   * kanitlayamayacagimiz bir kar uretirdi. Bu yuzden tetiklenme bir mum
   * GECIKMELI islenir — aleyhte varsayim.
   */
  let zirve = 0;
  let tetiklendi = false;

  /**
   * Aleyhte bosluk onurlandirilir, lehte bosluk ONURLANDIRILMAZ.
   *
   * Mum stopun OTESINDE aciliyorsa emir stop fiyatindan degil ACILIStan
   * dolar — gercekte olan budur. Ama hedefi boslukla gecen mumda fazladan
   * kar YAZILMAZ: yolu bilmedigimiz icin lehte olan varsayimi almiyoruz.
   */
  const stopDolumu = (seviye: number, acilis: number) =>
    long ? Math.min(seviye, acilis) : Math.max(seviye, acilis);

  for (let j = signalIndex + 1; j <= lastIndex; j++) {
    const b = bars[j];

    // 1) Stop her zaman ONCE — ayni mumda iki sey gorulduyse aleyhte olan.
    const hitStop = long ? b.low <= aktifStop : b.high >= aktifStop;
    if (hitStop) {
      exitPrice = stopDolumu(aktifStop, b.open);
      exitReason = stopTasindi ? 'basabas' : 'sl';
      exitIndex = j;
      break;
    }

    // 2) Hedef.
    const hitTp = long ? b.high >= signal.takeProfit : b.low <= signal.takeProfit;
    if (hitTp) {
      exitPrice = signal.takeProfit;
      exitReason = 'tp';
      exitIndex = j;
      break;
    }

    // 3) Geri cekilme cikisi — tetiklenme ONCEKI mumlardan geldiyse.
    if (kural.kind === 'geri-cekilme' && tetiklendi) {
      const seviye = long
        ? entryPrice + tpDist * kural.exitAtPct
        : entryPrice - tpDist * kural.exitAtPct;
      const degdi = long ? b.low <= seviye : b.high >= seviye;
      if (degdi) {
        exitPrice = stopDolumu(seviye, b.open);
        exitReason = 'geri-cekilme';
        exitIndex = j;
        break;
      }
    }

    // 4) Bu mumun lehte gidisini kaydet — SONRAKI mumlar icin.
    if (kural.kind !== 'sabit' && tpDist > 0) {
      const lehte = long ? b.high - entryPrice : entryPrice - b.low;
      zirve = Math.max(zirve, lehte / tpDist);
      if (!tetiklendi && zirve >= kural.activateAtPct) {
        tetiklendi = true;
        if (kural.kind === 'basabas') {
          aktifStop = entryPrice;
          stopTasindi = true;
        }
      }
    }
  }

  if (exitIndex === -1) {
    exitIndex = lastIndex;
    exitPrice = bars[lastIndex].close;
    exitReason = 'timeout';
  }

  // Cikista da kayma: stop piyasa emridir, hedef limit olabilir ama
  // ikisine de kayma uygulamak aleyhte ve dolayisiyla guvenli varsayim.
  const exitFill = long ? exitPrice * (1 - slip) : exitPrice * (1 + slip);

  const gross = long
    ? (exitFill - entryPrice) * qty
    : (entryPrice - exitFill) * qty;

  const fees = notional * fee + Math.abs(exitFill * qty) * fee;

  /**
   * Kural 5: fonlama 8 saatte bir — VE HER ZAMAN MALIYET.
   *
   * Onceki hali `* (long ? 1 : -1)` idi: sabit pozitif oranla, her SHORT
   * islem tuttugu sure boyunca GARANTILI GELIR aliyordu. Bu, motorun kendi
   * ilkesinin ("her belirsizlikte aleyhte varsayim") tam tersi ve olcumu
   * short agirlikli stratejiler lehine sistematik olarak sisiriyordu.
   *
   * Gercek fonlama gecmisi indirilip kullanilsa daha DOGRU olurdu (bkz.
   * data/funding.ts); o yapilana kadar dogru varsayim, yonden bagimsiz
   * maliyettir. Fonlama iki yone de donebilir, ve hangi yone donecegini
   * bilmiyoruz.
   */
  const heldMs = bars[exitIndex].closeTime - entryBar.openTime;
  const fundingPeriods = Math.floor(heldMs / (8 * 60 * 60 * 1000));
  const funding = fundingPeriods * notional * Math.abs(funding8h);

  const pnl = gross - fees - funding;
  const balanceAfter = balance + pnl;

  return {
    side: signal.side,
    reason: signal.reason,
    entryTime: entryBar.openTime,
    entryPrice,
    exitTime: bars[exitIndex].closeTime,
    exitPrice: exitFill,
    stopLoss: signal.stopLoss,
    takeProfit: signal.takeProfit,
    exitReason,
    qty,
    margin,
    pnl,
    fees,
    funding,
    r: pnl / riskUsdt,
    balanceAfter,
    barsHeld: exitIndex - signalIndex,
    exitIndex,
  };
}

function summarize(
  strategyName: string,
  symbol: string,
  interval: string,
  bars: Bar[],
  trades: Trade[],
  cfg: BacktestConfig,
  maxDrawdownPct: number,
): BacktestResult {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);

  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const totalR = trades.reduce((s, t) => s + t.r, 0);

  const endBalance = trades.length
    ? trades[trades.length - 1].balanceAfter
    : cfg.startBalance;

  return {
    strategy: strategyName,
    symbol,
    interval,
    from: bars.length ? bars[0].openTime : 0,
    to: bars.length ? bars[bars.length - 1].closeTime : 0,
    bars: bars.length,
    trades,
    startBalance: cfg.startBalance,
    endBalance,
    returnPct: ((endBalance - cfg.startBalance) / cfg.startBalance) * 100,
    wins: wins.length,
    losses: losses.length,
    winRatePct: trades.length ? (wins.length / trades.length) * 100 : 0,
    expectancyR: trades.length ? totalR / trades.length : 0,
    totalR,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownPct,
    totalFees: trades.reduce((s, t) => s + t.fees, 0),
    totalFunding: trades.reduce((s, t) => s + t.funding, 0),
  };
}
