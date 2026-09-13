import { loadBars } from '../data/binance';
import { runBacktest } from '../backtest/engine';
import { ALL_STRATEGIES } from '../strategies/registry';
import { DEFAULT_CONFIG, Trade } from '../backtest/types';

/**
 * EDGE BUTCESI — "%95'e nasil gelecegiz" sorusunun ARITMETIK cevabi.
 *
 * Iki ayri duvar var ve ikisi de olculebilir. Umut degil, sayi.
 *
 * DUVAR 1 — MALIYET TABANI.
 *   Her gidis-donus komisyon ve kayma yakar. Bu maliyet, islemin R
 *   olcegine gore ne kadar buyukse, stratejinin sadece BASABAS kalmak
 *   icin uretmesi gereken ham edge o kadar buyuktur.
 *
 *     maliyet_R = (gidis-donus maliyet %) / (stop mesafesi %)
 *
 *   Stop dar ve islem sik ise, maliyet 1R'nin buyuk bir kismini yer ve
 *   aranan edge ARITMETIK OLARAK ulasilamaz hale gelir. Bu durumda
 *   "daha iyi strateji" aramak bosunadir; degismesi gereken sey
 *   maliyet ya da islem olcegi.
 *
 * DUVAR 2 — ISTATISTIKSEL GUC.
 *   Elimizdeki N islemle ayirt edebilecegimiz EN KUCUK edge:
 *
 *     tespit_edilebilir_edge ~ 1.96 x sd(R) / sqrt(N)
 *
 *   Bunun altindaki bir edge, VAR OLSA BILE gorunmez. %95 esigine
 *   "ulasmak" icin ya edge bu esigin ustunde olmali ya N buyumeli.
 *   N'i dorte katlamak esigi YARIYA indirir (sqrt).
 *
 * Bu arac ikisini birlikte basar: aranan edge, maliyet duvarinin
 * USTUNDE ve tespit duvarinin USTUNDE olmak zorunda. Ikisinin arasinda
 * kalan bolge "belki vardir ama asla bilemeyiz" bolgesidir.
 *
 * Kullanim: npx ts-node src/cli/edge-butcesi.ts [1h|4h]
 */

const interval = process.argv[2] ?? '1h';

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

/** Backtest'in VARSAYDIGI kayma (tek yon, %). */
const VARSAYILAN_KAYMA = DEFAULT_CONFIG.slippagePct;
/**
 * CANLIDA OLCULEN kayma (tek yon, %).
 * 4 Eylul 2026, DOTUSDT girisi: %0.1579. Tek ornek — kesin degil, ama
 * varsayilanin 8 kati oldugu icin sonucu tamamen degistiriyor ve
 * gormezden gelinemez.
 */
const OLCULEN_KAYMA = 0.158;
const KOMISYON = DEFAULT_CONFIG.feePct;

const fmt = (n: number, d = 3) =>
  Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(d) : '  ?  ';
const pct = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) + '%' : '?');

