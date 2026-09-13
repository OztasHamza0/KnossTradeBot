import { loadBars } from '../data/binance';
import { walkForward, WF_DEFAULTS } from '../backtest/walkforward';
import { measureShape, BaselineShape } from '../backtest/sweep';
import { runBacktest } from '../backtest/engine';
import { ALL_STRATEGIES } from '../strategies/registry';
import { randomBaseline } from '../strategies/random-baseline';
import { Strategy, DEFAULT_CONFIG } from '../backtest/types';

/**
 * ILERI-YURUYEN DOGRULAMA — "bu YONTEMI kullansaydim ne olurdu".
 *
 * Sabit %70/%30 ayrimi tek bir donem hakkinda konusur. Gercekte strateji
 * bir kez secilip sonsuza kadar kosulmaz; periyodik olarak yeniden secilir.
 * Bu arac tam o SURECI olcer: her dilimde yalnizca o ana kadarki veriye
 * bakarak bir aday secer, secileni BIR SONRAKI dilimde kosar, ilerler.
 *
 * KRITIK NOKTA — KONTROL GRUBU AYNI SEKILDE SECILIR.
 *   12 aday arasindan "en iyi"yi secmek, hicbirinde edge olmasa bile
 *   pozitif bir egilim uretir: egitim doneminde sansi yaver giden secilir.
 *   Bu yanlilik YONTEMIN kendisinde vardir, stratejide degil.
 *   O yuzden taban da 12 YAZI-TURA arasindan ayni kuralla secilir.
 *   Soru "strateji yazi-turayi geciyor mu" degil:
 *   **"12 strateji arasindan secmek, 12 yazi-tura arasindan secmekten
 *   iyi mi"**.
 *
 * Kullanim: npm run walkforward -- 1h [dilim] [tabanTekrari]
 */

const interval = process.argv[2] ?? '1h';
const FOLDS = parseInt(process.argv[3] ?? String(WF_DEFAULTS.folds), 10);
/** Taban kac kez (farkli tohum kumeleriyle) tekrarlanacak. */
const TABAN_TEKRAR = parseInt(process.argv[4] ?? '30', 10);

/** Taramanin AYARLANDIGI semboller — strateji ve parametreler bunlara bakti. */
const AYAR_SEMBOLLERI = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

/**
 * HIC DOKUNULMAMIS semboller — hipotez testinin gercek yeri.
 *
 * luck-test.ts ile ayni kume. Tarama bunlari hic gormedi; hicbir parametre,
 * hicbir strateji secimi bunlara bakilarak yapilmadi. Ayar sembollerinde
 * iyi gorunup burada cokmek, asiri uydurmanin ders kitabi tanimidir.
 */
