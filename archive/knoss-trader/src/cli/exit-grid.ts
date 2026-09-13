import { loadBars } from '../data/binance';
import { Bar } from '../data/types';
import { evaluate, judge } from '../backtest/sweep';
import { BacktestConfig, DEFAULT_CONFIG, Strategy } from '../backtest/types';
import { randomBaseline } from '../strategies/random-baseline';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { tsMomentum } from '../strategies/ts-momentum';
import { emaPullback } from '../strategies/ema-pullback';

/**
 * GERI CEKILME CIKISI — TAM IZGARA.
 *
 * Onceki tarama tetik esigini duzgun taramamisti: yalnizca dort nokta
 * (%50, %60, %70, %80) denenmisti. Kullanicinin sorusu hakliydi — "yakinlik
 * %90, %99 da olabilirdi."
 *
 * IZGARA GENISLEDIKCE EN IYI HUCRE SANSLA IYILESIR. 25 hucrede, hicbirinde
 * edge olmasa bile en iyisinin beklenen yuzdeligi 25/26 = %96. Bu yuzden
 * burada TEK BIR HUCREYE BAKILMAZ.
 *
 * BAKILACAK SEY YUZEYIN SEKLI:
 *   Gercek bir duzenlilik KABA olur — komsu ayarlarda da gorunur, yani
 *   izgarada tutarli bir BOLGE olusturur. Gurultu ise tek tuk parlayan,
 *   komsusuyla ilgisiz hucreler uretir. Ayni mantik robustness.ts'te giris
 *   parametreleri icin kullaniliyor; burada cikis parametrelerine
 *   uygulaniyor.
 *
 * Ve her hucrede iki sayi var: stratejinin kendi beklentisi ve TABANDAN
 * AYRISMA. Onceki taramada ogrenildi ki "fark" bazen strateji kotulesirken
 * bile buyuyor — cunku ayni kural yazi-turayi daha cok cezalandiriyor.
 * O yuzden ikisi birden basiliyor.
 *
 * Kullanim:  npm run exit-grid -- 1h
 */

const SEMBOLLER = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

/** Dokunulmamis kontrol grubu — yuzeyde bir sey gorunurse buraya bakilir. */
const DOKUNULMAMIS = [
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

const interval = process.argv[2] ?? '1h';
const dokunulmamisMi = process.argv.includes('--dokunulmamis');
const KULLANILAN = dokunulmamisMi ? DOKUNULMAMIS : SEMBOLLER;

/** Tetik esikleri: "hedefe ne kadar yaklasti". */
const TETIK = [0.5, 0.6, 0.7, 0.8, 0.9, 0.99];
/** Cikis esikleri: "kaca geri donunce kapat". */
const CIKIS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];

const STRATEJILER: { ad: string; yap: () => Strategy }[] = [
  {
    ad: 'donchian-20',
    yap: () => donchianBreakout({ lookback: 20, atrPeriod: 14, stopAtr: 3, rr: 3, trendEma: 200 }),
  },
  { ad: 'ts-momentum', yap: () => tsMomentum() },
  {
    ad: 'ema-pullback 21/55',
    yap: () => emaPullback({ fast: 21, slow: 55, pull: 9, atrPeriod: 14, stopAtr: 1.5, rr: 2 }),
  },
];

const fmt = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);

