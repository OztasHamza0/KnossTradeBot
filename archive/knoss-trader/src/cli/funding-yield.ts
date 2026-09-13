import { getFunding, FundingPoint } from '../data/funding';

/**
 * DELTA-NOTR FONLAMA HASADI — gecmis getiri olcumu.
 *
 * Islem: spot al + ayni buyuklukte perpetual short. Fiyat riski nötr.
 * Fonlama pozitifken short taraf tahsil eder; negatifken oder.
 *
 * BEDAVA PARA DEGIL. Hepsi hesaba katiliyor:
 *   - Iki bacakta giris + cikis komisyonu (spot taker %0.10, futures %0.05)
 *   - Fonlama NEGATIFE dondugunde odeme yapilmasi
 *   - Sermayenin IKI bacakta birden bagli olmasi (getiri toplam sermayeye gore)
 *
 * Hesaba KATILMAYAN riskler (rapor sonunda aciklaniyor): likidasyon, bacak
 * senkron kaybi, borsa riski, spot-perp baz kaymasi.
 */

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'AVAXUSDT', 'LINKUSDT',
];

const DAYS = 365;

/** Giris+cikis, iki bacak. Spot taker %0.10, futures taker %0.05. */
const ROUND_TRIP_COST_PCT = (0.1 + 0.05) * 2;

/**
 * Sermaye carpani: 1 birim pozisyon icin ne kadar sermaye baglanir.
 * Spot tarafi 1 birim; perp short icin marj gerekir. 3x marjla 0.33,
 * yani toplam ~1.33. Muhafazakar olmak icin 1.5 aliniyor (marj tamponu).
 */
const CAPITAL_MULTIPLIER = 1.5;

const pct = (n: number, d = 2) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';

interface Result {
  symbol: string;
  periods: number;
  /** Donem oranlarinin toplami (%). Pozitif = short tahsil etti. */
  grossPct: number;
  netPct: number;
  /** Sermayeye gore yillik net (%). */
  annualOnCapitalPct: number;
  positivePeriods: number;
  worstPeriodPct: number;
  bestPeriodPct: number;
  /** En kotu ust uste negatif seri (donem sayisi). */
  worstNegativeStreak: number;
}

function analyze(symbol: string, data: FundingPoint[]): Result {
  const grossPct = data.reduce((s, p) => s + p.rate * 100, 0);
  const netPct = grossPct - ROUND_TRIP_COST_PCT;
  const days = data.length / 3; // 8 saatte bir -> gunde 3 donem
  const annualOnPosition = (netPct / days) * 365;

  let streak = 0;
  let worstStreak = 0;
  for (const p of data) {
    if (p.rate < 0) {
      streak++;
      worstStreak = Math.max(worstStreak, streak);
    } else streak = 0;
  }

  return {
    symbol,
    periods: data.length,
    grossPct,
    netPct,
    annualOnCapitalPct: annualOnPosition / CAPITAL_MULTIPLIER,
    positivePeriods: data.filter((p) => p.rate > 0).length,
    worstPeriodPct: Math.min(...data.map((p) => p.rate * 100)),
    bestPeriodPct: Math.max(...data.map((p) => p.rate * 100)),
    worstNegativeStreak: worstStreak,
  };
}

