import { loadBars } from '../data/binance';
import { Bar, } from '../data/types';
import { evaluate, judge } from '../backtest/sweep';
import { BacktestConfig, DEFAULT_CONFIG, ExitRule, Strategy } from '../backtest/types';
import { randomBaseline } from '../strategies/random-baseline';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { tsMomentum } from '../strategies/ts-momentum';
import { emaPullback } from '../strategies/ema-pullback';

/**
 * CIKIS KURALI TARAMASI — hic bakilmamis eksen.
 *
 * 12 stratejinin hepsinde GIRIS kurali degistirildi; CIKIS mekanizmasi hep
 * ayni kaldi: sabit stop, sabit hedef, hangisi once gelirse. Stop mesafesi
 * ve R:R oraninin DEGERLERI degistirildi ama MEKANIZMA hic degistirilmedi.
 *
 * ASIL SORU BU DEGIL: "kural sonucu iyilestiriyor mu?"
 * ASIL SORU BU: "kural stratejiyi, YAZI-TURAYI iyilestirdiginden DAHA FAZLA
 * iyilestiriyor mu?"
 *
 * Cunku bir cikis kurali odeme dagilimini degistirir — kazanma oranini
 * yukseltip ortalama kazanci dusurur. Rastgele girişte bile "daha iyi"
 * gorunebilir. Saf bir rastgele yuruyuste HICBIR durma kurali beklentiyi
 * degistirmez; degistiriyorsa, fiyat yolunda somurulebilir bir yapi var
 * demektir. Onu ancak ayni kurali kontrol grubuna da uygulayarak goruruz.
 *
 * Bu yuzden tabloda uc sutun var: strateji, taban, ve FARK. Bakilacak sutun
 * FARK.
 *
 * Kullanim:  npm run exit-sweep -- 1h
 */

const SEMBOLLER = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
];

const interval = process.argv[2] ?? '1h';

const STRATEJILER: { ad: string; yap: () => Strategy }[] = [
  {
    ad: 'donchian-20 (canlida kosan)',
    yap: () => donchianBreakout({ lookback: 20, atrPeriod: 14, stopAtr: 3, rr: 3, trendEma: 200 }),
  },
  { ad: 'ts-momentum (tek ayakta kalan)', yap: () => tsMomentum() },
  { ad: 'ema-pullback 21/55', yap: () => emaPullback({ fast: 21, slow: 55, pull: 9, atrPeriod: 14, stopAtr: 1.5, rr: 2 }) },
];

/**
 * Denenen kurallar. Bilerek AZ: her varyant bir piyango bileti ve k
 * varyantin EN IYISININ beklenen yuzdeligi k/(k+1)'dir. Yedi kural
 * denenince en iyisi, hicbirinde edge olmasa bile %88'e cikar.
 */
const KURALLAR: { ad: string; kural: ExitRule }[] = [
  { ad: 'sabit (kontrol)', kural: { kind: 'sabit' } },
  { ad: 'basabas %40', kural: { kind: 'basabas', activateAtPct: 0.4 } },
  { ad: 'basabas %60', kural: { kind: 'basabas', activateAtPct: 0.6 } },
  { ad: 'geri-cekilme %50->%30', kural: { kind: 'geri-cekilme', activateAtPct: 0.5, exitAtPct: 0.3 } },
  { ad: 'geri-cekilme %60->%50', kural: { kind: 'geri-cekilme', activateAtPct: 0.6, exitAtPct: 0.5 } },
  { ad: 'geri-cekilme %70->%50', kural: { kind: 'geri-cekilme', activateAtPct: 0.7, exitAtPct: 0.5 } },
  { ad: 'geri-cekilme %80->%60', kural: { kind: 'geri-cekilme', activateAtPct: 0.8, exitAtPct: 0.6 } },
];

const fmt = (n: number, d = 3) => (n >= 0 ? '+' : '') + n.toFixed(d);

(async () => {
  const yuklu: { symbol: string; bars: Bar[] }[] = [];
  for (const s of SEMBOLLER) {
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
  console.log(`CIKIS KURALI TARAMASI — ${interval}, ${yuklu.length} sembol`);
  console.log('Bakilacak sutun FARK: kural, stratejiyi yazi-turadan daha fazla');
  console.log('iyilestiriyor mu? Sadece "beklenti" sutununa bakmak yaniltir.');
  console.log('='.repeat(96));

  for (const { ad, yap } of STRATEJILER) {
    console.log('');
    console.log(ad);
    console.log('-'.repeat(96));
    console.log(
      'CIKIS KURALI'.padEnd(24) + 'OOS ISLEM'.padStart(11) +
        'STRATEJI'.padStart(11) + 'TABAN'.padStart(11) +
        'FARK'.padStart(11) + '  FARKTA DEGISIM',
    );

    let kontrolFark = NaN;
    for (const { ad: kad, kural } of KURALLAR) {
      const cfg: BacktestConfig = { ...DEFAULT_CONFIG, exit: kural };
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
      const v = judge(kad, cells);
      const tabanOrt =
        cells.reduce((s, c) => s + c.baselineOos.expectancyR, 0) / cells.length;

      if (kural.kind === 'sabit') kontrolFark = v.avgEdge;
      const degisim = Number.isFinite(kontrolFark) ? v.avgEdge - kontrolFark : NaN;

      console.log(
        kad.padEnd(24) +
          String(v.totalOosTrades).padStart(11) +
          fmt(v.avgOosExpectancy).padStart(11) +
          fmt(tabanOrt).padStart(11) +
          fmt(v.avgEdge).padStart(11) +
          '  ' +
          (kural.kind === 'sabit' ? '(kontrol)' : fmt(degisim)),
      );
    }
  }

  console.log('');
  console.log('='.repeat(96));
  console.log('NASIL OKUNMALI');
  console.log('-'.repeat(96));
  console.log('"STRATEJI" sutunu yukselirken "TABAN" da yukseliyorsa, kural bir edge');
  console.log('uretmiyor — sadece odeme dagilimini degistiriyor ve rastgele girisi de');
  console.log('ayni sekilde etkiliyor. Anlamli olan tek sey FARKTA DEGISIM sutunu:');
  console.log('kural, stratejiye yazi-turaya verdiginden FAZLASINI veriyor mu?');
  console.log('');
  console.log('Ve unutma: 7 kural denendi. Hicbirinde edge olmasa bile en iyisinin');
  console.log('beklenen yuzdeligi 7/8 = %88. Bir sayinin buyuk cikmasi tek basina');
  console.log('hicbir sey ifade etmez; karar sans testinde verilir.');
})();
