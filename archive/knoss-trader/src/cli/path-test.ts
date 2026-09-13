import { loadBars } from '../data/binance';
import { Bar } from '../data/types';
import { Strategy } from '../backtest/types';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { tsMomentum } from '../strategies/ts-momentum';
import { emaPullback } from '../strategies/ema-pullback';
import { randomBaseline } from '../strategies/random-baseline';

/**
 * FIYAT YOLU TESTI — "hedefe yaklasinca doner mi?"
 *
 * Bir cikis kuralinin ise yarayip yaramayacagini, kurali hic yazmadan
 * soyleyen dogrudan olcum. Soru su:
 *
 *   "Hedefe %X gelmis bir islemin kaci hedefe ULASIYOR, kaci geri donup
 *    stopa gidiyor?"
 *
 * RASTGELE YURUYUS BUNUN CEVABINI KESIN VERIYOR. Stop -1, hedef +R birimde,
 * fiyat hedefe %x gelmisse (yani +xR noktasindaysa):
 *
 *   P(once hedefe ulasir) = (1 + xR) / (1 + R)
 *
 * Olculen deger bu ongorunun ALTINDAysa "yaklasinca doner" egilimi GERCEK
 * demektir ve erken cikis mantikli olur. Ongoruye ESITSE, hicbir cikis
 * kurali beklentiyi degistiremez — sadece odeme dagilimini degistirir ve
 * komisyonu artirir.
 *
 * ZAMAN ASIMI TUZAGI — BU ARACIN EN ONEMLI PARCASI:
 *   Formul, yuruyusun bir barajA CARPANA KADAR kostugunu varsayar. Ama
 *   backtest 200 mumda pozisyonu zorla kapatiyor. Cozulmemis islemler
 *   "hedefe ulasamadi" diye sayilinca P(hedef) YAPAY OLARAK DUSUYOR ve
 *   ortada olmayan bir "geri donme egilimi" gorunuyor.
 *
 *   Bu tam olarak yasandi: 200 mumluk ufukta donchian z = -3.3 verdi
 *   ("yaklasinca doner" gibi). Ama AYNI YAPIDAKI YAZI-TURA da ayni sapmayi
 *   verdi — sifir beceriyle. Ufuk 2000 muma cikarilinca (zaman asimi
 *   %8.2 -> %1.2) donchian'in sapmasi tamamen kayboldu: %62.4 vs ongoru
 *   %62.5, z = -0.0.
 *
 *   Bu yuzden arac HER ZAMAN iki ufku ve YAZI-TURA kontrolunu birlikte
 *   basar. Kontrol grubu olmadan bu olcum yaniltir.
 *
 * Kullanim:  npm run path-test -- 1h
 */

const SEMBOLLER = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT', 'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

const interval = process.argv[2] ?? '1h';

/** Kisa ufuk = backtest motorunun gercek ayari; uzun ufuk = kesme yanliligini olcmek icin. */
const UFUKLAR = [200, 2000];
const ESIKLER = [0.5, 0.6, 0.7, 0.8, 0.9];

interface Kayit {
  /** En iyi lehte gidis, hedef mesafesinin orani (0..1). */
  mfe: number;
  sonuc: 'tp' | 'sl' | 'timeout';
  rr: number;
}

/**
 * Motorla AYNI kurallar: giris i+1'in acilisinda, bosluk kapisi, stop
 * hedefe gore oncelikli, pozisyon kapaninca sonraki mumdan devam.
 * Ayrisirsa bu olcum baska bir sistemi tarif eder.
 */
function topla(strat: Strategy, bars: Bar[], maxBars: number): Kayit[] {
  const out: Kayit[] = [];
  let i = Math.max(strat.warmup, 1);
  while (i < bars.length - 1) {
    const sig = strat.onBar(bars, i);
    if (!sig) { i++; continue; }
    const long = sig.side === 'LONG';
    const entry = bars[i + 1].open;
    const stopD = Math.abs(entry - sig.stopLoss);
    const tpD = Math.abs(sig.takeProfit - entry);
    const sirali = long
      ? sig.stopLoss < entry && entry < sig.takeProfit
      : sig.takeProfit < entry && entry < sig.stopLoss;
    if (!sirali || stopD <= 0 || tpD <= 0) { i++; continue; }

    let mfe = 0;
    let sonuc: Kayit['sonuc'] = 'timeout';
    let son = i + 1;
    const last = Math.min(bars.length - 1, i + 1 + maxBars);
    for (let j = i + 1; j <= last; j++) {
      const b = bars[j];
      // Lehte gidis stop/hedef kontrolunden ONCE olculuyor ki "stopa giden
      // ama once yukari gitmis" islemler dogru siniflansin.
      mfe = Math.max(mfe, (long ? b.high - entry : entry - b.low) / tpD);
      if (long ? b.low <= sig.stopLoss : b.high >= sig.stopLoss) { sonuc = 'sl'; son = j; break; }
      if (long ? b.high >= sig.takeProfit : b.low <= sig.takeProfit) { sonuc = 'tp'; son = j; break; }
      son = j;
    }
    out.push({ mfe: Math.min(mfe, 1), sonuc, rr: tpD / stopD });
    i = son + 1;
  }
  return out;
}