async function main() {
  console.log(`\nDELTA-NOTR FONLAMA HASADI — son ${DAYS} gun\n`);
  console.log(
    'Islem: spot al + ayni buyuklukte perp short. Fiyat riski notr,\n' +
      'gelir 8 saatlik fonlama. Maliyet: iki bacakta gidis-donus ' +
      `%${ROUND_TRIP_COST_PCT.toFixed(2)}.\n` +
      `Getiri, IKI bacakta bagli sermayeye gore (carpan ${CAPITAL_MULTIPLIER}x).\n`,
  );

  const results: Result[] = [];
  for (const s of SYMBOLS) {
    process.stdout.write(`  ${s} ... `);
    try {
      const data = await getFunding(s, DAYS);
      if (data.length === 0) {
        console.log('veri yok');
        continue;
      }
      results.push(analyze(s, data));
      console.log(`${data.length} donem`);
    } catch (e: any) {
      console.log(`HATA: ${e?.message}`);
    }
  }

  if (results.length === 0) {
    console.error('Hicbir sembol icin veri alinamadi.');
    process.exit(1);
  }

  console.log('');
  console.log(
    'SEMBOL'.padEnd(10) + 'DONEM'.padStart(7) + 'BRUT'.padStart(9) +
      'NET'.padStart(9) + 'YILLIK*'.padStart(10) + 'POZ.DONEM'.padStart(11) +
      'EN KOTU'.padStart(10) + 'NEG.SERI'.padStart(10),
  );
  console.log('-'.repeat(76));

  for (const r of results.sort((a, b) => b.annualOnCapitalPct - a.annualOnCapitalPct)) {
    console.log(
      r.symbol.replace('USDT', '').padEnd(10) +
        String(r.periods).padStart(7) +
        pct(r.grossPct, 1).padStart(9) +
        pct(r.netPct, 1).padStart(9) +
        pct(r.annualOnCapitalPct, 1).padStart(10) +
        `${((r.positivePeriods / r.periods) * 100).toFixed(0)}%`.padStart(11) +
        pct(r.worstPeriodPct, 3).padStart(10) +
        String(r.worstNegativeStreak).padStart(10),
    );
  }
  console.log('-'.repeat(76));
  console.log('* sermayeye gore yillik net getiri\n');

  const avgAnnual =
    results.reduce((s, r) => s + r.annualOnCapitalPct, 0) / results.length;
  const positive = results.filter((r) => r.annualOnCapitalPct > 0).length;

  console.log(
    `Ortalama yillik net getiri: ${pct(avgAnnual, 1)}  ` +
      `(${positive}/${results.length} sembolde pozitif)\n`,
  );

  if (avgAnnual > 8) {
    console.log(
      'DEGERLENDIRME: Anlamli ve pozitif. Bu bir tahmin degil tahsilat —\n' +
        'oran ilan ediliyor, istatistiksel kanit gerekmiyor. Bir sonraki adim\n' +
        'RISKLERI modellemek, getiriyi degil.',
    );
  } else if (avgAnnual > 0) {
    console.log(
      'DEGERLENDIRME: Pozitif ama ince. Komisyon ve marj tamponu dusuldukten\n' +
        'sonra kalan, tasinan riske deger mi ayrica tartisilmali.',
    );
  } else {
    console.log(
      'DEGERLENDIRME: Negatif. Bu donemde fonlama hasadi para KAYBETTIRIRDI.',
    );
  }

  console.log(
    '\nHESABA KATILMAYAN RISKLER — bunlar getiriyi degil, hayatta kalmayi belirler:\n' +
      '  1. LIKIDASYON. Short bacak fiyat yukselirse zarar eder; spot kari onu\n' +
      '     karsilar ama karsilik BASKA cuzdanda. Marj yetmezse perp likide olur\n' +
      '     ve notrluk bozulur — bu, stratejinin tek gercek olum sekli.\n' +
      '  2. BACAK SENKRONU. Iki emir ayni anda dolmazsa aradaki sure boyunca\n' +
      '     ciplak pozisyon tasirsin.\n' +
      '  3. ORAN SIFIRA GIDER. Bu islem kalabaliklastikca fonlama baskilanir;\n' +
      '     gecmis getiri gelecegi bagladmaz.\n' +
      '  4. BORSA RISKI. Sermayenin tamami tek borsada durur.\n',
  );
}

main().catch((e) => {
  console.error('HATA:', e?.message ?? e);
  process.exit(1);
});

/**
 * KOSULLU HASAT — yalnizca fonlama cazipken pozisyonda dur.
 *
 * Naif versiyon (her zaman pozisyonda) negatif donemleri de yiyor. Akillisi:
 * son N donemin ortalamasi esigin uzerindeyse gir, altina duserse cik.
 * Bedeli her giris-cikista komisyon odemek; faydasi negatif serilerden
 * kacinmak. Hangisi agir basiyor - olcelim.
 *
 * Esik taramasi yapiliyor cunku tek bir esik secip "iste calisiyor" demek
 * tam da bu projede elediğimiz hata olurdu.
 */
export function conditionalYield(
  data: FundingPoint[],
  lookback: number,
  thresholdPct: number,
  roundTripCostPct: number,
): { netPct: number; entries: number; periodsHeld: number } {
  let net = 0;
  let entries = 0;
  let held = 0;
  let inPosition = false;

  for (let i = lookback; i < data.length; i++) {
    // Karar YALNIZCA gecmise bakar: i. donemin orani henuz odenmeden
    // pozisyon karari verilir.
    let sum = 0;
    for (let j = i - lookback; j < i; j++) sum += data[j].rate;
    const trailingAvgPct = (sum / lookback) * 100;

    const want = trailingAvgPct > thresholdPct;

    if (want && !inPosition) {
      net -= roundTripCostPct;
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

  return { netPct: net, entries, periodsHeld: held };
}