const DOKUNULMAMIS = [
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

/** 4. arguman 'oos' ise dokunulmamis sembollerde kosar. */
const SEMBOL_KUMESI = process.argv[5] === 'oos' ? 'DOKUNULMAMIS' : 'AYAR';
const SYMBOLS = SEMBOL_KUMESI === 'DOKUNULMAMIS' ? DOKUNULMAMIS : AYAR_SEMBOLLERI;

/**
 * KOMISYON ve KAYMA AYRI AYRI verilebilir — ve AYRI SEYLERDIR.
 *
 * Komisyon indirimi (VIP kademesi, kampanya, referans) yalnizca komisyonu
 * dusurur; KAYMAYI dusurmez. Kayma emir defterinin derinligiyle ilgilidir
 * ve senin hesabinla ilgisi yoktur.
 *
 * Ikisini "maliyet" diye tek sayida toplamak, komisyon indirimi olan bir
 * kullanicida yaniltir: maliyetin bir kismi indirilebilir, bir kismi
 * indirilemez. O yuzden ayri parametreler.
 *
 * Kullanim: npx ts-node src/cli/walkforward.ts 4h 6 40 oos 0.01 0.02
 *                                              ^  ^ ^   ^   ^    ^
 *                                       aralik  | tekrar |  komisyon kayma
 */
const FEE = process.argv[6] !== undefined ? parseFloat(process.argv[6]) : DEFAULT_CONFIG.feePct;
const SLIP = process.argv[7] !== undefined ? parseFloat(process.argv[7]) : DEFAULT_CONFIG.slippagePct;
const CFG = { ...DEFAULT_CONFIG, feePct: FEE, slippagePct: SLIP };

const fmt = (n: number, d = 3) =>
  Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(d) : '   ?  ';

function ortalama(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function stdSapma(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = ortalama(xs);
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

  const N_ADAY = ALL_STRATEGIES.length;

  console.log('='.repeat(78));
  console.log('ILERI-YURUYEN (WALK-FORWARD) DOGRULAMA');
  console.log('='.repeat(78));
  console.log(`Zaman dilimi : ${interval}`);
  console.log(`Semboller    : ${loaded.length}  [${SEMBOL_KUMESI}]`);
  console.log(`Komisyon     : %${FEE}/yon   kayma: %${SLIP}/yon`);
  console.log(`Dilim        : ${FOLDS}  (ilk %${WF_DEFAULTS.ilkEgitimOrani * 100} egitim)`);
  console.log(`Aday havuzu  : ${N_ADAY} strateji`);
  console.log(`Kontrol      : ${N_ADAY} yazi-tura, AYNI secim kurali, GEOMETRI ESLESMELI, ${TABAN_TEKRAR} tekrar`);
  console.log('');
  console.log('Her dilimde YALNIZCA o ana kadarki veriye bakilarak bir aday');
  console.log('secilir, secilen BIR SONRAKI dilimde kosulur. Asagidaki islemler');
  console.log('secim aninda GORULMEMIS islemlerdir.');
  console.log('');

  /**
   * HER SEMBOL x HER ADAY icin olculen stop/hedef geometrisi.
   *
   * Kontrol grubu bunlari taklit edecek. Onceden hesaplaniyor cunku
   * TABAN_TEKRAR kez yeniden olcmek gereksiz — geometri tohumdan bagimsiz.
   */
  const SEKILLER: Record<string, BaselineShape[]> = {};
  for (const { symbol, bars } of loaded) {
    SEKILLER[symbol] = ALL_STRATEGIES.map((e) => {
      const tr = runBacktest(e.factory(), bars, symbol, interval, CFG).trades;
      return measureShape(tr, bars);
    });
  }

  // --- GERCEK ADAYLAR ---
  const gercekBeklentiler: number[] = [];
  let gercekIslem = 0;
  const gercekSecimler: Record<string, number> = {};

  console.log('SEMBOL      TEST ISLEM   BEKLENTI   SECILEN ADAYLAR');
  console.log('-'.repeat(78));

  for (const { symbol, bars } of loaded) {
    const adaylar = ALL_STRATEGIES.map((e) => ({ key: e.key, strat: e.factory() }));
    const r = walkForward(adaylar, bars, symbol, interval, { folds: FOLDS, cfg: CFG });
    gercekBeklentiler.push(r.beklentiR);
    gercekIslem += r.toplamTestIslem;
    for (const [k, v] of Object.entries(r.secimDagilimi)) {
      gercekSecimler[k] = (gercekSecimler[k] ?? 0) + v;
    }
    const secimOzet = Object.entries(r.secimDagilimi)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}x${v}`)
      .join(' ');
    console.log(
      symbol.padEnd(12) +
        String(r.toplamTestIslem).padStart(10) +
        fmt(r.beklentiR).padStart(11) +
        '   ' + secimOzet.slice(0, 44),
    );
  }
  console.log('-'.repeat(78));

  const gercekOrt = ortalama(gercekBeklentiler);
  console.log(`ORTALAMA BEKLENTI (gercek adaylar): ${fmt(gercekOrt)} R  (${gercekIslem} islem)`);
  console.log('');

  // --- KONTROL: AYNI SECIM KURALI, YAZI-TURA HAVUZU ---
  console.log(`Kontrol grubu kosuluyor (${TABAN_TEKRAR} tekrar)...`);
  const tabanOrtalamalari: number[] = [];

  for (let t = 0; t < TABAN_TEKRAR; t++) {
    const semboIsi: number[] = [];
    for (const { symbol, bars } of loaded) {
      // Havuz gercek havuzla AYNI BUYUKLUKTE: secim yanliligi ayni olsun.
      // Tohum ve islem sikligi birlikte degisiyor — yalnizca tohum
      // degistirmek dagilimi yapay olarak daraltir (luck-test dersi).
      const adaylar: { key: string; strat: Strategy }[] = [];
      for (let i = 0; i < N_ADAY; i++) {
        const seed = 5000 + t * 991 + i * 37;
        // GEOMETRI ESLESTIRMESI — kontrol grubunun i. uyesi, gercek
        // havuzun i. uyesinin OLCULEN stop/hedef yapisini taklit eder.
        //
        // Ilk surumde kontrol havuzunun HEPSI sabit 1.5 ATR / R:R 2 idi.
        // Bu, tam olarak projenin measureShape ile ogrendigi hatanin
        // yeni bir yuzuydu: gercek havuzda geometriler cesitli (1.0-3.0
        // ATR), ve secim, GENIS stopu olan bir adayi secerek islem
        // sayisini dusurebilir — az islem, az komisyon, daha iyi gorunen
        // beklenti. Kontrol havuzu o cesitlilige sahip degilse, olculen
        // "ustunluk" beceri degil GEOMETRI SECIMI olur.
        //
        // Artik kontrol havuzu ayni geometri dagilimina sahip: secim
        // yanliligi da geometri avantaji da her iki tarafta esit.
        const sh = SEKILLER[symbol]?.[i] ?? { stopAtr: 1.5, rr: 2, tradeEveryN: 20 };
        adaylar.push({
          key: `yt${i}`,
          strat: randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr),
        });
      }
      const r = walkForward(adaylar, bars, symbol, interval, { folds: FOLDS, cfg: CFG });
      semboIsi.push(r.beklentiR);
    }
    tabanOrtalamalari.push(ortalama(semboIsi));
    if ((t + 1) % 10 === 0) process.stdout.write(`\r  ${t + 1}/${TABAN_TEKRAR}...`);
  }
  process.stdout.write('\r' + ' '.repeat(30) + '\r');

  tabanOrtalamalari.sort((a, b) => a - b);
  const tabanOrt = ortalama(tabanOrtalamalari);
  const tabanSd = stdSapma(tabanOrtalamalari);
  const yuzdelik =
    (tabanOrtalamalari.filter((x) => x < gercekOrt).length / tabanOrtalamalari.length) * 100;

  console.log('KONTROL GRUBU (12 yazi-tura arasindan AYNI kuralla secim):');
  console.log(`  ortalama   ${fmt(tabanOrt)} R`);
  console.log(`  std sapma  ${fmt(tabanSd)} R`);
  console.log(`  en kotu    ${fmt(tabanOrtalamalari[0])} R`);
  console.log(`  ortanca    ${fmt(tabanOrtalamalari[Math.floor(TABAN_TEKRAR / 2)])} R`);
  console.log(`  en iyi     ${fmt(tabanOrtalamalari[TABAN_TEKRAR - 1])} R`);
  console.log('');

  console.log('='.repeat(78));
  console.log('SONUC');
  console.log('='.repeat(78));
  console.log(`  gercek adaylar : ${fmt(gercekOrt)} R`);
  console.log(`  yazi-tura      : ${fmt(tabanOrt)} R`);
  console.log(`  fark           : ${fmt(gercekOrt - tabanOrt)} R`);
  console.log(`  YUZDELIK       : %${yuzdelik.toFixed(0)}`);
  console.log('');

  if (yuzdelik >= 95) {
    console.log('  >> Secim yontemi sans dagilimindan AYRISIYOR. Bakmaya deger.');
    console.log('     (Yine de: kac konfigurasyon denendigini hesaba kat.)');
  } else if (yuzdelik >= 75) {
    console.log('  >> Ust dilimde ama %95 esigini gecmiyor. Ayrisma YOK.');
  } else {
    console.log('  >> Secim yontemi, AYNI KURALLA secilen yazi-turalardan');
    console.log('     ayrismiyor. Yani "12 strateji arasindan en iyisini sec"');
    console.log('     kurali, "12 yazi-tura arasindan en iyisini sec"den');
    console.log('     daha iyi bir sonuc uretmiyor.');
  }
  console.log('');
  console.log('  Not: taban NEGATIF cikiyorsa bu normaldir — secim yanliligi');
  console.log('  egitim doneminde pozitif gorunen adayi secer, ama komisyon ve');
  console.log('  kayma test doneminde onu asagi ceker. Onemli olan gercek');
  console.log('  adaylarin bu SAPMAYI asip asmadigi.');
  console.log('');

  const enCokSecilen = Object.entries(gercekSecimler).sort((a, b) => b[1] - a[1]);
  console.log('En cok secilen adaylar (tum sembol x dilim):');
  for (const [k, v] of enCokSecilen.slice(0, 6)) {
    console.log(`  ${k.padEnd(20)} ${v} kez`);
  }
  console.log('');
  console.log('  Secim savruluyorsa (hep farkli aday seciliyorsa), egitim');
  console.log('  donemindeki "en iyi" gurultudur — kalici bir ustunluk yok.');
}

main();
