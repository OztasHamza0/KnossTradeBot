import { loadBars } from '../data/binance';
import { runGrid, DEFAULT_GRID, GridConfig } from '../backtest/grid';

/**
 * IZGARA EKSENI — sekizinci hipotez sinifi.
 *
 * Izgara yon tahmin etmez, salinimdan kazanir ve limit (maker) emir
 * kullanir. Yedi eksenin tikandigi iki yer de burada farkli.
 *
 * AMA: izgara kisa gammadir. Kucuk ve sik kazanir, seyrek ve BUYUK
 * kaybeder. O yuzden bakilacak sayi getiri DEGIL, getiri ile MAX DUSUS
 * birlikte. "%40 kazandi" cumlesi, yolda %60 dustuyse hicbir sey ifade etmez.
 *
 * KARSILASTIRMA SART: ayni donemde hicbir sey yapmamak (nakit) ve
 * al-tut ne getirdi? Izgara bunlari gecemiyorsa ugrasmaya degmez.
 */

const interval = process.argv[2] ?? '4h';

const AYAR = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','LINKUSDT'];
const DOKUNULMAMIS = ['AVAXUSDT','ATOMUSDT','NEARUSDT','LTCUSDT','DOTUSDT','UNIUSDT','FILUSDT','APTUSDT'];

const fmt = (n: number, d = 1) => (n >= 0 ? '+' : '') + n.toFixed(d);

function kosu(semboller: string[], cfg: GridConfig, etiket: string) {
  console.log('');
  console.log(etiket);
  console.log('  SEMBOL'.padEnd(14) + 'DOLUM'.padStart(8) + 'GETIRI%'.padStart(10) +
              'MAXDUSUS%'.padStart(11) + 'AL-TUT%'.padStart(10) + 'KOMISYON'.padStart(10));
  console.log('  ' + '-'.repeat(60));
  let iflasSayisi = 0;
  const getiriler: number[] = [];
  const dususler: number[] = [];
  const altutlar: number[] = [];
  for (const s of semboller) {
    const bars = loadBars(s, interval);
    if (!bars || bars.length < 100) continue;
    const r = runGrid(bars, cfg);
    const altut = ((bars[bars.length-1].close - bars[0].close) / bars[0].close) * 100;
    getiriler.push(r.getiriPct); dususler.push(r.maxDusus); altutlar.push(altut);
    if (r.iflas) iflasSayisi++;
    console.log(
      '  ' + s.padEnd(12) + String(r.dolum).padStart(8) +
      fmt(r.getiriPct).padStart(10) + r.maxDusus.toFixed(1).padStart(11) +
      fmt(altut).padStart(10) + (r.iflas ? '  IFLAS (mum ' + r.iflasBar + ')' : '  hayatta'),
    );
  }
  const ort = (x: number[]) => x.reduce((a,b)=>a+b,0)/(x.length||1);
  console.log('  ' + '-'.repeat(60));
  console.log('  ORTALAMA'.padEnd(22) + fmt(ort(getiriler)).padStart(10) +
              ort(dususler).toFixed(1).padStart(11) + fmt(ort(altutlar)).padStart(10));
  console.log('  IFLAS: ' + iflasSayisi + '/' + getiriler.length + ' sembolde hesap sifirlandi');
  return { getiri: ort(getiriler), dusus: ort(dususler), altut: ort(altutlar), iflas: iflasSayisi };
}

function main() {
  const yillar = (() => {
    const b = loadBars('BTCUSDT', interval);
    return b ? (b[b.length-1].openTime - b[0].openTime)/86400000/365 : 0;
  })();

  console.log('='.repeat(72));
  console.log('SEKIZINCI EKSEN — IZGARA (GRID)');
  console.log('='.repeat(72));
  console.log(`Zaman dilimi: ${interval}  |  ${yillar.toFixed(1)} yil  |  maker %${DEFAULT_GRID.makerFeePct}`);
  console.log('Izgara yon TAHMIN ETMEZ. Salinimdan kazanir, trendde kaybeder.');
  console.log('Bakilacak sayi getiri DEGIL — getiri ILE max dusus birlikte.');

  const varyantlar: { ad: string; cfg: GridConfig }[] = [
    { ad: 'dar (%3, 20 seviye, disari cikinca YENIDEN)', cfg: { ...DEFAULT_GRID, rangePct: 3 } },
    { ad: 'orta (%5, 20 seviye, YENIDEN)', cfg: { ...DEFAULT_GRID, rangePct: 5 } },
    { ad: 'genis (%10, 20 seviye, YENIDEN)', cfg: { ...DEFAULT_GRID, rangePct: 10 } },
    { ad: 'orta + disari cikinca KES (stoplu)', cfg: { ...DEFAULT_GRID, rangePct: 5, disariCikinca: 'kes' } },
    { ad: 'orta + disari cikinca BEKLE (klasik)', cfg: { ...DEFAULT_GRID, rangePct: 5, disariCikinca: 'bekle' } },
  ];

  console.log('');
  console.log('#'.repeat(72));
  console.log('AYAR SEMBOLLERI');
  console.log('#'.repeat(72));
  const ayarSonuc: { ad: string; g: number; d: number }[] = [];
  for (const v of varyantlar) {
    const r = kosu(AYAR, v.cfg, '  >> ' + v.ad);
    ayarSonuc.push({ ad: v.ad, g: r.getiri, d: r.dusus });
  }

  console.log('');
  console.log('#'.repeat(72));
  console.log('DOKUNULMAMIS SEMBOLLER — asil sinav');
  console.log('#'.repeat(72));
  for (const v of varyantlar) kosu(DOKUNULMAMIS, v.cfg, '  >> ' + v.ad);

  console.log('');
  console.log('='.repeat(72));
  console.log('NASIL OKUNMALI');
  console.log('='.repeat(72));
  console.log(`  Donem ${yillar.toFixed(1)} yil. Getiriyi yila bolmek gerekir.`);
  console.log('  Izgara al-tuttan iyi degilse ve max dususu buyukse, ugrasmaya degmez.');
  console.log('  "BEKLE" varyanti klasik izgaradir ve trendde ne oldugunu gosterir.');
}

main();
