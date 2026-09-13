import { loadBars } from '../data/binance';
import { evaluate } from '../backtest/sweep';
import { Strategy } from '../backtest/types';
import { randomBaseline } from '../strategies/random-baseline';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { volumeThrust, DEFAULT_VOLUME_THRUST } from '../strategies/volume-thrust';
import { tsMomentum } from '../strategies/ts-momentum';

/**
 * SANS TESTI — bu projenin en onemli olcumu.
 *
 * Sorun su: bu noktaya gelene kadar 12 strateji, 2 zaman dilimi, 2 stop
 * yapisi ve cesitli parametre varyantlari denendi. Elli kusur konfigurasyon.
 * ELLI KEZ DENERSEN, HICBIRINDE EDGE OLMASA BILE BIRI IYI GORUNUR. Buna
 * coklu karsilastirma tuzagi denir ve tam bu asamada insanlari kandirir:
 * "en iyi adayimiz +0.024 R" cumlesi, o adayin elli kisilik bir yarismanin
 * birincisi oldugu soylenmeden anlamsizdir.
 *
 * Cozum teorik degil ampirik: yazi-turayi N farkli tohumla kosturup
 * BILINEN SEKILDE EDGE'SIZ stratejilerin dagilimini cikariyoruz. Adayimiz
 * o dagilimin neresine dusuyor?
 *
 *   - %50 civarinda  -> ortalama bir yazi-turadan farksiz. Sans.
 *   - %95 uzerinde   -> sans dagilimindan ayrisiyor. Bakmaya deger.
 *
 * Bu test bir stratejiyi kanitlayamaz, ama yalanlayabilir — ve bu asamada
 * yalanlamak daha degerli.
 */

const interval = process.argv[2] ?? '1h';
const N = parseInt(process.argv[3] ?? '50', 10);

