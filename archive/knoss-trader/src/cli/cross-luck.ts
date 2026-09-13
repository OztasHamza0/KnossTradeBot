import { loadBars } from '../data/binance';
import { Bar } from '../data/types';
import { Strategy } from '../backtest/types';
import { evaluate } from '../backtest/sweep';
import { buildRanks } from '../backtest/cross-section';
import { crossMomentum, DEFAULT_CROSS_MOMENTUM } from '../strategies/cross-momentum';
import { randomBaseline } from '../strategies/random-baseline';

/**
 * KESITSEL SANS TESTI — kesitsel hipotezin HAKEMI.
 *
 * Kesitsel tarama, 4 saatlikte bir varyanti "umutlu" isaretledi. Ama o
 * tarama sirasinda alti varyant denendi, ve daha oncesinde tek varlik
 * tarafinda elli kusur konfigurasyon. ELLI KEZ DENERSEN, HICBIRINDE EDGE
 * OLMASA BILE BIRI IYI GORUNUR.
 *
 * Cozum teorik degil ampirik: BILINEN SEKILDE EDGE'SIZ stratejilerin
 * (yazi-tura) dagilimi cikarilir ve aday o dagilimin neresine dusuyor
 * diye bakilir. Ve bu, adayin HIC UYARLANMADIGI sembollerde yapilir —
 * kesitsel taramada olcum yapilan 8 sembol bilerek disarida birakilmisti.
 *
 * SIRALAMA EVRENI yine TUM sembollerden kurulur: canlida da oyle olur, ve
 * evreni daraltmak stratejiyi olculdugunden farkli bir sey yapar hale
 * getirirdi. Dokunulmamis olan OLCUM, siralama girdisi degil.
 *
 * Kullanim:  npm run cross-luck -- 4h 50
 */

/** Kesitsel taramada HIC OLCUM YAPILMAYAN semboller. */
const DOKUNULMAMIS = [
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

/** Siralama evrenini tamamlayan, taramada olculen semboller. */
const EVREN_EK = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

const interval = process.argv[2] ?? '4h';
const N = parseInt(process.argv[3] ?? '50', 10);

/** Taramada "umutlu" cikan aday. */
const ADAY = { ...DEFAULT_CROSS_MOMENTUM };

(async () => {
  const evren: Record<string, Bar[]> = {};
  for (const s of [...DOKUNULMAMIS, ...EVREN_EK]) {
    try {
      const b = loadBars(s, interval);
      if (b && b.length > 500) evren[s] = b;
    } catch {
      /* veri yok — evren biraz daralir, olcum yine yapilir */
    }
  }
  const olculecek = DOKUNULMAMIS.filter((s) => evren[s]);
  if (olculecek.length < 4) {
    console.error(`${interval} icin yeterli veri yok. Once: npm run data`);
    process.exit(1);
  }

  const ranks = buildRanks(evren, ADAY.lookback);

  /**
   * Bir stratejinin dokunulmamis sembollerdeki ortalama OOS beklentisi.
   *
   * Taban burada onemsiz (yalnizca outOfSample okunuyor) ama evaluate
   * imzasi geregi veriliyor; adayla AYNI yapida veriliyor ki iki kosu
   * arasinda tek fark strateji olsun.
   */
  const beklenti = (yap: (symbol: string) => Strategy): number => {
    const cells = olculecek.map((symbol) =>
      evaluate(
        yap(symbol),
        (sh) => randomBaseline(7, sh.tradeEveryN, sh.stopAtr, sh.rr),
        evren[symbol],
        symbol,
        interval,
      ),
    );
    return (
      cells.reduce((s, c) => s + c.outOfSample.expectancyR, 0) / cells.length
    );
  };

  console.log('='.repeat(72));
  console.log(
    `KESITSEL SANS TESTI — ${interval}, ${olculecek.length} DOKUNULMAMIS sembol`,
  );
  console.log(
    `siralama evreni ${Object.keys(evren).length} sembol | ` +
      `aday: kesitsel momentum ${ADAY.lookback} mum, uc %${ADAY.edgePct * 100}`,
  );
  console.log('='.repeat(72));
  console.log('');
  console.log(`${N} farkli yazi-tura kosuluyor (edge'i BILINEN SEKILDE sifir).`);

  const nulls: number[] = [];
  for (let i = 0; i < N; i++) {
    /**
     * Hem tohum hem islem sikligi degisiyor. Yalnizca tohumu degistirmek
     * dagilimi YAPAY OLARAK DARALTIR: tum kosular ayni sayida islem
     * uretir, yani ayni komisyon yukunu tasir ve varyansin bir kaynagi
     * yok sayilir.
     */
    const seed = 1000 + i * 37;
    const every = 15 + (i % 11);
    nulls.push(
      beklenti(() =>
        randomBaseline(seed, every, ADAY.stopAtr, ADAY.rr),
      ),
    );
    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${N}`);
  }
  console.log('');

  const srt = [...nulls].sort((a, b) => a - b);
  const q = (p: number) => srt[Math.min(srt.length - 1, Math.floor(srt.length * p))];
  const ort = nulls.reduce((a, b) => a + b, 0) / nulls.length;

  console.log('');
  console.log("SANS DAGILIMI (edge'siz stratejilerin beklentisi):");
  for (const [ad, v] of [
    ['en kotu', srt[0]], ['%25', q(0.25)], ['ortanca', q(0.5)],
    ['ortalama', ort], ['%75', q(0.75)], ['%90', q(0.9)],
    ['%95', q(0.95)], ['en iyi', srt[srt.length - 1]],
  ] as [string, number][]) {
    console.log(`  ${ad.padEnd(10)} ${(v >= 0 ? '+' : '') + v.toFixed(3)} R`);
  }

  const adayBeklenti = beklenti((symbol) => crossMomentum(ranks[symbol], ADAY));
  const yuzdelik = (nulls.filter((v) => v < adayBeklenti).length / nulls.length) * 100;

  console.log('');
  console.log('-'.repeat(72));
  console.log(
    `ADAY (kesitsel momentum)   ${(adayBeklenti >= 0 ? '+' : '') + adayBeklenti.toFixed(3)} R` +
      `   ${yuzdelik.toFixed(0)}. yuzdelik`,
  );
  console.log('-'.repeat(72));
  console.log('');

  if (yuzdelik >= 95) {
    console.log('Sans dagiliminin DISINDA. Bakmaya deger — ama tek basina');
    console.log('yeterli degil: bu noktaya gelene kadar denenen konfigurasyon');
    console.log('sayisi elliyi asti. Bir sonraki adim daha uzun gecmis.');
  } else if (yuzdelik >= 75) {
    console.log('Ust dilimde ama AYRISMIYOR. %95 esigi kasitli olarak sert.');
  } else {
    console.log('ORTALAMA BIR YAZI-TURADAN FARKSIZ.');
    console.log('');
    console.log('Kesitsel hipotez sinifi da elendi. Tek varlik yonlu');
    console.log('tahmin ve varliklar arasi goreli guc — yapisal olarak');
    console.log('farkli iki sinif, ikisinde de gosterilebilir edge yok.');
  }
})();
