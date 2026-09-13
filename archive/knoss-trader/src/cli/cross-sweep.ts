import { loadBars } from '../data/binance';
import { Bar } from '../data/types';
import { evaluate, judge, StrategyVerdict } from '../backtest/sweep';
import { buildRanks } from '../backtest/cross-section';
import { crossMomentum, DEFAULT_CROSS_MOMENTUM } from '../strategies/cross-momentum';
import { randomBaseline } from '../strategies/random-baseline';

/**
 * KESITSEL TARAMA — yapisal olarak FARKLI bir hipotez sinifi.
 *
 * Onceki 12 strateji aslinda 12 hipotez degildi: BIR hipotezin 12
 * varyasyonuydu. Donchian, EMA, RSI, Bollinger, hacim, oynaklik, seans —
 * hepsi "tek bir varligin KENDI fiyat gecmisine bakip KENDI yonunu tahmin
 * et" seklindeydi. Hepsinin ayni yerde olmesi bu yuzden sasirtici degil.
 *
 * Buradaki hipotez farkli: varliklar ARASINDAKI goreli guc. Bir sembolun
 * digerlerine gore nerede durdugu, tek varlik stratejilerinin literal
 * olarak goremedigi bir bilgi.
 *
 * SIRALAMA EVRENI vs OLCUM EVRENI:
 *   Siralama TUM sembollerden kurulur (canlida da oyle olur — bot 20
 *   sembolu birden siralar). Ama OLCUM yalnizca taramanin standart 8
 *   sembolunde yapilir; kalan 8 sembol sans testi icin DOKUNULMAMIS
 *   kalir. Hepsinde olcup sonra "sans testi de yapalim" demek, kontrol
 *   grubunu kirletmek olurdu.
 *
 * Kullanim:  npm run cross-sweep -- 1h
 */

/** Olcum yapilan semboller (sweep.ts ile AYNI 8). */
const OLCUM = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

/** Siralama evrenine giren ek semboller — olcumde KULLANILMAZ. */
const EK_EVREN = [
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

const interval = process.argv[2] ?? '1h';

/**
 * Denenen varyantlar. Bilerek AZ tutuldu: her varyant bir piyango bileti
 * ve elli konfigurasyon denendikten sonra birinin iyi gorunmesi
 * kacinilmaz. Karar yine sans testinde verilecek.
 */
const VARYANTLAR = [
  { etiket: 'momentum 168 mum, uc %20', p: { ...DEFAULT_CROSS_MOMENTUM } },
  { etiket: 'momentum  72 mum, uc %20', p: { ...DEFAULT_CROSS_MOMENTUM, lookback: 72 } },
  { etiket: 'momentum 336 mum, uc %20', p: { ...DEFAULT_CROSS_MOMENTUM, lookback: 336 } },
  { etiket: 'momentum 168 mum, uc %10', p: { ...DEFAULT_CROSS_MOMENTUM, edgePct: 0.1 } },
  { etiket: 'ort.donus 168 mum, uc %20', p: { ...DEFAULT_CROSS_MOMENTUM, contrarian: true } },
  { etiket: 'ort.donus  72 mum, uc %20', p: { ...DEFAULT_CROSS_MOMENTUM, contrarian: true, lookback: 72 } },
];

const fmt = (n: number, d = 3) => (n >= 0 ? '+' : '') + n.toFixed(d);

(async () => {
  console.log('='.repeat(108));
  console.log(`KESITSEL TARAMA — ${interval}`);
  console.log('='.repeat(108));

  const evren: Record<string, Bar[]> = {};
  const eksik: string[] = [];
  for (const s of [...OLCUM, ...EK_EVREN]) {
    try {
      const b = loadBars(s, interval);
      if (b && b.length > 500) evren[s] = b;
      else eksik.push(s);
    } catch {
      eksik.push(s);
    }
  }
  const olculecek = OLCUM.filter((s) => evren[s]);
  if (olculecek.length < 4) {
    console.error(`${interval} icin yeterli veri yok. Once: npm run data`);
    process.exit(1);
  }
  console.log(
    `siralama evreni: ${Object.keys(evren).length} sembol  |  ` +
      `olcum: ${olculecek.length} sembol  |  ` +
      `${eksik.length ? 'veri yok: ' + eksik.join(', ') : 'tum veri mevcut'}`,
  );
  console.log('');

  const verdicts: { etiket: string; v: StrategyVerdict }[] = [];

  for (const { etiket, p } of VARYANTLAR) {
    // Siralama TUM evrenden; olcum yalnizca OLCUM sembollerinde.
    const ranks = buildRanks(evren, p.lookback);

    const cells = olculecek.map((symbol) =>
      evaluate(
        crossMomentum(ranks[symbol], p),
        // Kontrol grubu, stratejinin OLCULEN stop/hedef yapisinda kosar.
        (sh, seed) => randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr),
        evren[symbol],
        symbol,
        interval,
      ),
    );
    verdicts.push({ etiket, v: judge(etiket, cells) });
  }

  const oncelik = { umutlu: 0, 'asiri-uydurma': 1, 'yetersiz-veri': 2, 'edge-yok': 3 } as const;
  verdicts.sort(
    (a, b) =>
      oncelik[a.v.verdict] - oncelik[b.v.verdict] || b.v.avgEdge - a.v.avgEdge,
  );

  console.log(
    'VARYANT'.padEnd(28) + 'OOS ISLEM'.padStart(11) + 'BEKLENTI'.padStart(10) +
      'TABAN FARKI'.padStart(13) + 'POZ/TOPLAM'.padStart(12) + '  KARAR',
  );
  console.log('-'.repeat(108));
  for (const { etiket, v } of verdicts) {
    console.log(
      etiket.padEnd(28) +
        String(v.totalOosTrades).padStart(11) +
        fmt(v.avgOosExpectancy).padStart(10) +
        fmt(v.avgEdge).padStart(13) +
        `${v.positiveSymbols}/${v.votingSymbols}`.padStart(12) +
        '  ' +
        (v.verdict === 'umutlu' ? 'UMUTLU' : v.verdict.replace('-', ' ')),
    );
  }
  console.log('-'.repeat(108));

  const umutlu = verdicts.filter((x) => x.v.verdict === 'umutlu');
  console.log('');
  if (!umutlu.length) {
    console.log('Kesitsel hipotez sinifinda da aday YOK.');
    console.log('');
    console.log('Bu, tek varlik stratejilerinin sonucuyla BIRLIKTE okunmali:');
    console.log('yapisal olarak farkli iki hipotez sinifi denendi, ikisinde de');
    console.log('yazi-turadan ayrisan bir sey bulunamadi.');
  } else {
    for (const { etiket, v } of umutlu) {
      console.log(`UMUTLU: ${etiket}`);
      console.log(`  ${v.note}`);
      for (const c of v.cells) {
        const isaret = c.outOfSample.expectancyR > 0 ? '+' : ' ';
        console.log(
          `    ${isaret} ${c.symbol.padEnd(10)} ${fmt(c.outOfSample.expectancyR)} R  ` +
            `(${c.outOfSample.trades} islem, taban ${fmt(c.baselineOos.expectancyR)} R)`,
        );
      }
      console.log('');
    }
    console.log('DIKKAT: tek bir taramada iyi gorunmek HICBIR SEY ifade etmez.');
    console.log('Karar sans testinde, DOKUNULMAMIS sembollerde verilir:');
    console.log('  npm run cross-luck -- ' + interval);
  }
})();
