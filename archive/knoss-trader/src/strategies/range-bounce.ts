import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { atrSeries, rollingExtremes } from '../core/ma';

export interface RangeBounceParams {
  /** Aralik bu kadar mumun ucundan olculur. */
  lookback: number;
  /** Bandin alt/ust yuzde kaci "kenar bolgesi" sayilir. */
  edgePct: number;
  atrPeriod: number;
  /** Stop, kenarin kac ATR disina konur. */
  stopAtr: number;
  /** Band genisligi ATR'nin kac katini gecerse bu artik aralik degil. */
  maxWidthAtr: number;
  /** Olusan R:R bunun altindaysa islem yok. */
  minRr: number;
}

export const DEFAULT_RANGE_BOUNCE: RangeBounceParams = {
  // 40 mum: 1s'te ~1.5 gun, 4s'te ~1 hafta. Daha kisa pencerede her geri
  // cekilme "aralik" gibi gorunur; daha uzunda trendin ic salinimlari da
  // bandin icine sigar ve yanlislikla aralik sayilir.
  lookback: 40,
  // Bandin alt/ust %25'i kenar bolgesi. Daha dar tutmak (%10) tam kenara
  // dokunmayi sartlar ve sinyal sayisini birkac ornege dusurur; daha genis
  // tutmak (%40) bandin ortasindan giris demektir, ortada ise avantaj yok.
  edgePct: 0.25,
  atrPeriod: 14,
  // 1.0 ATR: kenarin hemen disi. Aralik tezinin yanlislandigi yer kenarin
  // KIRILMASIDIR; stopu daha uzaga koymak, tez zaten coktukten sonra
  // beklemek olur.
  stopAtr: 1.0,
  // Band 10 ATR'den genisse fiyat orada sikismamis, sadece gidip gelmis:
  // bu bir trend bacagidir ve kenari destek/direnc degildir.
  maxWidthAtr: 10,
  // 1.5R: kenardan girip karsi kenar bolgesine kadar tasimanin komisyon ve
  // kayma sonrasi hala anlamli kalmasi icin gereken asgari oran.
  minRr: 1.5,
};

/**
 * Aralik / destek-direnc tepkisi.
 *
 * Kirilim stratejisinin tam karsi tarafinda duruyor: donchian-breakout
 * kenarin KIRILMASINI alir, bu strateji kenardan DONUSU alir. Ikisi ayni
 * piyasada ayni anda kazanamaz; hangisinin gecerli oldugunu tahmin degil
 * olcum soylemeli. Ikisinin de kurulu olmasinin sebebi bu.
 *
 * Kurallar:
 *
 *   1. Aralik tespiti: son `lookback` mumun en yuksegi ve en dusugu bir bant
 *      cizer. Bant, i. mumun KENDI ucunu iceremez; icerseydi fiyat her mumda
 *      "kendi kendinin kenarinda" olurdu ve sinyal anlamini yitirirdi. O
 *      yuzden bant i-1'de biten pencereden okunuyor.
 *   2. Aralik gecerliligi: bir mum bandin DISINA KAPANIRSA aralik olmustur.
 *      Kirilan bir kutunun kenari artik destek/direnc degildir; orada "geri
 *      doner" diye almak dusen bicagi tutmaktir. Kirilimdan sonra bant
 *      bastan, tamamen yeni mumlardan kurulana kadar (yani `lookback` mum
 *      boyunca) hicbir islem yapilmaz.
 *   3. Genislik filtresi: bant ATR'ye gore cok genisse (maxWidthAtr) fiyat
 *      sikismamistir, bu bir trend bacagidir. Cok dar bant da ise yaramaz
 *      cunku hedefi komisyonu bile karsilamaz; onu minRr eliyor.
 *   4. Giris: mum kenar bolgesine SARKMIS ama banda geri KAPANMIS olmali ve
 *      kapanis donus yonunde olmali. Sadece dokunmak yetmez, kiran mum da
 *      dokunur. Ayrica kapanis bandin ortasini gectiyse firsat kacmistir,
 *      kovalamiyoruz.
 *   5. Stop kenarin disinda ve ATR ile: tez "kenar tutar" oldugu icin tezin
 *      yanlislanmasi da kenarin kirilmasidir. Sabit yuzde stop BTC'de genis,
 *      oynak altcoinde gurultudur.
 *   6. Hedef karsi kenar BOLGESININ basi, karsi kenarin kendisi degil:
 *      bandin obur ucunda emir yigilmasi vardir, son yuzdeyi beklemek
 *      dolmayan bir limitte oturmak demektir.
 *
 * Gelecege bakma yok: butun seriler yalnizca gecmise dayaniyor, bant i-1'de
 * biten pencereden okunuyor, sinyal i. mumun kapanisinda uretiliyor ve motor
 * girisi i+1'in acilisindan yapiyor.
 */
