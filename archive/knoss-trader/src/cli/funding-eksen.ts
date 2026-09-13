import { loadBars } from '../data/binance';
import { loadFunding } from '../data/funding';
import { evaluate, judge } from '../backtest/sweep';
import { randomBaseline } from '../strategies/random-baseline';
import { fundingSignal, FundingSignalParams, DEFAULT_FUNDING_SIGNAL } from '../strategies/funding-signal';
import { Strategy } from '../backtest/types';

/**
 * ALTINCI HIPOTEZ SINIFI: fonlama orani SINYAL olarak.
 *
 * Bugune kadar denenen her sey (12 strateji, kesitsel siralama, cikis
 * kurali, secim yontemi) islem gorulen varligin kendi OHLCV'sini
 * kullandi. Fonlama, fiyatta OLMAYAN bir bilgi tasir: konumlanma.
 *
 * === ONCEDEN ILAN EDILEN BIRINCIL HIPOTEZ ===
 * Kosudan ONCE yazildi, sonucu gorup secilmedi:
 *
 *   KONTRARIAN, 30 gunluk pencere (90 nokta), uc %20, stop 2 ATR, R:R 2.
 *   Dokunulmamis 8 sembolde, TEK test.
 *
 * Gerekce: asiri pozitif fonlama = long tarafi kalabalik ve tasima
 * maliyeti oduyor; kalabalik taraf sikisinca zorla kapanir.
 *
 * Diger varyantlar KESIF amaclidir ve kac tanesinin denendigi
 * raporlanir — cunku k cekilisin en iyisi, hic edge olmasa bile
 * k/(k+1) yuzdeligine cikar.
 */

const interval = process.argv[2] ?? '4h';
const N_NULL = parseInt(process.argv[3] ?? '40', 10);

const AYAR = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];
const DOKUNULMAMIS = [
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

/** ONCEDEN ILAN EDILEN birincil konfigurasyon. */
const BIRINCIL: FundingSignalParams = {
  ...DEFAULT_FUNDING_SIGNAL,
  contrarian: true,
  lookback: 90,
  edgePct: 20,
  stopAtr: 2,
  rr: 2,
};

const fmt = (n: number, d = 3) =>
  Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(d) : '   ?  ';

function yukle(semboller: string[]) {
  return semboller
    .map((s) => ({ symbol: s, bars: loadBars(s, interval), funding: loadFunding(s) }))
    .filter(
      (x): x is { symbol: string; bars: NonNullable<ReturnType<typeof loadBars>>; funding: NonNullable<ReturnType<typeof loadFunding>> } =>
        x.bars !== null && x.bars.length > 0 && x.funding !== null && x.funding.length > 0,
    );
}

/** Bir stratejinin sembol kumesindeki ortalama gorulmemis beklentisi. */
function beklentiOf(
  yapici: (funding: any) => Strategy,
  kume: ReturnType<typeof yukle>,
): { exp: number; islem: number } {
  let toplam = 0;
  let islem = 0;
  for (const { symbol, bars, funding } of kume) {
    const c = evaluate(
      yapici(funding),
      (sh, seed) => randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr),
      bars, symbol, interval,
    );
    toplam += c.outOfSample.expectancyR;
    islem += c.outOfSample.trades;
  }
  return { exp: toplam / (kume.length || 1), islem };
}

