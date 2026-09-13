import { loadBars } from '../data/binance';
import { evaluate, judge } from '../backtest/sweep';
import { Strategy } from '../backtest/types';
import { randomBaseline } from '../strategies/random-baseline';

import { emaPullback } from '../strategies/ema-pullback';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { meanReversion } from '../strategies/mean-reversion';
import { volSqueeze } from '../strategies/vol-squeeze';
import { tsMomentum } from '../strategies/ts-momentum';
import { rangeBounce } from '../strategies/range-bounce';
import { rsiDivergence } from '../strategies/rsi-divergence';
import { sessionBreakout } from '../strategies/session-breakout';
import { volumeThrust } from '../strategies/volume-thrust';
import { mtfTrend } from '../strategies/mtf-trend';

/**
 * HIPOTEZ TESTI: "1.5 ATR stop / R:R 2 varsayilani butun stratejileri
 * sakatladi; genis stop ve yuksek R:R sonucu duzeltir."
 *
 * Bu hipotez bir onceki taramanin GORULMEMIS verisine bakilarak uretildi,
 * yani o veri artik kirlendi. Bu yuzden test TAMAMEN YENI sembollerde
 * yapiliyor: AVAX, ATOM, NEAR, LTC, DOT, UNI, FIL, APT — hicbiri daha once
 * hicbir olcumde kullanilmadi.
 *
 * KRITIK KONTROL: genis stop islem sayisini dusurur, bu da komisyon yukunu
 * azaltir. Yani yazi-tura BILE genis stopla "iyilesir". O yuzden her
 * strateji, KENDI YAPISINDAKI yazi-turayla kiyaslaniyor. Bakilacak sayi
 * mutlak beklenti degil, TABAN FARKI (edge). Edge artmiyorsa bulgu sadece
 * maliyet dususudur, edge degildir.
 */

const interval = process.argv[2] ?? '1h';

