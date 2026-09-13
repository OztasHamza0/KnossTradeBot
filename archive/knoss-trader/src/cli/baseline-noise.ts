import { loadBars } from '../data/binance';
import { evaluate, judge, BASELINE_SEED_COUNT } from '../backtest/sweep';
import { randomBaseline } from '../strategies/random-baseline';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { tsMomentum } from '../strategies/ts-momentum';
import { Strategy } from '../backtest/types';

/**
 * TABAN GURULTUSU — olcum duzeneginin kendisini olcer.
 *
 * SORDUGU SORU: judge()'un karar verdigi `avgEdge` sayisi, kontrol grubunun
 * TOHUMUNA ne kadar bagli?
 *
 * NEDEN ONEMLI: sweep.ts ve luck-test.ts tabani TEK SABIT TOHUMLA kosuyor
 * (`randomBaseline(42, ...)`). `edge` = strateji OOS beklentisi - taban OOS
 * beklentisi. Taban tek bir yazi-tura CEKILISIYSE, kendi ornekleme gurultusu
 * vardir. judge() ise karari `avgEdge <= 0.02` esigiyle veriyor.
 *
 * Eger tohumu degistirmek avgEdge'i 0.02'den COK daha fazla oynatiyorsa,
 * "edge var / yok" karari BECERIYI DEGIL, 42 numarali cekilisin sansini
 * olcuyor demektir. O zaman projenin butun sonuclari — hem elenenler hem
 * "umutlu" cikanlar — yeniden okunmali.
 *
 * Bu arac bir strateji hakkinda hicbir sey soylemez. OLCUM ALETININ
 * kalibrasyonunu soyler. Terazinin kendisi 3 kilo sapiyorsa, tartilan
 * seylerin agirligi hakkinda konusmanin anlami yok.
 *
 * Kullanim:  npx ts-node src/cli/baseline-noise.ts [1h|4h] [tohumSayisi]
 */

const interval = process.argv[2] ?? '1h';
const N = parseInt(process.argv[3] ?? '40', 10);

/** Taramanin kullandigi semboller (sweep.ts ile ayni kume). */
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

/** judge()'un karar esigi — sweep.ts icindeki sabitle ayni. */
const KARAR_ESIGI = 0.02;

const fmt = (n: number, d = 4) => (n >= 0 ? '+' : '') + n.toFixed(d);

function ortalama(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
}

/** Iki gecisli standart sapma — tek gecisli (sum, sumSq) formulu buyuk
 *  sayilarda birbirine cok yakin iki devasa degerin farki olur. */