/** Hipotez testinde kullanilan, onceki turlarda hic kullanilmamis semboller. */
const SYMBOLS = [
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

/** Kazanan adayin kostugu yapi — karsilastirma ayni yapida olmali. */
const STOP_ATR = 3;
const RR = 3;

const fmt = (n: number, d = 3) => (n >= 0 ? '+' : '') + n.toFixed(d);

function main() {
  const loaded = SYMBOLS.map((s) => ({ symbol: s, bars: loadBars(s, interval) })).filter(
    (x): x is { symbol: string; bars: NonNullable<ReturnType<typeof loadBars>> } =>
      x.bars !== null && x.bars.length > 0,
  );

  if (loaded.length === 0) {
    console.error(`${interval} icin veri yok.`);
    process.exit(1);
  }

  /** Bir stratejinin 8 semboldeki ortalama gorulmemis beklentisi. */
  const expectancyOf = (strat: Strategy): number => {
    const cells = loaded.map(({ symbol, bars }) =>
      evaluate(strat, (sh, seed) => randomBaseline(seed, sh.tradeEveryN, sh.stopAtr, sh.rr), bars, symbol, interval),
    );
    return cells.reduce((s, c) => s + c.outOfSample.expectancyR, 0) / cells.length;
  };

  console.log(
    `\nSANS TESTI — ${interval}, ${loaded.length} sembol, stop ${STOP_ATR} ATR / R:R ${RR}`,
  );
  console.log(
    `${N} farkli tohumla yazi-tura kosuluyor. Bunlarin HICBIRINDE edge yok;\n` +
      'ureten sey saf sans. Adayimiz bu dagilimin neresine dusuyor?\n',
  );

  /**
   * SANS DAGILIMI ADAYIN KENDI GEOMETRISINDE KURULUR.
   *
   * ONCEKI HALI YANLISTI ve bu, projenin EN BELIRLEYICI olcumunu
   * gecersiz kiliyordu:
   *
   *  - Tarama (`npm run sweep`) kazanan adayi **stop 2 ATR / R:R 2** ile
   *    buluyordu (tsMomentum varsayilani).
   *  - Sans testi ise ayni stratejiyi **stop 3 ATR / R:R 3** ile kurup
   *    olcuyordu (STOP_ATR/RR sabitleri).
   *
   * Yani "ts-momentum 50. yuzdelik, sans" hukmu, taramadan CIKAN adaya
   * degil BASKA BIR STRATEJIYE verilmisti. Kazanan hic sinanmamisti.
   *
   * Ustelik geometri, sonucu dogrudan oynatir — bu ders `measureShape`
   * ile zaten ogrenilmisti: genis stop islem sayisini dusurur, komisyon
   * yuku duser ve yazi-tura BILE "iyilesir". Kontrol grubu adayla ayni
   * geometride kosmazsa fark, beceriyi degil geometriyi olcer.
   *
   * Artik her adayin kendi (stopAtr, rr) ikilisi icin ayri bir null
   * dagilimi kuruluyor ve aday KENDI dagilimiyla kiyaslaniyor.
   */
  const nullCache = new Map<string, number[]>();
  const nullDagilimi = (stopAtr: number, rr: number): number[] => {
    const key = `${stopAtr}/${rr}`;
    const hazir = nullCache.get(key);
    if (hazir) return hazir;

    const arr: number[] = [];
    for (let i = 0; i < N; i++) {
      // Tohum ve islem sikligi birlikte degistiriliyor: yalnizca tohum
      // degistirmek, ayni mumlarda islem acan cok benzer kosular uretir ve
      // dagilimi yapay olarak daraltir.
      const seed = 1000 + i * 37;
      const every = 15 + (i % 11);
      arr.push(expectancyOf(randomBaseline(seed, every, stopAtr, rr)));
      if ((i + 1) % 10 === 0) {
        process.stdout.write(`\r  ${key}: ${i + 1}/${N} kosu...`);
      }
    }
    arr.sort((a, b) => a - b);
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    nullCache.set(key, arr);
    return arr;
  };

  const nulls = nullDagilimi(STOP_ATR, RR);

  const pct = (p: number) => nulls[Math.min(nulls.length - 1, Math.floor(nulls.length * p))];
  const mean = nulls.reduce((a, b) => a + b, 0) / nulls.length;

  console.log('SANS DAGILIMI (edge'.concat("'siz stratejilerin beklentisi):"));
  console.log(`  en kotu    ${fmt(nulls[0])} R`);
  console.log(`  %25        ${fmt(pct(0.25))} R`);
  console.log(`  ortanca    ${fmt(pct(0.5))} R`);
  console.log(`  ortalama   ${fmt(mean)} R`);
  console.log(`  %75        ${fmt(pct(0.75))} R`);
  console.log(`  %90        ${fmt(pct(0.9))} R`);
  console.log(`  %95        ${fmt(pct(0.95))} R`);
  console.log(`  en iyi     ${fmt(nulls[nulls.length - 1])} R`);
  console.log('');

  /**
   * Her adayin GEOMETRISI acikca yaziliyor — cunku null dagilimi ona gore
   * kuruluyor. Sabit STOP_ATR/RR kullanmak, taramanin sectigi adayi degil
   * baska bir stratejiyi sinamak demekti.
   */
  const candidates: { name: string; stopAtr: number; rr: number; strat: Strategy }[] = [
    // TARAMANIN SECTIGI ADAY — kendi konfigurasyonuyla (2 ATR / R:R 2).
    // Bu satir yoktu: sweep 2/2 ile kazanani buluyor, sans testi ayni
    // stratejiyi 3/3 ile oluyordu. Kazanan hic sinanmamisti.
    {
      name: 'ts-momentum 2/2*',
      stopAtr: 2, rr: 2,
      strat: tsMomentum({
        shortLb: 12, midLb: 48, longLb: 168, atrPeriod: 14, stopAtr: 2, rr: 2,
      }),
    },
    // CANLIDA KOSAN konfigurasyon — bu da hic sinanmamisti.
    {
      name: 'donchian-20 CANLI',
      stopAtr: 3, rr: 3,
      strat: donchianBreakout({
        lookback: 20, atrPeriod: 14, stopAtr: 3, rr: 3, trendEma: 200,
      }),
    },
    {
      name: 'donchian-55',
      stopAtr: STOP_ATR, rr: RR,
      strat: donchianBreakout({
        lookback: 55, atrPeriod: 14, stopAtr: STOP_ATR, rr: RR, trendEma: 200,
      }),
    },
    {
      name: 'volume-thrust',
      stopAtr: STOP_ATR, rr: RR,
      strat: volumeThrust({ ...DEFAULT_VOLUME_THRUST, stopAtr: STOP_ATR, rr: RR }),
    },
    {
      name: 'ts-momentum 3/3',
      stopAtr: STOP_ATR, rr: RR,
      strat: tsMomentum({
        shortLb: 12, midLb: 48, longLb: 168, atrPeriod: 14, stopAtr: STOP_ATR, rr: RR,
      }),
    },
  ];

  console.log('ADAY [stop/rr]'.padEnd(26) + 'BEKLENTI'.padStart(10) + 'YUZDELIK'.padStart(11) + '  YORUM');
  console.log('-'.repeat(70));

  for (const c of candidates) {
    const exp = expectancyOf(c.strat);
    // ADAYIN KENDI GEOMETRISINDEKI dagilim — sabit bir dagilim degil.
    const kendiNull = nullDagilimi(c.stopAtr, c.rr);
    const beaten = kendiNull.filter((n) => n < exp).length;
    const percentile = (beaten / kendiNull.length) * 100;

    const comment =
      percentile >= 95
        ? 'sans dagiliminin disinda — bakmaya deger'
        : percentile >= 75
          ? 'ust dilimde ama ayrismiyor'
          : percentile >= 40
            ? 'ORTALAMA BIR YAZI-TURADAN FARKSIZ'
            : 'yazi-turanin ALTINDA';

    console.log(
      (c.name + ' [' + c.stopAtr + '/' + c.rr + ']').padEnd(26) +
        fmt(exp).padStart(10) +
        (percentile.toFixed(0) + '%').padStart(11) + '  ' + comment,
    );
  }
  console.log('-'.repeat(70));

  console.log(
    '\nNasil okunmali: yuzdelik, adayin kac yazi-turayi gectigini soyluyor.\n' +
      '%50 demek "rastgele stratejilerin yarisi bundan iyi" demektir — yani\n' +
      'elde bir sey yok. Anlamli sayilmak icin en az %95 gerekir, ve o bile\n' +
      'elli konfigurasyon denendikten sonra tek basina yeterli degildir.',
  );
  console.log('');
}

main();
