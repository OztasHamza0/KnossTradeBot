import { loadBars } from '../data/binance';
import { evaluate, judge, StrategyVerdict } from '../backtest/sweep';
import { DEFAULT_CONFIG, Strategy } from '../backtest/types';
import { randomBaseline } from '../strategies/random-baseline';
import { ALL_STRATEGIES } from '../strategies/registry';

/**
 * Edge taramasi.
 *
 * Her strateji her sembolde calistirilir, sonuc GORULMEMIS veriye (son %30)
 * gore degerlendirilir ve yazi-tura tabaniyla kiyaslanir. Cikti tek bir
 * soruya cevap verir: bu stratejilerden herhangi biri canliya aday mi.
 *
 * Kullanim: npm run sweep -- 1h
 */

const interval = process.argv[2] ?? '1h';

const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'LINKUSDT',
];

const fmt = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '—');

const VERDICT_LABEL: Record<StrategyVerdict['verdict'], string> = {
  umutlu: 'UMUTLU',
  'yetersiz-veri': 'yetersiz veri',
  'asiri-uydurma': 'ASIRI UYDURMA',
  'edge-yok': 'edge yok',
};

function main() {
  const loaded = SYMBOLS.map((s) => ({ symbol: s, bars: loadBars(s, interval) })).filter(
    (x): x is { symbol: string; bars: NonNullable<ReturnType<typeof loadBars>> } =>
      x.bars !== null && x.bars.length > 0,
  );

  if (loaded.length === 0) {
    console.error(`${interval} icin veri yok. Once: npm run data`);
    process.exit(1);
  }

  console.log(
    `\nEDGE TARAMASI — ${interval}, ${loaded.length} sembol, ` +
      `${loaded[0].bars.length} mum/sembol`,
  );
  console.log(
    `Karar GORULMEMIS son %30'a gore. Komisyon %${DEFAULT_CONFIG.feePct}/yon, ` +
      `kayma %${DEFAULT_CONFIG.slippagePct}, islem basi risk %${DEFAULT_CONFIG.riskPct}.\n`,
  );

  const verdicts: StrategyVerdict[] = [];

  for (const { factory } of ALL_STRATEGIES) {
    let strategy: Strategy;
    try {
      strategy = factory();
    } catch (e: any) {
      console.log(`(atlandi: ${e?.message})`);
      continue;
    }

    const cells = loaded.map(({ symbol, bars }) =>
      // Kontrol grubu, stratejinin OLCULEN stop/hedef yapisinda kosar.
      // Sabit bir yapi kullanmak "taban farki" sutununu beceri degil
      // stop geometrisi olcer hale getiriyordu (bkz. measureShape).
      evaluate(strategy, (sh, seed) => randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr), bars, symbol, interval),
    );
    verdicts.push(judge(strategy.name, cells));
  }

  const order: Record<StrategyVerdict['verdict'], number> = {
    umutlu: 0,
    'asiri-uydurma': 1,
    'yetersiz-veri': 2,
    'edge-yok': 3,
  };
  verdicts.sort(
    (a, b) => order[a.verdict] - order[b.verdict] || b.avgEdge - a.avgEdge,
  );

  console.log(
    'STRATEJI'.padEnd(46) +
      'OOS ISLEM'.padStart(10) +
      'BEKLENTI'.padStart(10) +
      'TABAN FARKI'.padStart(13) +
      'POZ/TOPLAM'.padStart(12) +
      '  KARAR',
  );
  console.log('-'.repeat(108));

  for (const v of verdicts) {
    console.log(
      v.strategy.slice(0, 45).padEnd(46) +
        String(v.totalOosTrades).padStart(10) +
        fmt(v.avgOosExpectancy).padStart(10) +
        fmt(v.avgEdge).padStart(13) +
        `${v.positiveSymbols}/${v.votingSymbols}`.padStart(12) +
        '  ' +
        VERDICT_LABEL[v.verdict],
    );
  }
  console.log('-'.repeat(108));

  const promising = verdicts.filter((v) => v.verdict === 'umutlu');

  if (promising.length === 0) {
    console.log(
      '\nSONUC: Canliya aday strateji YOK.\n' +
        '\nElenme gerekceleri:',
    );
    for (const v of verdicts.slice(0, 6)) {
      console.log(`  ${v.strategy.slice(0, 44).padEnd(45)} ${v.note}`);
    }
    console.log(
      '\nBu bir basarisizlik degil olcum sonucudur: bu stratejiler canliya\n' +
        'alinsaydi para kaybettireceklerdi.',
    );
  } else {
    console.log(`\n${promising.length} UMUTLU STRATEJI:\n`);
    for (const v of promising) {
      console.log(`  ${v.strategy}`);
      console.log(`    ${v.note}`);
      console.log('    sembol bazinda gorulmemis beklenti:');
      for (const c of v.cells) {
        const flag = c.outOfSample.expectancyR > 0 ? '+' : ' ';
        console.log(
          `      ${flag} ${c.symbol.padEnd(10)} ${fmt(c.outOfSample.expectancyR).padStart(8)} R  ` +
            `(${c.outOfSample.trades} islem, getiri ${fmt(c.outOfSample.returnPct, 1)}%, ` +
            `max dusus ${fmt(c.outOfSample.maxDrawdownPct, 1)}%)`,
        );
      }
      console.log('');
    }
    console.log(
      'Bir sonraki adim: bu stratejileri farkli zaman diliminde ve daha uzun\n' +
        'gecmiste dogrula. Tek bir taramada iyi gorunmek yeterli degil.',
    );
  }
  console.log('');
}

main();
