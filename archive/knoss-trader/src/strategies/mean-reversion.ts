import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { sma, ema, atrSeries } from '../core/ma';

export interface MeanReversionParams {
  /** Bollinger orta bandinin ve z-skorun penceresi. */
  period: number;
  /** Girisi tetikleyen asirilik: kac standart sapma. */
  entryZ: number;
  atrPeriod: number;
  /** Stop kac ATR uzakta. */
  stopAtr: number;
  /** Rejim filtresinin uzun ortalamasi. */
  regimeEma: number;
  /** Fiyat uzun ortalamadan en fazla kac ATR uzakta olabilir. */
  regimeMaxAtr: number;
}

export const DEFAULT_MEAN_REVERSION: MeanReversionParams = {
  // 20: klasik Bollinger penceresi. Daha kisasi (10) gurultuyu "asirilik"
  // sanip surekli tetiklenir; daha uzunu (50) bandi o kadar genisletir ki
  // sinyal sayisi istatistiksel olarak anlamsizlasir.
  period: 20,
  // 2.0: normal dagilimda ~%5'lik kuyruk. Kripto sisman kuyrukludur, yani
  // pratikte daha sik tetiklenir — 2.5+ yapmak 1 yillik kosuda avuc ici
  // kadar islem birakip sonucu sansa cevirir.
  entryZ: 2.0,
  atrPeriod: 14,
  // 2.0: trend stratejilerinin 1.5'inden GENIS olmali. Momentuma karsi
  // giriyoruz; asirilik donmeden once bir miktar daha uzayabilir. Dar stop
  // burada "hakli ama erken kapanmis" islem uretir.
  stopAtr: 2.0,
  regimeEma: 200,
  // 2.5 ATR: rejim filtresinin esigi ve bu stratejinin en kritik sayisi.
  // Once suprulmesi gereken parametre budur.
  regimeMaxAtr: 2.5,
};

/**
 * Hedefin stoptan en az bu kadar uzak olmasi sart.
 *
 * NEDEN parametre degil sabit: bu bir tercih degil, bir gecerlilik esigi.
 * Ortalamaya donus zaten yuksek isabet / dusuk kazanc profilinde calisir;
 * hedef stoptan yakinsa isabet orani %70 bile olsa komisyon + kayma
 * beklentiyi eksiye cevirir. "Cok kazanan ama para kaybettiren strateji"
 * tuzagi tam olarak burada olusur.
 */
const MIN_REWARD_RISK = 1.0;

/**
 * Ortalamaya donus (Bollinger / z-skor).
 *
 * Fikir: fiyat kendi kisa vadeli ortalamasindan istatistiksel olarak asiri
 * uzaklastiginda geri doner. Diger iki strateji (EMA geri cekilme, Donchian
 * kirilimi) trendi TAKIP ediyor; bu onlarin karsit hipotezi. Ucunu birden
 * olcmenin sebebi, hangi rejimin bu sembolde hakim oldugunu tahminle degil
 * sayiyla ogrenmek.
 *
 *   1. REJIM FILTRESI — stratejinin kalbi. Trend piyasasinda ortalamaya donus
 *      katliamdir: fiyat "asiri" olur, ters girersin, fiyat daha da asiri olur.
 *      O yuzden yalnizca fiyat uzun EMA'nin YAKININDA iken islem yapiyoruz.
 *      Yakinligi ATR biriminde olcuyoruz: yuzdeyle olcmek BTC'de genis, oynak
 *      altcoinde bogucu bir esik olurdu. Fiyat EMA200'den ATR'nin katlariyla
 *      ayrilmissa piyasa yatay degil trendlidir; kenara cekiliyoruz.
 *   2. ASIRILIK — z = (kapanis - SMA) / standart sapma. Sabit yuzde bant yerine
 *      z-skor: "asiri" tanimi piyasanin o anki oynakligina gore olceklensin,
 *      sakin donemde de firtinada da ayni seyi ifade etsin.
 *   3. GERI DONUS ONAYI — bandin disina sarkmis olmak yetmez, mumun banda geri
 *      KAPANMASI gerekiyor. Dusen bicak da bandin disindadir; onaysiz versiyon
 *      bicagi tam ortasindan yakalar.
 *   4. HEDEF = ORTALAMA. Tezin kendisi bu, dolayisiyla cikis da bu olmali.
 *      Sabit R:R kullanmak stratejiyi kendi mantigindan koparirdi: ortalamaya
 *      donus "fiyat ortaya doner" der, "fiyat 2R gider" demez.
 *   5. STOP ATR ile, hedeften bagimsiz. Ikisi birlikte MIN_REWARD_RISK esigini
 *      gecmiyorsa islem ATLANIR — asirilik yeterince derin degildir.
 *
 * Gelecege bakma yok: SMA/stdev/EMA/ATR serilerinin i. degeri yalnizca
 * bars[0..i]'ye dayanir, sinyal i. mumun kapanisinda uretilir, motor girisi
 * i+1'in acilisindan yapar.
 */
