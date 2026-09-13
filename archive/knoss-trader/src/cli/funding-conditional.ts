import { getFunding, FundingPoint } from '../data/funding';

/**
 * KOSULLU FONLAMA HASADI — gorulmemis veri ayrimiyla.
 *
 * NEDEN AYRI ARAC: conditionalYield() funding-yield.ts icinde yazilmis ama
 * HIC CAGRILMIYORDU. Yani "fonlama hasadi yillik %1.4-8.3, riske degmez"
 * sonucumuz yalnizca NAIF surumun (hep pozisyonda) olcumuydu. Kosullu
 * surum — yalnizca fonlama cazipken pozisyonda dur — hic olculmedi.
 *
 * ESIK SECMEK BIR PARAMETRE ARAMASIDIR. Bir esik taranip en iyisi
 * secilirse, o sayi gecmise uydurulmus olur; bu projede tam olarak bu
 * hatayi eledigimiz icin arac bastan OOS ayrimiyla yaziliyor:
 *
 *   - Esik ve pencere, verinin ILK %70'inde secilir
 *   - Karar, SON %30'a bakilarak verilir
 *   - Ve secilen esik, o donemde NAIF surumu gecebiliyor mu diye sorulur
 *
 * Kiyas noktasi "sifirdan buyuk mu" DEGIL: naif surum zaten var ve
 * bedava. Kosullu surumun isi naif surumu GECMEK; gecemiyorsa eklenen
 * karmasiklik bosuna.
 *
 * Kullanim:  npm run funding-conditional
 */

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT',
];

const DAYS = 365;
const OOS_FRACTION = 0.3;

/**
 * Iki bacakta giris + cikis komisyonu (spot taker %0.10, futures %0.05).
 * funding-yield.ts ile AYNI sayi olmali; ayrisirsa iki arac ayni seyi
 * olcmuyor demektir.
 */
const ROUND_TRIP_COST_PCT = (0.1 + 0.05) * 2;

/**
 * Spot tarafi 1 birim; perp short icin marj gerekir. Muhafazakar 1.5.
 * Getiri BAGLANAN SERMAYEYE gore raporlanmali, tek bacaga gore degil.
 */
const CAPITAL_MULTIPLIER = 1.5;

/** Taranacak esikler (%, 8 saatlik oran) ve pencereler (donem). */
const THRESHOLDS = [0, 0.002, 0.005, 0.008, 0.01, 0.015, 0.02, 0.03];
const LOOKBACKS = [3, 6, 9, 21, 63];

/**
 * Kosullu hasat. conditionalYield() ile ayni mantik, ama burada kopyasi
 * duruyor cunku o fonksiyon funding-yield.ts'in icinde ve o dosya CLI
 * olarak kosuyor (import etmek tum raporu calistirirdi).
 *
 * Karar YALNIZCA gecmise bakar: i. donemin orani henuz odenmeden pozisyon
 * karari verilir.
 */
function kosullu(
  data: FundingPoint[],
  lookback: number,
  thresholdPct: number,
): { netPct: number; entries: number; held: number; periods: number } {
  let net = 0;
  let entries = 0;
  let held = 0;
  let inPosition = false;

  for (let i = lookback; i < data.length; i++) {
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += data[j].rate;
    const trailingAvgPct = (sum / lookback) * 100;

    const want = trailingAvgPct > thresholdPct;

    if (want && !inPosition) {
      net -= ROUND_TRIP_COST_PCT;
      entries++;
      inPosition = true;
    } else if (!want && inPosition) {
      inPosition = false;
    }

    if (inPosition) {
      net += data[i].rate * 100;
      held++;
    }
  }

  return { netPct: net, entries, held, periods: data.length - lookback };
}

/** Naif surum: bastan sona pozisyonda. Kiyas noktasi bu. */
function naif(data: FundingPoint[]): number {
  const gross = data.reduce((s, d) => s + d.rate * 100, 0);
  return gross - ROUND_TRIP_COST_PCT;
}

/** Donem getirisini baglanan sermayeye gore yillige cevirir. */
const yillik = (netPct: number, periods: number) =>
  periods > 0
    ? (netPct / CAPITAL_MULTIPLIER) * ((365 * 3) / periods)
    : NaN;