function stdSapma(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = ortalama(xs);
  const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function yuzdelik(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[i];
}

interface Aday {
  ad: string;
  strat: () => Strategy;
}

/** Canlida kosan konfigurasyon ve taramanin en iyi adayi. */
const ADAYLAR: Aday[] = [
  {
    ad: 'donchian-20 (CANLIDA KOSAN: 3 ATR / R:R 3)',
    strat: () =>
      donchianBreakout({ lookback: 20, atrPeriod: 14, stopAtr: 3, rr: 3, trendEma: 200 }),
  },
  {
    ad: 'ts-momentum (taramanin en iyi adayi)',
    strat: () => tsMomentum(),
  },
];

function main() {
  const loaded = SYMBOLS.map((s) => ({ symbol: s, bars: loadBars(s, interval) })).filter(
    (x): x is { symbol: string; bars: NonNullable<ReturnType<typeof loadBars>> } =>
      x.bars !== null && x.bars.length > 0,
  );

  if (!loaded.length) {
    console.error(`${interval} icin veri yok. Once: npm run data`);
    process.exit(1);
  }

  console.log('='.repeat(78));
  console.log('TABAN GURULTUSU — olcum aletinin kalibrasyonu');
  console.log('='.repeat(78));
  console.log(`Zaman dilimi : ${interval}`);
  console.log(`Semboller    : ${loaded.map((l) => l.symbol).join(', ')}`);
  console.log(`Tohum sayisi : ${N}`);
  console.log(`judge() esigi: avgEdge <= ${KARAR_ESIGI} -> "edge-yok"`);
  console.log('');
  console.log('Strateji SABIT tutuluyor. Degisen tek sey kontrol grubunun');
  console.log('tohumu. Yani asagidaki yayilimin TAMAMI olcum gurultusudur.');
  console.log('');

  for (const aday of ADAYLAR) {
    console.log('-'.repeat(78));
    console.log(aday.ad);
    console.log('-'.repeat(78));

    const avgEdges: number[] = [];
    const kararlar: Record<string, number> = {};

    for (let i = 0; i < N; i++) {
      // luck-test.ts ile ayni desen: hem tohum hem islem sikligi degisir.
      // Yalnizca tohumu degistirmek dagilimi YAPAY OLARAK DARALTIR.
      const seed = 1000 + i * 37;
      // TEK TOHUM — bilerek. Bu arac tam olarak "taban tek cekilisken ne
      // kadar sapiyor" sorusunu olcuyor; cok tohumlu ortalama kullanmak
      // olcmek istedigimiz seyi ortadan kaldirirdi.
      const cells = loaded.map((l) =>
        evaluate(
          aday.strat(),
          (sh, s) => randomBaseline(s, sh.tradeEveryN, sh.stopAtr, sh.rr),
          l.bars,
          l.symbol,
          interval,
          undefined,
          [seed],
        ),
      );
      const v = judge(aday.ad, cells);
      avgEdges.push(v.avgEdge);
      kararlar[v.verdict] = (kararlar[v.verdict] ?? 0) + 1;
    }

    const m = ortalama(avgEdges);
    const sd = stdSapma(avgEdges);
    const alt = yuzdelik(avgEdges, 2.5);
    const ust = yuzdelik(avgEdges, 97.5);

    // Projenin ESKIDEN kullandigi tek tohum (42) — hatanin canli hali.
    const cells42 = loaded.map((l) =>
      evaluate(
        aday.strat(),
        (sh, s) => randomBaseline(s, sh.tradeEveryN, sh.stopAtr, sh.rr),
        l.bars,
        l.symbol,
        interval,
        undefined,
        [42],
      ),
    );
    const v42 = judge(aday.ad, cells42);

    // DUZELTILMIS olcum: taban cok tohumlu ortalama, esik gurultuye bagli.
    const cellsDuzeltilmis = loaded.map((l) =>
      evaluate(
        aday.strat(),
        (sh, s) => randomBaseline(s, sh.tradeEveryN, sh.stopAtr, sh.rr),
        l.bars,
        l.symbol,
        interval,
      ),
    );
    const vDuzeltilmis = judge(aday.ad, cellsDuzeltilmis);

    console.log(`  avgEdge ortalama      : ${fmt(m)} R`);
    console.log(`  avgEdge std sapma     : ${fmt(sd)} R`);
    console.log(`  %95 yayilim           : [${fmt(alt)}, ${fmt(ust)}] R`);
    console.log(`  genislik              : ${fmt(ust - alt)} R`);
    console.log('');
    console.log(`  ESKI HAL — tek tohum (42) : avgEdge ${fmt(v42.avgEdge)} R -> ${v42.verdict}`);
    console.log(
      `  DUZELTILMIS — ${BASELINE_SEED_COUNT} tohum : avgEdge ${fmt(vDuzeltilmis.avgEdge)} R -> ` +
        `${vDuzeltilmis.verdict}`,
    );
    const seOrt = ortalama(
      cellsDuzeltilmis
        .map((c) => c.baselineStdErrR ?? NaN)
        .filter((x) => Number.isFinite(x)),
    );
    console.log(`  duzeltilmis taban std hatasi: ${fmt(seOrt)} R/hucre`);
    console.log('');
    console.log(`  Gurultu / karar esigi : ${(sd / KARAR_ESIGI).toFixed(1)}x`);
    const esikAsan = avgEdges.filter((e) => e > KARAR_ESIGI).length;
    console.log(
      `  ${N} tohumun ${esikAsan}'inde avgEdge esigi ASIYOR ` +
        `(%${((esikAsan / N) * 100).toFixed(0)})`,
    );
    console.log('  judge() kararlari:');
    for (const [k, n] of Object.entries(kararlar).sort((a, b) => b[1] - a[1])) {
      console.log(`     ${k.padEnd(16)} ${n}/${N}  (%${((n / N) * 100).toFixed(0)})`);
    }
    console.log('');

    // YORUM — sayilar kendi baslarina okunmasin.
    if (sd > KARAR_ESIGI) {
      console.log(
        `  >> OLCUM ALETI SAPIYOR: taban tohumunun tek basina urettigi sapma\n` +
          `     (${fmt(sd)} R), judge()'un karar esiginden (${KARAR_ESIGI} R) BUYUK.\n` +
          `     Yani "edge var mi" karari, kontrol grubunun sansina bagli.`,
      );
    } else {
      console.log(
        `  >> Olcum aleti bu eksende KARARLI: taban gurultusu (${fmt(sd)} R)\n` +
          `     karar esiginin (${KARAR_ESIGI} R) altinda.`,
      );
    }
    if (Object.keys(kararlar).length > 1) {
      console.log(
        `  >> KARAR TOHUMA GORE DEGISIYOR: ayni strateji, ayni veri, ayni kod —\n` +
          `     yalnizca kontrol grubunun tohumu degisince judge() farkli\n` +
          `     hukum veriyor. Tek tohumla verilen hicbir hukum guvenilir degil.`,
      );
    } else {
      console.log(`  >> Hukum ${N} tohumun hepsinde ayni: ${Object.keys(kararlar)[0]}`);
    }
    console.log('');
  }

  console.log('='.repeat(78));
  console.log('NASIL OKUNMALI');
  console.log('='.repeat(78));
  console.log('Bu arac bir stratejinin iyi ya da kotu oldugunu SOYLEMEZ.');
  console.log('Terazinin kac kilo saptigini soyler. Sapma karar esiginden');
  console.log('buyukse, o teraziyle verilmis hicbir karar — ne "elendi" ne');
  console.log('"umutlu" — tek basina okunamaz.');
  console.log('');
  console.log('Duzeltme yolu: taban TEK cekilis degil, COK cekilisin');
  console.log('ortalamasi olmali. edge = strateji - E[taban], ve karar esigi');
  console.log('tabanin standart hatasina gore konmali.');
}

main();
