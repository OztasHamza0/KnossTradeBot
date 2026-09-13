import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { ema, atrSeries, rollingExtremes } from '../core/ma';

export interface MtfTrendParams {
  /**
   * Kac alt mum bir ust mum eder. 4 => 1h serisinden 4h trendi.
   * Tek bir sayi, hem ust EMA'yi olceklemek hem de "bir ust mum kadar geriye
   * bakmak" icin kullaniliyor; ikisini ayri parametre yapmak, ayni fiziksel
   * buyuklugu iki yerden farkli tanimlama riski dogururdu.
   */
  htfMult: number;
  /**
   * UST zaman dilimindeki EMA periyodu. 50 secildi cunku 4h EMA50 kurumsal
   * trend takibinin fiili standardi; alt seride karsiligi 50*4 = EMA200 olur,
   * yani zaten bilinen "EMA200 = ana trend" cizgisiyle ortusur.
   */
  htfEma: number;
  /**
   * ALT zaman diliminin ivme ortalamasi. 20, bir ust mumun (4 alt mum)
   * birkac katini kapsayacak kadar uzun ama ust EMA'nin golgesinde kalmayacak
   * kadar kisa: tetigin ust trendden bagimsiz bir bilgi tasimasi icin gerekli.
   */
  ltfEma: number;
  atrPeriod: number;
  /** Stop kac ATR uzakta. */
  stopAtr: number;
  /** Hedef, riskin kac kati. */
  rr: number;
}

export const DEFAULT_MTF_TREND: MtfTrendParams = {
  htfMult: 4,
  htfEma: 50,
  ltfEma: 20,
  // 14 ve 1.5, diger stratejilerle AYNI birakildi: farkli stop mantiklariyla
  // kiyaslarsak hangi fikrin kazandigini degil hangi stopun sansli oldugunu
  // olcmus oluruz.
  atrPeriod: 14,
  stopAtr: 1.5,
  rr: 2,
};

/**
 * Coklu zaman dilimi trend hizasi.
 *
 * Tek seriden iki zaman dilimi TURETIYOR: ust zaman diliminin EMA'si, alt
 * seride periyodu htfMult ile carpilmis bir EMA ile yaklasik olarak ayni
 * seydir (4h EMA50 ~ 1h EMA200). Ayrica ust dilimin EGIMI, alt seride
 * htfMult mum geriye bakarak olculur — cunku ust dilimde "onceki mum",
 * alt dilimde htfMult mum onceki demektir. ema-pullback'te boyle bir sey
 * yok; orada fast/slow ayni zaman diliminde carpisiyor.
 *
 * Kurallar:
 *
 *   1. UST TREND KAPISI (iki sartli). Ust EMA bir ust mum oncesine gore
 *      yukselmis OLMALI ve fiyat onun uzerinde kapanmali. Yalniz egim
 *      yeterli degil: cizgi hala yukari egimliyken fiyat altina cokmus
 *      olabilir. Yalniz fiyat konumu da yeterli degil: yatay bir cizginin
 *      bir tik ustu trend degildir. Ikisini birlikte istemek, yatay
 *      piyasada kapiyi kapali tutar.
 *   2. ALT DILIM IVMESI. Alt EMA'nin kendisi de trend yonune donmus olmali.
 *      Ust trend gunlerce dogru kalabilir; giris icin "su anda" hangi yone
 *      gidildigi gerekir.
 *   3. TETIK: BIR UST MUMLUK KAPANIS KIRILIMI. Bu mumun kapanisi, son
 *      htfMult mumun (yani bir ust mumun) en yuksek KAPANISINI asmali.
 *      Kapanis kullanmak fitilden daha zor kirilir; fitil kirilimi ust
 *      dilimde iz birakmayan gurultudur.
 *   4. STOP ATR ILE. Sabit yuzde stop BTC'de genis, oynak altcoinde
 *      gurultudur; ust trendi dogru bilip stopu yanlis olcmek yine kaybettirir.
 *
 * Gelecege bakma yok: htf/ltf/atr serileri yalniz gecmise dayanan degerler
 * uretir, tetik i-1'de biten pencereye bakar, sinyal i. mumun kapanisinda
 * olusur ve motor girisi i+1'in acilisinda yapar.
 */