(async () => {
  console.log('='.repeat(78));
  console.log(`KOSULLU FONLAMA HASADI — ${SYMBOLS.length} sembol, ${DAYS} gun`);
  console.log(`Esik ve pencere ILK %70'te secilir, karar SON %30'a gore.`);
  console.log('='.repeat(78));

  const veri: { symbol: string; is: FundingPoint[]; oos: FundingPoint[] }[] = [];
  for (const s of SYMBOLS) {
    process.stdout.write(`  ${s.padEnd(10)} `);
    try {
      const d = await getFunding(s, DAYS);
      if (!d || d.length < 200) {
        console.log('veri yetersiz');
        continue;
      }
      const cut = Math.floor(d.length * (1 - OOS_FRACTION));
      veri.push({ symbol: s, is: d.slice(0, cut), oos: d.slice(cut) });
      console.log(`${d.length} donem (${cut} secim / ${d.length - cut} gorulmemis)`);
    } catch (e: any) {
      console.log(`HATA: ${e?.message}`);
    }
  }

  if (!veri.length) {
    console.error('Veri alinamadi.');
    process.exit(1);
  }

  // --- 1) Esik/pencere secimi: YALNIZCA ilk %70 ---
  console.log('');
  console.log('SECIM DONEMI (ilk %70) — sembol ortalamasi yillik net %');
  console.log('pencere ' + THRESHOLDS.map((t) => `%${t}`.padStart(8)).join(''));
  let best = { lookback: 0, threshold: 0, score: -Infinity };
  for (const lb of LOOKBACKS) {
    const satir: string[] = [];
    for (const th of THRESHOLDS) {
      const skor =
        veri.reduce((s, v) => {
          const r = kosullu(v.is, lb, th);
          return s + yillik(r.netPct, r.periods);
        }, 0) / veri.length;
      satir.push(skor.toFixed(1).padStart(8));
      if (skor > best.score) best = { lookback: lb, threshold: th, score: skor };
    }
    console.log(String(lb).padStart(7) + satir.join(''));
  }

  console.log('');
  console.log(
    `Secilen: pencere ${best.lookback} donem, esik %${best.threshold} ` +
      `(secim doneminde yillik %${best.score.toFixed(1)})`,
  );

  // --- 2) Karar: GORULMEMIS son %30 ---
  console.log('');
  console.log('GORULMEMIS DONEM (son %30)');
  console.log('-'.repeat(78));
  console.log(
    'SEMBOL'.padEnd(10) + 'KOSULLU'.padStart(10) + 'NAIF'.padStart(10) +
      'FARK'.padStart(10) + 'GIRIS'.padStart(8) + 'POZ.SURE'.padStart(10),
  );

  let toplamK = 0;
  let toplamN = 0;
  let gecen = 0;
  for (const v of veri) {
    const r = kosullu(v.oos, best.lookback, best.threshold);
    const kY = yillik(r.netPct, r.periods);
    const nY = yillik(naif(v.oos), v.oos.length);
    toplamK += kY;
    toplamN += nY;
    if (kY > nY) gecen++;
    console.log(
      v.symbol.replace('USDT', '').padEnd(10) +
        `${kY.toFixed(1)}%`.padStart(10) +
        `${nY.toFixed(1)}%`.padStart(10) +
        `${(kY - nY >= 0 ? '+' : '') + (kY - nY).toFixed(1)}`.padStart(10) +
        String(r.entries).padStart(8) +
        `${((r.held / Math.max(1, r.periods)) * 100).toFixed(0)}%`.padStart(10),
    );
  }
  const ortK = toplamK / veri.length;
  const ortN = toplamN / veri.length;
  console.log('-'.repeat(78));
  console.log(
    'ORTALAMA'.padEnd(10) +
      `${ortK.toFixed(1)}%`.padStart(10) +
      `${ortN.toFixed(1)}%`.padStart(10) +
      `${(ortK - ortN >= 0 ? '+' : '') + (ortK - ortN).toFixed(1)}`.padStart(10),
  );

  console.log('');
  console.log('SONUC');
  console.log('-'.repeat(78));
  console.log(`kosullu, gorulmemis donemde yillik net : %${ortK.toFixed(1)}`);
  console.log(`naif    , ayni donemde                  : %${ortN.toFixed(1)}`);
  console.log(`kosullu naifi kac sembolde geciyor      : ${gecen}/${veri.length}`);
  console.log('');
  if (ortK <= ortN) {
    console.log('KOSULLU HASAT NAIFI GECMIYOR. Eklenen karmasiklik bosuna:');
    console.log('esik secmek, gecmise uydurmaktan baska bir sey yapmiyor.');
  } else if (ortK < 10) {
    console.log('Naiften iyi ama mutlak getiri hala ince. Hesaba KATILMAYAN');
    console.log('riskler (likidasyon, bacak senkron kaybi, borsa riski,');
    console.log('spot-perp baz kaymasi) bu farki rahatlikla yer.');
  } else {
    console.log('Gorulmemis donemde anlamli ve naiften iyi. Bir sonraki adim:');
    console.log('dokunulmamis sembollerde ve daha uzun gecmiste dogrulama.');
  }
  console.log('');
  console.log('DIKKAT: bu bir FIYAT TAHMINI degil, aritmetik. Ama hesaba');
  console.log('katilmayan riskler gercek ve fonlama kalabaliklastikca erir.');
})();
