import { loadBars } from '../data/binance';
import { evaluate, judge } from '../backtest/sweep';
import { randomBaseline } from '../strategies/random-baseline';
import { tsMomentum, DEFAULT_TS_MOMENTUM } from '../strategies/ts-momentum';

/**
 * Parametre komsulugu testi — "gercek edge mi, uydurma mi" sorusunun
 * en keskin cevabi.
 *
 * Mantik su: gercek bir piyasa duzenliligi KABA olur. "12/48/168 mumluk
 * getiriler ayni yonu gosterirse devam eder" dogruysa, 10/40/140 ve
 * 14/56/196 de calismali — cunku duzenlilik pencerenin tam sayisinda degil,
 * fikirde. Yalnizca TEK bir kombinasyon calisiyorsa o kombinasyon bir yasa
 * degil, gecmis verinin ezberlenmis halidir.
 *
 * Bu test bir stratejiyi kurtarmaz, sadece yalanlayabilir. Gecmesi
 * "kesinlikle gercek" demek degil; kalmasi demek.
 */

const interval = process.argv[2] ?? '1h';

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

/** Varsayilanin etrafinda +/-%20'lik komsuluk. */
const VARIANTS = [
  { label: 'varsayilan  12/48/168 stop2.0 rr2.0', p: DEFAULT_TS_MOMENTUM },
  { label: 'pencere -%20  10/38/134', p: { ...DEFAULT_TS_MOMENTUM, shortLb: 10, midLb: 38, longLb: 134 } },
  { label: 'pencere +%20  14/58/202', p: { ...DEFAULT_TS_MOMENTUM, shortLb: 14, midLb: 58, longLb: 202 } },
  { label: 'pencere -%40   7/29/101', p: { ...DEFAULT_TS_MOMENTUM, shortLb: 7, midLb: 29, longLb: 101 } },
  { label: 'pencere +%40  17/67/235', p: { ...DEFAULT_TS_MOMENTUM, shortLb: 17, midLb: 67, longLb: 235 } },
  { label: 'stop 1.5 ATR', p: { ...DEFAULT_TS_MOMENTUM, stopAtr: 1.5 } },
  { label: 'stop 2.5 ATR', p: { ...DEFAULT_TS_MOMENTUM, stopAtr: 2.5 } },
  { label: 'stop 3.0 ATR', p: { ...DEFAULT_TS_MOMENTUM, stopAtr: 3 } },
  { label: 'R:R 1.5', p: { ...DEFAULT_TS_MOMENTUM, rr: 1.5 } },
  { label: 'R:R 2.5', p: { ...DEFAULT_TS_MOMENTUM, rr: 2.5 } },
  { label: 'R:R 3.0', p: { ...DEFAULT_TS_MOMENTUM, rr: 3 } },
];

const fmt = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '—');

function main() {
  const loaded = SYMBOLS.map((s) => ({ symbol: s, bars: loadBars(s, interval) })).filter(
    (x): x is { symbol: string; bars: NonNullable<ReturnType<typeof loadBars>> } =>
      x.bars !== null && x.bars.length > 0,
  );

  if (loaded.length === 0) {
    console.error(`${interval} icin veri yok. Once: npm run data`);
    process.exit(1);
  }

  console.log(`\nPARAMETRE KOMSULUGU — TS momentum, ${interval}, ${loaded.length} sembol`);
  console.log(
    'Gercek bir duzenlilik KABA olur: komsu parametreler de calismali.\n' +
      'Yalnizca varsayilan calisiyorsa, o varsayilan gecmise uydurulmustur.\n',
  );

  console.log(
    'VARYANT'.padEnd(38) + 'OOS ISLEM'.padStart(10) + 'BEKLENTI'.padStart(10) +
      'TABAN FARKI'.padStart(13) + 'POZ'.padStart(6) + '  KARAR',
  );
  console.log('-'.repeat(90));

  let positive = 0;
  for (const v of VARIANTS) {
    const strat = tsMomentum(v.p);
    const cells = loaded.map(({ symbol, bars }) =>
      // Yapiyla eslesen taban SART: bu arac stopAtr ve rr varyantlarini
      // deniyor, yani sabit tabanda "genis stop iyi gorunur" yanilsamasi
      // tam da burada olusurdu.
      evaluate(strat, (sh, seed) => randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr), bars, symbol, interval),
    );
    const verdict = judge(v.label, cells);
    if (verdict.avgOosExpectancy > 0) positive++;

    console.log(
      v.label.padEnd(38) +
        String(verdict.totalOosTrades).padStart(10) +
        fmt(verdict.avgOosExpectancy).padStart(10) +
        fmt(verdict.avgEdge).padStart(13) +
        `${verdict.positiveSymbols}/8`.padStart(6) +
        '  ' + verdict.verdict,
    );
  }

  console.log('-'.repeat(90));
  console.log(`\n${positive}/${VARIANTS.length} varyantta beklenti pozitif.`);

  if (positive >= VARIANTS.length * 0.7) {
    console.log(
      'SONUC: Komsuluk saglam. Sonuc tek bir parametre secimine bagli degil —\n' +
        '       fikrin kendisinde bir sey var. Bir sonraki adim ileri-yuruyen\n' +
        '       (walk-forward) dogrulama.',
    );
  } else if (positive <= VARIANTS.length * 0.3) {
    console.log(
      'SONUC: Komsuluk COKUYOR. Yalnizca belirli parametreler calisiyor —\n' +
        '       bu asiri uydurmanin klasik imzasi. Canliya ALINMAZ.',
    );
  } else {
    console.log(
      'SONUC: Karisik. Bazi komsular tutuyor bazi tutmuyor — zayif ama\n' +
        '       tamamen sahte olmayabilir. Daha uzun gecmis gerekiyor.',
    );
  }
  console.log('');
}

main();