(async () => {
  const yuklu: { symbol: string; bars: Bar[] }[] = [];
  for (const s of KULLANILAN) {
    try {
      const b = loadBars(s, interval);
      if (b && b.length > 500) yuklu.push({ symbol: s, bars: b });
    } catch {
      /* veri yok */
    }
  }
  if (yuklu.length < 4) {
    console.error(`${interval} icin veri yok. Once: npm run data`);
    process.exit(1);
  }

  console.log('='.repeat(96));
  console.log(
    `GERI CEKILME IZGARASI — ${interval}, ${yuklu.length} ` +
      `${dokunulmamisMi ? 'DOKUNULMAMIS' : 'standart'} sembol`,
  );
  console.log('Satir = tetik esigi (hedefe yakinlik) | Sutun = cikis esigi (geri donus)');
  console.log('Bakilacak sey TEK HUCRE DEGIL, YUZEYIN SEKLI: gercek duzenlilik');
  console.log('komsu ayarlarda da gorunur ve tutarli bir BOLGE olusturur.');
  console.log('='.repeat(96));

  const olc = (yap: () => Strategy, cfg: BacktestConfig) => {
    const cells = yuklu.map(({ symbol, bars }) =>
      evaluate(
        yap(),
        (sh, seed) => randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr),
        bars,
        symbol,
        interval,
        cfg,
      ),
    );
    const v = judge('x', cells);
    const taban =
      cells.reduce((s, c) => s + c.baselineOos.expectancyR, 0) / cells.length;
    return { strateji: v.avgOosExpectancy, taban, fark: v.avgEdge, islem: v.totalOosTrades };
  };

  for (const { ad, yap } of STRATEJILER) {
    const kontrol = olc(yap, { ...DEFAULT_CONFIG, exit: { kind: 'sabit' } });

    console.log('');
    console.log(
      `${ad}   —   KONTROL (sabit cikis): strateji ${fmt(kontrol.strateji)} R, ` +
        `taban ${fmt(kontrol.taban)} R, fark ${fmt(kontrol.fark)} R`,
    );

    // --- Yuzey 1: stratejinin KENDI beklentisindeki degisim ---
    console.log('');
    console.log('  STRATEJININ KENDI BEKLENTISINDEKI DEGISIM (kontrole gore)');
    console.log('  tetik \\ cikis' + CIKIS.map((c) => `%${(c * 100).toFixed(0)}`.padStart(8)).join(''));
    const kendi: number[][] = [];
    const farklar: number[][] = [];
    for (const t of TETIK) {
      const satirKendi: number[] = [];
      const satirFark: number[] = [];
      const goster: string[] = [];
      for (const c of CIKIS) {
        if (c >= t) {
          satirKendi.push(NaN);
          satirFark.push(NaN);
          goster.push('     — ');
          continue;
        }
        const r = olc(yap, {
          ...DEFAULT_CONFIG,
          exit: { kind: 'geri-cekilme', activateAtPct: t, exitAtPct: c },
        });
        satirKendi.push(r.strateji - kontrol.strateji);
        satirFark.push(r.fark - kontrol.fark);
        goster.push(fmt(r.strateji - kontrol.strateji).padStart(8));
      }
      kendi.push(satirKendi);
      farklar.push(satirFark);
      console.log(`  %${(t * 100).toFixed(0)}`.padEnd(15) + goster.join(''));
    }

    // --- Yuzey 2: tabandan ayrismadaki degisim ---
    console.log('');
    console.log('  TABANDAN AYRISMADAKI DEGISIM (kontrole gore)');
    console.log('  tetik \\ cikis' + CIKIS.map((c) => `%${(c * 100).toFixed(0)}`.padStart(8)).join(''));
    TETIK.forEach((t, i) => {
      const goster = farklar[i].map((v) => (Number.isNaN(v) ? '     — ' : fmt(v).padStart(8)));
      console.log(`  %${(t * 100).toFixed(0)}`.padEnd(15) + goster.join(''));
    });

    // --- Yuzeyin sekli hakkinda sayilar ---
    const duz = kendi.flat().filter((v) => Number.isFinite(v));
    const duzF = farklar.flat().filter((v) => Number.isFinite(v));
    const arti = duz.filter((v) => v > 0).length;
    const artiF = duzF.filter((v) => v > 0).length;
    console.log('');
    console.log(
      `  ${duz.length} hucre  |  stratejiyi iyilestiren: ${arti}/${duz.length}` +
        `  |  ayrismayi artiran: ${artiF}/${duzF.length}` +
        `  |  sans olsaydi: ${Math.round(duz.length / 2)}/${duz.length}`,
    );
  }

  console.log('');
  console.log('='.repeat(96));
  console.log('NASIL OKUNMALI');
  console.log('-'.repeat(96));
  console.log('Gercek bir etki, izgarada TUTARLI BIR BOLGE olusturur — komsu ayarlar');
  console.log('da ayni yone gider. Isaretler karisik ve komsular ilgisizse, gordugumuz');
  console.log('sey gurultudur.');
  console.log('');
  console.log('30 hucre denenince, HICBIRINDE edge olmasa bile en iyisinin beklenen');
  console.log('yuzdeligi 30/31 = %97. En iyi hucreyi secip "iste bu" demek, bu');
  console.log('projede eledigimiz hatanin ta kendisi olurdu.');
  console.log('');
  console.log('Yuzeyde tutarli bir bolge gorunurse siradaki adim:');
  console.log('  npm run exit-grid -- ' + interval + ' --dokunulmamis');
})();