export function meanReversion(
  params: MeanReversionParams = DEFAULT_MEAN_REVERSION,
): Strategy {
  let prepared: {
    ref: Bar[];
    mid: (number | null)[];
    sd: (number | null)[];
    regime: (number | null)[];
    atr: (number | null)[];
  } | null = null;

  // ema-pullback.ts'teki desen: seriler mum dizisi basina BIR KEZ hesaplanir.
  // Her onBar cagrisinda yeniden hesaplasaydik 8760 mumluk kosu O(n^2) olurdu.
  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const closes = bars.map((b) => b.close);
    prepared = {
      ref: bars,
      mid: sma(closes, params.period),
      sd: rollingStdev(closes, params.period),
      regime: ema(closes, params.regimeEma),
      atr: atrSeries(
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        closes,
        params.atrPeriod,
      ),
    };
    return prepared;
  };

  return {
    name:
      `Bollinger ${params.period} ortalamaya donus (z ${params.entryZ}, ` +
      `stop ${params.stopAtr} ATR, EMA${params.regimeEma} rejim filtresi ` +
      `${params.regimeMaxAtr} ATR)`,
    // Uc serinin en uzununu bekliyoruz; +2 pay, onceki mumu (i-1) de
    // okudugumuz icin. Eksik hesaplanmis gosterge = sahte islem.
    warmup: Math.max(params.period, params.regimeEma, params.atrPeriod) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      const mid = p.mid[i];
      const sd = p.sd[i];
      const regime = p.regime[i];
      const atrVal = p.atr[i];
      const prevMid = p.mid[i - 1];
      const prevSd = p.sd[i - 1];

      if (
        mid === null ||
        sd === null ||
        prevMid === null ||
        prevSd === null ||
        regime === null ||
        atrVal === null ||
        atrVal <= 0
      ) {
        return null;
      }

      // Sifir standart sapma = son `period` mumun kapanisi ayni. Bolme
      // patlamasin diye degil, boyle bir pencerede "asirilik" kavraminin
      // hicbir anlami olmadigi icin cikiyoruz.
      if (sd <= 0 || prevSd <= 0) return null;

      const bar = bars[i];
      const prev = bars[i - 1];

      // 1. REJIM FILTRESI — her seyden once. Trenddeysek hicbir asirilik
      // bizi ters yone sokmamali.
      if (Math.abs(bar.close - regime) > params.regimeMaxAtr * atrVal) {
        return null;
      }

      const z = (bar.close - mid) / sd;
      const prevZ = (prev.close - prevMid) / prevSd;

      // 2 + 3: onceki mum bandin DISINA kapanmis (asirilik), bu mum bandin
      // ICINE geri kapanmis (donus onayi). Ikinci kosul olmadan, uzayan bir
      // harekete kademe kademe ters girilir.
      const longSetup = prevZ <= -params.entryZ && z > -params.entryZ;
      const shortSetup = prevZ >= params.entryZ && z < params.entryZ;
      if (!longSetup && !shortSetup) return null;

      const side: 'LONG' | 'SHORT' = longSetup ? 'LONG' : 'SHORT';
      const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak

      // 4. Hedef orta bant. Onay mumu ortalamayi asip gectiyse (tek mumda
      // bandin bir ucundan digerine) alinacak yol kalmamistir; atliyoruz.
      const reward = side === 'LONG' ? mid - entry : entry - mid;
      if (reward <= 0) return null;

      // 5. Stop ATR ile: sabit yuzde stop BTC'de genis, oynak altcoinde
      // gurultuye takilir.
      const stopDist = atrVal * params.stopAtr;
      if (reward < stopDist * MIN_REWARD_RISK) return null;

      return {
        side,
        stopLoss: side === 'LONG' ? entry - stopDist : entry + stopDist,
        takeProfit: side === 'LONG' ? entry + reward : entry - reward,
        reason:
          `Yatay rejimde ${prevZ.toFixed(2)}z ` +
          `${side === 'LONG' ? 'asiri satim' : 'asiri alim'}, ` +
          `banda geri kapanis; hedef SMA${params.period}`,
      };
    },
  };
}

/**
 * Kayan standart sapma (populasyon).
 *
 * NEDEN core/ma.ts'te degil: yalnizca bu strateji kullaniyor, paylasilan
 * modulu tek musterili yardimcilarla sismanlatmiyoruz.
 *
 * NEDEN her pencerede iki gecis, tek gecisli (sum, sumSq) formulu degil:
 * BTC gibi buyuk fiyatlarda E[x^2] - E[x]^2 birbirine cok yakin iki devasa
 * sayinin farkidir ve kayan toplamda hata birikir. `period` sabit ve kucuk
 * oldugu icin maliyet O(n * period), yani mum sayisinda dogrusal —
 * rollingExtremes de ayni yaklasimi kullaniyor.
 */
function rollingStdev(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    const mean = sum / period;

    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - mean;
      sq += d * d;
    }
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}