export function rangeBounce(
  params: RangeBounceParams = DEFAULT_RANGE_BOUNCE,
): Strategy {
  let prepared: {
    ref: Bar[];
    highest: (number | null)[];
    lowest: (number | null)[];
    atr: (number | null)[];
    /** Bandin disina son kapanistan bu yana gecen mum sayisi. */
    barsSinceBreak: number[];
  } | null = null;

  const prepare = (bars: Bar[]) => {
    // Referans esitligiyle onbellek: motor ayni diziyi her mumda tekrar
    // veriyor, yeniden hesaplasaydik 8760 mumluk kosu O(n^2) olurdu.
    if (prepared && prepared.ref === bars) return prepared;

    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);
    const ext = rollingExtremes(highs, lows, params.lookback);

    // Kirilim sayaci tek gecisde ve ileri dogru kuruluyor. onBar icinde
    // "son kirilim ne zamandi" diye geriye taramak her mumda O(lookback)
    // ek maliyet olurdu ve prepare onbellegini anlamsizlastirirdi.
    const barsSinceBreak: number[] = new Array(bars.length).fill(0);
    for (let i = params.lookback; i < bars.length; i++) {
      const bandHigh = ext.highest[i - 1];
      const bandLow = ext.lowest[i - 1];
      if (bandHigh === null || bandLow === null) continue;
      // Fitil degil KAPANIS bakiliyor: bandin disini yalayip iceri donen
      // mum kirilim degil, tam tersine aralik tezini DOGRULAYAN tepkidir.
      const broke = closes[i] > bandHigh || closes[i] < bandLow;
      barsSinceBreak[i] = broke ? 0 : barsSinceBreak[i - 1] + 1;
    }

    prepared = {
      ref: bars,
      highest: ext.highest,
      lowest: ext.lowest,
      atr: atrSeries(highs, lows, closes, params.atrPeriod),
      barsSinceBreak,
    };
    return prepared;
  };

  return {
    name:
      `Aralik ${params.lookback} kenar tepkisi (kenar %${Math.round(
        params.edgePct * 100,
      )}, stop ${params.stopAtr} ATR, min R:R ${params.minRr})`,
    // Bandi cizmek icin lookback mum, bandin kirilmamis oldugunu gorebilmek
    // icin bir lookback daha gerekiyor; ATR'nin ihtiyacini da asmali.
    warmup: Math.max(params.lookback * 2, params.atrPeriod) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      const atrVal = p.atr[i];
      const bandHigh = p.highest[i - 1];
      const bandLow = p.lowest[i - 1];

      if (
        atrVal === null ||
        atrVal <= 0 ||
        bandHigh === null ||
        bandLow === null
      ) {
        return null;
      }

      const width = bandHigh - bandLow;
      if (width <= 0) return null;

      // Kural 2: kirilimdan sonra bant yeniden kurulana kadar bekle.
      if (p.barsSinceBreak[i] < params.lookback) return null;

      // Kural 3: ATR'ye gore cok genis bant = trend bacagi, aralik degil.
      if (width > atrVal * params.maxWidthAtr) return null;

      const bar = bars[i];
      const lowZoneTop = bandLow + width * params.edgePct;
      const highZoneBottom = bandHigh - width * params.edgePct;
      const mid = bandLow + width / 2;

      // Kural 4: kenara sark, banda geri kapan, donus yonunde kapan ve
      // ortayi henuz gecmemis ol.
      const longSetup =
        bar.low <= lowZoneTop &&
        bar.close > bandLow &&
        bar.close > bar.open &&
        bar.close < mid;

      const shortSetup =
        bar.high >= highZoneBottom &&
        bar.close < bandHigh &&
        bar.close < bar.open &&
        bar.close > mid;

      if (!longSetup && !shortSetup) return null;

      const side: 'LONG' | 'SHORT' = longSetup ? 'LONG' : 'SHORT';
      const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak
      const buffer = atrVal * params.stopAtr;

      // Kural 5 + 6: stop kenarin disinda, hedef karsi kenar bolgesinin
      // basinda. Ikisi de MUTLAK fiyat.
      const stopLoss = side === 'LONG' ? bandLow - buffer : bandHigh + buffer;
      const takeProfit = side === 'LONG' ? highZoneBottom : lowZoneTop;

      // Mesafeler ISARETLI olculuyor, Math.abs ile DEGIL. Nedeni: mutlak deger
      // yonu gizler. Kenar bolgesi bandin yarisindan genis secilirse (edgePct
      // >= 0.5) LONG'un hedefi girisin ALTINA duser; abs bunu hala pozitif bir
      // "odul" gibi gosterir, minRr filtresi de gecirir. Motor o hedefi ilk
      // mumda "kar al" sayacagi icin sonuc garanti zarardir. Isaretli olcum,
      // geometri ters dondugu anda sinyali sessizce eler.
      const risk = side === 'LONG' ? entry - stopLoss : stopLoss - entry;
      const reward = side === 'LONG' ? takeProfit - entry : entry - takeProfit;
      if (risk <= 0 || reward <= 0) return null;

      // minRr hem cok dar bandi hem de kenardan fazla uzaklasmis girisi
      // eliyor: her ikisinde de odul mesafesi riske gore erimistir.
      if (reward / risk < params.minRr) return null;

      return {
        side,
        stopLoss,
        takeProfit,
        reason:
          `${params.lookback} mumluk aralikta ` +
          `${side === 'LONG' ? 'destekten' : 'direncten'} donus`,
      };
    },
  };
}