function medyan(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stdSapma(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}

function main() {
  const loaded = SYMBOLS.map((s) => ({ symbol: s, bars: loadBars(s, interval) })).filter(
    (x): x is { symbol: string; bars: NonNullable<ReturnType<typeof loadBars>> } =>
      x.bars !== null && x.bars.length > 0,
  );
  if (!loaded.length) {
    console.error(`${interval} icin veri yok. Once: npm run data`);
    process.exit(1);
  }

  const gunSayisi =
    (loaded[0].bars[loaded[0].bars.length - 1].openTime - loaded[0].bars[0].openTime) /
    86400_000;

  console.log('='.repeat(80));
  console.log('EDGE BUTCESI — "%95\'e nasil gelecegiz" sorusunun aritmetigi');
  console.log('='.repeat(80));
  console.log(`Zaman dilimi : ${interval}   |  ${loaded.length} sembol  |  ${gunSayisi.toFixed(0)} gun gecmis`);
  console.log(`Komisyon     : %${KOMISYON} / yon  (taker)`);
  console.log(`Kayma        : varsayilan %${VARSAYILAN_KAYMA} / yon  |  CANLIDA OLCULEN %${OLCULEN_KAYMA} / yon`);
  console.log('');
  console.log('MALIYET TABANI: bir islemin R olceginin ne kadari komisyon+kaymaya gidiyor.');
  console.log('Strateji, sadece BASABAS kalmak icin bu kadar ham edge uretmek zorunda.');
  console.log('');

  const basliklar =
    'STRATEJI'.padEnd(20) +
    'ISLEM'.padStart(7) +
    'STOP%'.padStart(8) +
    'MAL.(varsay)'.padStart(13) +
    'MAL.(olculen)'.padStart(14) +
    'sd(R)'.padStart(8) +
    'TESPIT'.padStart(9);
  console.log(basliklar);
  console.log('-'.repeat(80));

  const satirlar: {
    key: string;
    n: number;
    stopPct: number;
    malVarsayilan: number;
    malOlculen: number;
    sd: number;
    tespit: number;
  }[] = [];

  for (const e of ALL_STRATEGIES) {
    const tumIslemler: Trade[] = [];
    const stopYuzdeleri: number[] = [];

    for (const { symbol, bars } of loaded) {
      const r = runBacktest(e.factory(), bars, symbol, interval);
      for (const t of r.trades) {
        tumIslemler.push(t);
        const d = Math.abs(t.entryPrice - t.stopLoss);
        if (d > 0 && t.entryPrice > 0) stopYuzdeleri.push((d / t.entryPrice) * 100);
      }
    }

    if (tumIslemler.length < 20) continue;

    const medStop = medyan(stopYuzdeleri);
    // Gidis-donus: iki bacakta komisyon + iki bacakta kayma.
    const gidisDonusVarsayilan = 2 * KOMISYON + 2 * VARSAYILAN_KAYMA;
    const gidisDonusOlculen = 2 * KOMISYON + 2 * OLCULEN_KAYMA;

    const malVarsayilan = gidisDonusVarsayilan / medStop; // R cinsinden
    const malOlculen = gidisDonusOlculen / medStop;

    const rler = tumIslemler.map((t) => t.r);
    const sd = stdSapma(rler);
    const tespit = (1.96 * sd) / Math.sqrt(tumIslemler.length);

    satirlar.push({
      key: e.key,
      n: tumIslemler.length,
      stopPct: medStop,
      malVarsayilan,
      malOlculen,
      sd,
      tespit,
    });

    console.log(
      e.key.padEnd(20) +
        String(tumIslemler.length).padStart(7) +
        pct(medStop).padStart(8) +
        fmt(malVarsayilan).padStart(13) +
        fmt(malOlculen).padStart(14) +
        fmt(sd, 2).padStart(8) +
        fmt(tespit).padStart(9),
    );
  }
  console.log('-'.repeat(80));
  console.log('MAL.  = maliyetin 1R icindeki payi (R cinsinden). Basabas icin gereken ham edge.');
  console.log('TESPIT = bu islem sayisiyla %95 guvenle ayirt edilebilen EN KUCUK edge.');
  console.log('');

  // --- OZET ---
  const ortMalVarsayilan = medyan(satirlar.map((s) => s.malVarsayilan));
  const ortMalOlculen = medyan(satirlar.map((s) => s.malOlculen));
  const ortTespit = medyan(satirlar.map((s) => s.tespit));
  const ortN = medyan(satirlar.map((s) => s.n));
  const ortSd = medyan(satirlar.map((s) => s.sd));

  console.log('='.repeat(80));
  console.log('IKI DUVAR');
  console.log('='.repeat(80));
  console.log(`  DUVAR 1 — maliyet tabani (ortanca):`);
  console.log(`     varsayilan kaymayla : ${fmt(ortMalVarsayilan)} R`);
  console.log(`     OLCULEN kaymayla    : ${fmt(ortMalOlculen)} R`);
  console.log(`     -> Strateji bunun USTUNDE ham edge uretmezse net NEGATIF.`);
  console.log('');
  console.log(`  DUVAR 2 — tespit esigi (ortanca): ${fmt(ortTespit)} R`);
  console.log(`     ${ortN.toFixed(0)} islem, sd(R) ${ortSd.toFixed(2)}`);
  console.log(`     -> Bundan kucuk bir edge VAR OLSA BILE gorunmez.`);
  console.log('');

  const gecerliBolge = Math.max(ortMalOlculen, ortTespit);
  console.log(`  ARANAN EDGE, IKISININ DE USTUNDE olmali: > ${fmt(gecerliBolge)} R`);
  console.log('');
  console.log('  Bugune kadar olculen en iyi aday: +0.036 R (ts-momentum, ayar sembolleri)');
  console.log(`  Dokunulmamis sembollerde: NEGATIF`);
  console.log('');

  // --- N NE KADAR OLMALI ---
  console.log('='.repeat(80));
  console.log('TESPIT ESIGINI DUSURMEK: kac islem gerekir');
  console.log('='.repeat(80));
  console.log('  Esik 1.96 x sd / sqrt(N) — N dortlenince esik YARIYA iner.');
  console.log('');
  console.log('  HEDEF EDGE      GEREKEN ISLEM     su anki hizla ~sure');
  console.log('  ' + '-'.repeat(60));
  const islemPerGun = ortN / gunSayisi;
  for (const hedef of [0.30, 0.20, 0.15, 0.10, 0.05]) {
    const gerekenN = Math.pow((1.96 * ortSd) / hedef, 2);
    const gun = gerekenN / islemPerGun;
    console.log(
      `  ${fmt(hedef, 2).padEnd(14)}  ${Math.round(gerekenN).toString().padStart(10)}` +
        `        ${(gun / 365).toFixed(1)} yil veri`,
    );
  }
  console.log('');
  console.log(`  (su anki hiz: ${islemPerGun.toFixed(1)} islem/gun, ${loaded.length} sembolde)`);
  console.log('');

  console.log('='.repeat(80));
  console.log('NASIL OKUNMALI');
  console.log('='.repeat(80));
  console.log('  Aranan edge iki duvarin da ustunde olmak zorunda:');
  console.log('   - Maliyet duvarindan kucukse, strateji dogru tahmin etse bile');
  console.log('     komisyon+kayma onu negatife cevirir.');
  console.log('   - Tespit duvarindan kucukse, gercekten var olsa bile bunu');
  console.log('     KANITLAYAMAYIZ; %95 esigi asla gecilmez.');
  console.log('');
  console.log('  Maliyet duvari yuksekse cozum "daha iyi strateji" DEGILDIR:');
  console.log('   - stop/hedef olcegini buyut (daha az, daha buyuk islem)');
  console.log('   - taker yerine MAKER emirle gir (komisyon %0.05 -> %0.02)');
  console.log('   - daha likit sembol / daha dusuk kayma');
  console.log('');
  console.log('  Tespit duvari yuksekse cozum daha cok VERI:');
  console.log('   - daha uzun gecmis (npm run data ile yillar geriye)');
  console.log('   - daha cok sembol');
}

main();