/** Onceki hicbir olcumde kullanilmamis semboller. */
const FRESH_SYMBOLS = [
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

/** stopAtr ve rr alan stratejiler. */
type Build = (stopAtr: number, rr: number) => Strategy;

const WITH_RR: { key: string; build: Build }[] = [
  { key: 'ema-pullback', build: (s, r) => emaPullback({ fast: 50, slow: 200, pull: 20, atrPeriod: 14, stopAtr: s, rr: r }) },
  { key: 'donchian-55', build: (s, r) => donchianBreakout({ lookback: 55, atrPeriod: 14, stopAtr: s, rr: r, trendEma: 200 }) },
  { key: 'donchian-20', build: (s, r) => donchianBreakout({ lookback: 20, atrPeriod: 14, stopAtr: s, rr: r, trendEma: 200 }) },
  { key: 'ts-momentum', build: (s, r) => tsMomentum({ shortLb: 12, midLb: 48, longLb: 168, atrPeriod: 14, stopAtr: s, rr: r }) },
  { key: 'vol-squeeze', build: (s, r) => volSqueeze({ ...(volSqueezeDefaults()), stopAtr: s, rr: r }) },
  { key: 'rsi-divergence', build: (s, r) => rsiDivergence({ ...(rsiDefaults()), stopAtr: s, rr: r }) },
  { key: 'session-breakout', build: (s, r) => sessionBreakout({ ...(sessionDefaults()), stopAtr: s, rr: r }) },
  { key: 'volume-thrust', build: (s, r) => volumeThrust({ ...(thrustDefaults()), stopAtr: s, rr: r }) },
  { key: 'mtf-trend', build: (s, r) => mtfTrend({ ...(mtfDefaults()), stopAtr: s, rr: r }) },
];

/** Hedefi yapisal olan stratejiler — rr uygulanamaz, yalnizca stop degisir. */
const STOP_ONLY: { key: string; build: (stopAtr: number) => Strategy }[] = [
  { key: 'mean-reversion', build: (s) => meanReversion({ ...(mrDefaults()), stopAtr: s }) },
  { key: 'range-bounce', build: (s) => rangeBounce({ ...(rbDefaults()), stopAtr: s }) },
];

// Varsayilanlari dosyalardan almak yerine burada yeniden uretmek yerine,
// her modulun DEFAULT_* sabitini import etmek daha dogru olurdu; ancak
// isimler moduller arasi degistigi icin kucuk yardimcilarla aliniyor.
function volSqueezeDefaults() { return require('../strategies/vol-squeeze').DEFAULT_VOL_SQUEEZE; }
function rsiDefaults() { return require('../strategies/rsi-divergence').DEFAULT_RSI_DIVERGENCE; }
function sessionDefaults() { return require('../strategies/session-breakout').DEFAULT_SESSION_BREAKOUT; }
function thrustDefaults() { return require('../strategies/volume-thrust').DEFAULT_VOLUME_THRUST; }
function mtfDefaults() { return require('../strategies/mtf-trend').DEFAULT_MTF_TREND; }
function mrDefaults() { return require('../strategies/mean-reversion').DEFAULT_MEAN_REVERSION; }
function rbDefaults() { return require('../strategies/range-bounce').DEFAULT_RANGE_BOUNCE; }

const OLD = { stopAtr: 1.5, rr: 2, label: 'dar  (1.5 ATR / R:R 2)' };
const NEW = { stopAtr: 3.0, rr: 3, label: 'genis (3.0 ATR / R:R 3)' };

const fmt = (n: number, d = 3) => (Number.isFinite(n) ? (n >= 0 ? '+' : '') + n.toFixed(d) : '—');

function main() {
  const loaded = FRESH_SYMBOLS.map((s) => ({ symbol: s, bars: loadBars(s, interval) })).filter(
    (x): x is { symbol: string; bars: NonNullable<ReturnType<typeof loadBars>> } =>
      x.bars !== null && x.bars.length > 0,
  );

  if (loaded.length === 0) {
    console.error(`${interval} icin yeni sembol verisi yok.`);
    process.exit(1);
  }

  console.log(`\nHIPOTEZ TESTI — ${interval}, ${loaded.length} DOKUNULMAMIS sembol`);
  console.log(`  ${loaded.map((l) => l.symbol.replace('USDT', '')).join(', ')}`);
  console.log(
    '\nHipotez: dar stop butun stratejileri sakatladi.\n' +
      'Kontrol: her yapi KENDI yazi-turasiyla kiyaslaniyor — cunku genis stop\n' +
      'islem sayisini dusurup yazi-turayi bile iyilestirir.\n',
  );

  const run = (strat: Strategy, stopAtr: number, rr: number) => {
    const base = randomBaseline(42, 20, stopAtr, rr);
    // BURADA taban BILEREK eslestirilmiyor: bu aracin isi zaten farkli
    // stop yapilarini birbiriyle kiyaslamak, yani yapi bagimsiz degisken.
    // Otomatik eslestirme, olculmek istenen farki ortadan kaldirirdi.
    const cells = loaded.map(({ symbol, bars }) =>
      evaluate(strat, () => base, bars, symbol, interval),
    );
    return judge(strat.name, cells);
  };

  // Once tabanin kendisi ne kadar iyilesiyor — asil kiyas noktasi bu.
  const baseOld = run(randomBaseline(7, 20, OLD.stopAtr, OLD.rr), OLD.stopAtr, OLD.rr);
  const baseNew = run(randomBaseline(7, 20, NEW.stopAtr, NEW.rr), NEW.stopAtr, NEW.rr);
  console.log(
    `TABANIN KENDISI:  dar ${fmt(baseOld.avgOosExpectancy)} R  →  ` +
      `genis ${fmt(baseNew.avgOosExpectancy)} R   ` +
      `(yazi-tura ${fmt(baseNew.avgOosExpectancy - baseOld.avgOosExpectancy)} R iyilesti)\n`,
  );

  console.log(
    'STRATEJI'.padEnd(18) +
      'DAR beklenti'.padStart(13) + 'DAR edge'.padStart(10) +
      'GENIS beklenti'.padStart(15) + 'GENIS edge'.padStart(12) +
      'EDGE DEGISIMI'.padStart(15) + 'ISLEM'.padStart(9) + '  KARAR',
  );
  console.log('-'.repeat(110));

  let edgeImproved = 0;
  let total = 0;
  const rows: { key: string; dEdge: number; newEdge: number; newExp: number; trades: number; verdict: string }[] = [];

  const emit = (key: string, oldV: ReturnType<typeof judge>, newV: ReturnType<typeof judge>) => {
    const dEdge = newV.avgEdge - oldV.avgEdge;
    if (dEdge > 0) edgeImproved++;
    total++;
    rows.push({ key, dEdge, newEdge: newV.avgEdge, newExp: newV.avgOosExpectancy, trades: newV.totalOosTrades, verdict: newV.verdict });
    console.log(
      key.padEnd(18) +
        fmt(oldV.avgOosExpectancy).padStart(13) +
        fmt(oldV.avgEdge).padStart(10) +
        fmt(newV.avgOosExpectancy).padStart(15) +
        fmt(newV.avgEdge).padStart(12) +
        fmt(dEdge).padStart(15) +
        String(newV.totalOosTrades).padStart(9) +
        '  ' + newV.verdict,
    );
  };

  for (const s of WITH_RR) {
    emit(s.key, run(s.build(OLD.stopAtr, OLD.rr), OLD.stopAtr, OLD.rr),
                run(s.build(NEW.stopAtr, NEW.rr), NEW.stopAtr, NEW.rr));
  }
  for (const s of STOP_ONLY) {
    emit(s.key + ' *', run(s.build(OLD.stopAtr), OLD.stopAtr, OLD.rr),
                       run(s.build(NEW.stopAtr), NEW.stopAtr, NEW.rr));
  }

  console.log('-'.repeat(110));
  console.log('* hedefi yapisal (orta bant / karsi kenar) — R:R uygulanamaz, yalnizca stop degisti\n');

  console.log(`EDGE ${edgeImproved}/${total} stratejide arttı.\n`);

  // judge()'un kararina uyuluyor: 'umutlu' disindakiler islem sayisi ya da
  // tutarlilik testinden gecmemistir. Bu satiri atlamak, asiri uydurmaya
  // karsi kurulan korumayi rapor asamasinda delmek olurdu — ilk denemede
  // tam olarak bu oldu ve 2 islemlik bir hucre '+0.504 edge' diye listelendi.
  const winners = rows
    .filter((r) => r.verdict === 'umutlu')
    .sort((a, b) => b.newEdge - a.newEdge);

  // Once ORNEKLEM yeterli mi. Bu kontrol sonradan eklendi: 4 saatlikte
  // gecerken 11 satirin 11'i de "yetersiz-veri" iken arac yine de
  // "Hipotez YANLIS" hukmu basiyordu. Olculemeyen bir seyi yanlislamak,
  // dogrulamak kadar hatalidir — az veriden cikan edge farklari gurultudur.
  const measurable = rows.filter((r) => r.verdict !== 'yetersiz-veri').length;

  if (measurable < total * 0.4) {
    console.log(
      `SONUC: KARAR VERILEMEZ. ${total} stratejiden yalnizca ${measurable}'inde\n` +
        'yeterli islem var. Genis stop bu zaman diliminde o kadar az islem\n' +
        'uretiyor ki hipotez ne dogrulanabiliyor ne yanlislanabiliyor.\n' +
        'Bu da bir bulgudur: olculemeyen bir yapiyla canliya cikilmaz.',
    );
  } else if (edgeImproved >= total * 0.7) {
    console.log(
      'SONUC: Hipotez DOGRULANDI. Genis stop yalnizca maliyeti dusurmuyor,\n' +
        'stratejilerin tabana gore ustunlugunu de artiriyor. Dar stop gercekten\n' +
        'sistematik bir sakatlamaymis.',
    );
  } else if (edgeImproved <= total * 0.3) {
    console.log(
      'SONUC: Hipotez YANLIS. Mutlak sayilar iyilesse bile edge artmiyor —\n' +
        'yani gorulen iyilesme sadece komisyon dususu. Stratejilerin sinyal\n' +
        'kalitesi degismedi.',
    );
  } else {
    console.log(
      'SONUC: Kismi. Bazi stratejilerde edge artiyor, bazilarinda artmiyor —\n' +
        'yapi tek basina aciklamiyor.',
    );
  }

  if (winners.length) {
    console.log(`\nGenis yapida tabandan ayrisan ${winners.length} strateji:`);
    for (const w of winners) {
      console.log(
        `  ${w.key.padEnd(18)} beklenti ${fmt(w.newExp)} R, ` +
          `edge ${fmt(w.newEdge)} R, ${w.trades} islem`,
      );
    }
  } else {
    console.log('\nGenis yapida bile tabandan anlamli ayrisan strateji YOK.');
  }
  console.log('');
}

main();
