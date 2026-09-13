import { getBars } from '../data/binance';
import { runBacktest } from '../backtest/engine';
import { BacktestResult, DEFAULT_CONFIG } from '../backtest/types';
import { emaPullback } from '../strategies/ema-pullback';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { randomBaseline } from '../strategies/random-baseline';
import { Strategy } from '../backtest/types';

/**
 * Backtest kosucusu.
 *
 * Kullanim:
 *   npm run backtest -- BTCUSDT 1h 365
 *   npm run backtest -- ETHUSDT 15m 180
 */

const [, , symbolArg, intervalArg, daysArg] = process.argv;
const symbol = (symbolArg ?? 'BTCUSDT').toUpperCase();
const interval = intervalArg ?? '1h';
const days = parseInt(daysArg ?? '365', 10);

const strategies: Strategy[] = [
  emaPullback(),
  emaPullback({
    fast: 21,
    slow: 55,
    pull: 9,
    atrPeriod: 14,
    stopAtr: 1.5,
    rr: 2,
  }),
  donchianBreakout(),
  donchianBreakout({
    lookback: 20,
    atrPeriod: 14,
    stopAtr: 1.5,
    rr: 2,
    trendEma: 200,
  }),
  randomBaseline(),
];

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '∞';
  return n.toFixed(digits);
}

function line(r: BacktestResult): string {
  return (
    r.strategy.padEnd(52).slice(0, 52) +
    String(r.trades.length).padStart(6) +
    (fmt(r.winRatePct, 1) + '%').padStart(9) +
    fmt(r.expectancyR, 3).padStart(10) +
    fmt(r.totalR, 1).padStart(9) +
    (fmt(r.returnPct, 1) + '%').padStart(10) +
    (fmt(r.maxDrawdownPct, 1) + '%').padStart(9) +
    fmt(r.profitFactor, 2).padStart(8)
  );
}

async function main() {
  console.log(`\n${symbol} ${interval}, son ${days} gun\n`);
  process.stdout.write('Veri hazirlaniyor... ');

  const bars = await getBars(symbol, interval, days, (n) => {
    process.stdout.write(`\rVeri hazirlaniyor... ${n} mum`);
  });

  if (bars.length === 0) {
    console.error('\nVeri alinamadi.');
    process.exit(1);
  }

  const from = new Date(bars[0].openTime).toISOString().slice(0, 10);
  const to = new Date(bars[bars.length - 1].closeTime)
    .toISOString()
    .slice(0, 10);
  console.log(`\r${bars.length} mum hazir (${from} → ${to})\n`);

  console.log(
    'Ayarlar: bakiye ' +
      DEFAULT_CONFIG.startBalance +
      ' USDT, islem basi risk %' +
      DEFAULT_CONFIG.riskPct +
      ', kaldirac ' +
      DEFAULT_CONFIG.leverage +
      'x, komisyon %' +
      DEFAULT_CONFIG.feePct +
      '/yon, kayma %' +
      DEFAULT_CONFIG.slippagePct +
      '\n',
  );

  console.log(
    'STRATEJI'.padEnd(52) +
      'ISLEM'.padStart(6) +
      'ISABET'.padStart(9) +
      'BEKLENTI'.padStart(10) +
      'TOPLAM R'.padStart(9) +
      'GETIRI'.padStart(10) +
      'MAX DD'.padStart(9) +
      'PF'.padStart(8),
  );
  console.log('-'.repeat(103));

  const results: BacktestResult[] = [];
  for (const s of strategies) {
    const r = runBacktest(s, bars, symbol, interval);
    results.push(r);
    console.log(line(r));
  }

  console.log('-'.repeat(103));

  const baseline = results[results.length - 1];
  const best = results
    .slice(0, -1)
    .sort((a, b) => b.expectancyR - a.expectancyR)[0];

  console.log(
    `\nKontrol grubu (yazi-tura) beklentisi: ${fmt(baseline.expectancyR, 3)} R/islem`,
  );
  console.log(
    `En iyi strateji beklentisi          : ${fmt(best.expectancyR, 3)} R/islem  (${best.strategy})`,
  );

  const edge = best.expectancyR - baseline.expectancyR;
  console.log(`Fark (edge)                         : ${fmt(edge, 3)} R/islem\n`);

  if (best.expectancyR <= 0) {
    console.log(
      'SONUC: Hicbir strateji pozitif beklenti uretmedi. Bu haliyle canliya\n' +
        '       ALINMAZ. Parametre/zaman dilimi degistirip tekrar olculmeli.',
    );
  } else if (edge <= 0.02) {
    console.log(
      'SONUC: Strateji yazi-turadan anlamli sekilde ayrismiyor. Gorunen kar\n' +
        '       buyuk ihtimalle sans; canliya alinmamali.',
    );
  } else if (best.trades.length < 30) {
    console.log(
      `SONUC: Beklenti pozitif ama sadece ${best.trades.length} islem var —\n` +
        '       istatistiksel olarak anlamli degil. Daha uzun donem gerekiyor.',
    );
  } else {
    console.log(
      'SONUC: Pozitif beklenti ve kontrol grubundan ayrisma var. Bir sonraki\n' +
        '       adim: farkli sembol/donemde ayni sonuc cikiyor mu (saglamlik).',
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error('\nHATA:', e?.message ?? e);
  process.exit(1);
});