const STRATEJILER: [string, () => Strategy][] = [
  ['donchian-20 (R:R 3)', () => donchianBreakout({ lookback: 20, atrPeriod: 14, stopAtr: 3, rr: 3, trendEma: 200 })],
  ['ts-momentum (R:R 2)', () => tsMomentum()],
  ['ema-pullback (R:R 2)', () => emaPullback({ fast: 21, slow: 55, pull: 9, atrPeriod: 14, stopAtr: 1.5, rr: 2 })],
  // Kontrol grubu SART: asagidaki sapmanin gercek mi kesme yanliligi mi
  // oldugunu ancak sifir beceriyle karsilastirarak anlariz.
  ['YAZI-TURA (R:R 3)', () => randomBaseline(42, 20, 3, 3)],
  ['YAZI-TURA (R:R 2)', () => randomBaseline(42, 20, 1.5, 2)],
];

(async () => {
  console.log('='.repeat(84));
  console.log(`FIYAT YOLU TESTI — ${interval}, ${SEMBOLLER.length} sembol`);
  console.log('Soru: hedefe %X gelen islem, rastgele yuruyusun ongordugunden');
  console.log('      DAHA SIK mi geri donuyor?  (ongoru: P = (1+xR)/(1+R))');
  console.log('='.repeat(84));

  for (const ufuk of UFUKLAR) {
    console.log('');
    console.log('#'.repeat(84));
    console.log(
      `ZAMAN ASIMI UFKU: ${ufuk} mum` +
        (ufuk === 200 ? '   <- motorun GERCEK ayari' : '   <- kesme yanliligini olcmek icin'),
    );
    console.log('#'.repeat(84));

    for (const [ad, yap] of STRATEJILER) {
      const hepsi: Kayit[] = [];
      for (const s of SEMBOLLER) {
        let bb: Bar[] | null = null;
        try { bb = loadBars(s, interval); } catch { bb = null; }
        if (bb && bb.length > 500) hepsi.push(...topla(yap(), bb, ufuk));
      }
      if (hepsi.length < 100) continue;

      const R = hepsi.reduce((a, k) => a + k.rr, 0) / hepsi.length;
      const to = hepsi.filter((k) => k.sonuc === 'timeout').length;
      console.log('');
      console.log(
        `${ad}   ${hepsi.length} islem | R:R ${R.toFixed(2)} | zaman asimi %${((to / hepsi.length) * 100).toFixed(1)}`,
      );
      console.log('  esik    cozulen n   P(hedef)   ongoru       z');
      for (const e of ESIKLER) {
        const alt = hepsi.filter((k) => k.mfe >= e && k.sonuc !== 'timeout');
        if (alt.length < 50) continue;
        const p = alt.filter((k) => k.sonuc === 'tp').length / alt.length;
        const ongoru = (1 + e * R) / (1 + R);
        const se = Math.sqrt((p * (1 - p)) / alt.length);
        const z = se > 0 ? (p - ongoru) / se : 0;
        console.log(
          `  %${(e * 100).toFixed(0)}`.padEnd(9) +
            String(alt.length).padStart(9) +
            `${(p * 100).toFixed(1)}%`.padStart(11) +
            `${(ongoru * 100).toFixed(1)}%`.padStart(10) +
            `${z >= 0 ? '+' : ''}${z.toFixed(1)}`.padStart(9) +
            (Math.abs(z) >= 2 ? '  <-' : ''),
        );
      }
    }
  }

  console.log('');
  console.log('='.repeat(84));
  console.log('NASIL OKUNMALI');
  console.log('-'.repeat(84));
  console.log('z NEGATIF ve buyukse: "yaklasinca doner" egilimi var, erken cikis mantikli.');
  console.log('z ~ 0 ise: hicbir cikis kurali beklentiyi degistiremez — sadece odeme');
  console.log('dagilimini degistirir ve islem sayisini (yani komisyonu) artirir.');
  console.log('');
  console.log('AMA once YAZI-TURA satirlarina bak. Onlarda da ayni sapma varsa, gordugun');
  console.log('sey strateji degil ZAMAN ASIMI KESMESIDIR: cozulmemis islemler "hedefe');
  console.log('ulasamadi" diye sayilir ve olmayan bir egilim uretir. 200 mum ufkunda tam');
  console.log('bu yasandi; 2000 mumda sapma kayboldu.');
})();