function main() {
  const ayar = yukle(AYAR);
  const oos = yukle(DOKUNULMAMIS);
  if (!ayar.length || !oos.length) {
    console.error('Veri eksik. Once: npm run data && npm run fetch-funding');
    process.exit(1);
  }

  console.log('='.repeat(78));
  console.log('ALTINCI EKSEN — FONLAMA ORANI SINYAL OLARAK');
  console.log('='.repeat(78));
  console.log(`Zaman dilimi : ${interval}`);
  console.log(`Ayar / OOS   : ${ayar.length} / ${oos.length} sembol`);
  console.log('');
  console.log('ONCEDEN ILAN EDILEN BIRINCIL HIPOTEZ:');
  console.log('  kontrarian, 30 gun pencere, uc %20, stop 2 ATR, R:R 2');
  console.log('  Gerekce: asiri fonlama = kalabalik taraf = sikisma.');
  console.log('');

  // ---------- 1) BIRINCIL TEST: dokunulmamis sembollerde ----------
  console.log('-'.repeat(78));
  console.log('1) BIRINCIL TEST — DOKUNULMAMIS sembollerde, TEK kosu');
  console.log('-'.repeat(78));

  const birincil = beklentiOf((f) => fundingSignal(f, BIRINCIL), oos);
  console.log(`  beklenti : ${fmt(birincil.exp)} R   (${birincil.islem} gorulmemis islem)`);

  // Null dagilimi: AYNI geometride yazi-tura.
  process.stdout.write('  sans dagilimi kosuluyor...');
  const nulls: number[] = [];
  for (let i = 0; i < N_NULL; i++) {
    const seed = 1000 + i * 37;
    const every = 15 + (i % 11);
    nulls.push(
      beklentiOf(
        () => randomBaseline(seed, every, BIRINCIL.stopAtr, BIRINCIL.rr),
        oos,
      ).exp,
    );
  }
  nulls.sort((a, b) => a - b);
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  const yuzdelik = (nulls.filter((x) => x < birincil.exp).length / nulls.length) * 100;
  const ort = nulls.reduce((a, b) => a + b, 0) / nulls.length;

  console.log(`  yazi-tura ortalamasi : ${fmt(ort)} R`);
  console.log(`  YUZDELIK             : %${yuzdelik.toFixed(0)}`);
  console.log('');
  console.log(
    yuzdelik >= 95
      ? '  >> BIRINCIL HIPOTEZ SANS DAGILIMINDAN AYRISIYOR. Tek test, tek hipotez,'
        + '\n     onceden ilan edilmis — bu, coklu karsilastirma tuzagina DUSMEYEN'
        + '\n     bir sonuc. Derinlemesine bakilmali.'
      : '  >> Birincil hipotez %95 esigini GECMIYOR. Onceden ilan edilmisti,'
        + '\n     yani sonradan secim yanliligi yok — sonuc oldugu gibi okunur.',
  );
  console.log('');

  // ---------- 2) KESIF: varyant izgarasi (ayar sembolleri) ----------
  console.log('-'.repeat(78));
  console.log('2) KESIF — varyant izgarasi, AYAR sembollerinde');
  console.log('-'.repeat(78));

  const varyantlar: { ad: string; p: FundingSignalParams }[] = [];
  for (const contrarian of [true, false]) {
    for (const lookback of [45, 90, 180]) {
      for (const edgePct of [10, 20]) {
        varyantlar.push({
          ad: `${contrarian ? 'kontra' : 'moment'} p${lookback} uc${edgePct}`,
          p: { ...BIRINCIL, contrarian, lookback, edgePct },
        });
      }
    }
  }

  console.log(`  ${varyantlar.length} varyant deneniyor.`);
  console.log(`  Sifir edge varsayiminda EN IYININ beklenen yuzdeligi:`);
  console.log(`     k/(k+1) = ${varyantlar.length}/${varyantlar.length + 1} = %${((varyantlar.length / (varyantlar.length + 1)) * 100).toFixed(0)}`);
  console.log('  Yani buradaki en iyi sonuc, bu esigi ASMADIKCA hicbir sey ifade etmez.');
  console.log('');
  console.log('  VARYANT'.padEnd(26) + 'ISLEM'.padStart(8) + 'BEKLENTI'.padStart(11) + '  KARAR');
  console.log('  ' + '-'.repeat(74));

  const sonuclar: { ad: string; exp: number; islem: number; p: FundingSignalParams }[] = [];
  for (const v of varyantlar) {
    const hucreler = ayar.map(({ symbol, bars, funding }) =>
      evaluate(
        fundingSignal(funding, v.p),
        (sh, seed) => randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr),
        bars, symbol, interval,
      ),
    );
    const h = judge(v.ad, hucreler);
    const islem = hucreler.reduce((s, c) => s + c.outOfSample.trades, 0);
    sonuclar.push({ ad: v.ad, exp: h.avgOosExpectancy, islem, p: v.p });
    console.log(
      '  ' + v.ad.padEnd(24) +
        String(islem).padStart(8) +
        fmt(h.avgOosExpectancy).padStart(11) +
        '  ' + h.verdict,
    );
  }
  console.log('  ' + '-'.repeat(74));
  console.log('');

  const enIyi = [...sonuclar].sort((a, b) => b.exp - a.exp)[0];
  console.log(`  Kesifte en iyi: ${enIyi.ad}  (${fmt(enIyi.exp)} R, ayar sembollerinde)`);
  console.log('  Bu bir BULGU DEGIL — 12 varyantin en iyisi, ve ayar sembollerinde.');
  console.log('  Anlamli olmasi icin dokunulmamis sembollerde de ayrismasi gerekir.');
  console.log('');

  // ---------- 3) Kesifteki en iyiyi de OOS'ta sina ----------
  console.log('-'.repeat(78));
  console.log('3) KESIFTEKI EN IYI — dokunulmamis sembollerde');
  console.log('-'.repeat(78));
  const enIyiOos = beklentiOf((f) => fundingSignal(f, enIyi.p), oos);
  const yuzdelik2 = (nulls.filter((x) => x < enIyiOos.exp).length / nulls.length) * 100;
  console.log(`  ${enIyi.ad}`);
  console.log(`  beklenti : ${fmt(enIyiOos.exp)} R   (${enIyiOos.islem} islem)`);
  console.log(`  YUZDELIK : %${yuzdelik2.toFixed(0)}`);
  console.log('');
  const esik = (varyantlar.length / (varyantlar.length + 1)) * 100;
  console.log(
    yuzdelik2 >= 95 && yuzdelik2 > esik
      ? '  >> Hem %95 esigini hem coklu-karsilastirma esigini geciyor.'
      : `  >> Yetersiz. Coklu karsilastirma esigi %${esik.toFixed(0)}, %95 esigi asilmadi.`,
  );
  console.log('');
}

main();