export function mtfTrend(params: MtfTrendParams = DEFAULT_MTF_TREND): Strategy {
  let prepared: {
    ref: Bar[];
    htf: (number | null)[];
    ltf: (number | null)[];
    atr: (number | null)[];
    hiClose: (number | null)[];
    loClose: (number | null)[];
  } | null = null;

  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const highs = bars.map((b) => b.high);
    const lows = bars.map((b) => b.low);
    const closes = bars.map((b) => b.close);
    // rollingExtremes'e iki kere closes veriyoruz: amac fitil ucu degil,
    // KAPANIS ucu (bkz. kural 3). Yardimci fonksiyonu kopyalamamak icin
    // en ucuz yol bu.
    const ext = rollingExtremes(closes, closes, params.htfMult);
    prepared = {
      ref: bars,
      // Ust dilimin EMA'sinin alt seri karsiligi: periyot x htfMult.
      htf: ema(closes, params.htfEma * params.htfMult),
      ltf: ema(closes, params.ltfEma),
      atr: atrSeries(highs, lows, closes, params.atrPeriod),
      hiClose: ext.highest,
      loClose: ext.lowest,
    };
    return prepared;
  };

  return {
    name:
      `MTF ${params.htfMult}x hiza (ust EMA${params.htfEma}, alt EMA${params.ltfEma}, ` +
      `stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    // Ust EMA htfEma*htfMult mum sonra dolar, egim icin htfMult mum daha
    // gerekir; eksik seriyle uretilen sinyal sahte islemdir.
    warmup:
      Math.max(
        params.htfEma * params.htfMult + params.htfMult,
        params.ltfEma,
        params.atrPeriod,
      ) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      const htfNow = p.htf[i];
      const htfPrevCandle = p.htf[i - params.htfMult];
      const ltfNow = p.ltf[i];
      const ltfPrev = p.ltf[i - 1];
      const atrVal = p.atr[i];
      // Pencere i-1'de bitiyor: bu mumun kendi kapanisini pencereye almak
      // "kendi kendini kirmak" olur ve her yukselen mumda sinyal uretirdi.
      const prevHiClose = p.hiClose[i - 1];
      const prevLoClose = p.loClose[i - 1];

      if (
        htfNow === null ||
        htfPrevCandle === null ||
        ltfNow === null ||
        ltfPrev === null ||
        prevHiClose === null ||
        prevLoClose === null ||
        atrVal === null ||
        atrVal <= 0
      ) {
        return null;
      }

      const bar = bars[i];

      // 1: ust dilim kapisi — egim VE fiyat konumu birlikte.
      const htfUp = htfNow > htfPrevCandle && bar.close > htfNow;
      const htfDown = htfNow < htfPrevCandle && bar.close < htfNow;

      // 2 + 3: alt dilim ivmesi ve bir ust mumluk kapanis kirilimi.
      const longSetup = htfUp && ltfNow > ltfPrev && bar.close > prevHiClose;
      const shortSetup = htfDown && ltfNow < ltfPrev && bar.close < prevLoClose;

      if (!longSetup && !shortSetup) return null;

      const side = longSetup ? 'LONG' : 'SHORT';
      const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak
      const stopDist = atrVal * params.stopAtr;

      return {
        side,
        stopLoss: side === 'LONG' ? entry - stopDist : entry + stopDist,
        takeProfit:
          side === 'LONG'
            ? entry + stopDist * params.rr
            : entry - stopDist * params.rr,
        reason:
          `Ust dilim (${params.htfMult}x) ${side === 'LONG' ? 'yukselis' : 'dusus'} ` +
          `trendinde alt dilim kapanis kirilimi`,
      };
    },
  };
}
