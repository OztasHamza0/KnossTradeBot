import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { ema, sma, atrSeries } from '../core/ma';

export interface VolumeThrustParams {
  /** Hacim ortalamasinin ve "asirilik" referansinin penceresi. */
  volLookback: number;
  /** Hacim, ortalamanin kac katini asarsa patlama sayilir. */
  volMult: number;
  /** Govde / toplam menzil orani; mumun ne kadari yonlu. */
  minBodyPct: number;
  /** Kapanis ortalamadan en fazla kac ATR uzakta olabilir (zirve filtresi). */
  maxExtensionAtr: number;
  /** Stop kac ATR uzakta. */
  stopAtr: number;
  /** Hedef, riskin kac kati. */
  rr: number;
}

export const DEFAULT_VOLUME_THRUST: VolumeThrustParams = {
  // 20: 1h grafikte yaklasik bir gunluk pencere. Daha kisa alirsak tek bir
  // sakin gece ortalamayi dusurup ertesi sabah sahte "patlama" uretir; daha
  // uzun alirsak rejim degistikten sonraki yeni normal hacim surekli patlama
  // gibi gorunur.
  volLookback: 20,
  // 2.5: 1.5-2x bandi piyasanin normal gel-gitidir, sinyal degil. 4x ustu ise
  // cogunlukla haber/tasfiye anidir — yani devam degil ZIRVE adayi. 2.5,
  // "gercek para girdi ama henuz panik degil" araligini hedefliyor.
  volMult: 2.5,
  // 0.55: govde menzilin yarisindan fazlasi olsun. Bu tek kosul iki isi birden
  // yapiyor: mumun yonlu oldugunu garantiler VE kapanisi menzilin en az %55'lik
  // tarafina iter — yani uzun ust fitille reddedilmis bir hacim patlamasi
  // (klasik zirve mumu) bu esikten gecemez. Ayri bir "fitil" parametresi
  // gerekmemesinin sebebi bu.
  minBodyPct: 0.55,
  // 2.5 ATR: patlamanin kendisi zaten 1-2 ATR'lik bir mum uretir. Kapanis
  // ortalamadan bundan da uzaktaysa hareket coktan kosmus demektir; oradaki
  // hacmin "yeni alici" degil "son alici" olma ihtimali yuksektir.
  maxExtensionAtr: 2.5,
  // 1.8: patlama mumu tanimi geregi genis. 1.5 ATR stop cogu zaman o mumun
  // ICINDE kalir ve rutin bir geri testte suprulur; 1.8 nefes payi birakiyor.
  stopAtr: 1.8,
  // 1.5: patlama sonrasi devam hareketi hizli olur ama uzun surmez. Zaten
  // gerilmis bir hareketten 2R istemek, kazanan islemleri geri vermektir.
  rr: 1.5,
};

/**
 * Hacim patlamasi + devam.
 *
 * Fikir: fiyat hareketi tek basina yalan soyleyebilir — ince emir defterinde
 * kucuk bir emir bile mumu buyuk gosterir. Ortalamanin cok uzerindeki hacim
 * ise o hareketin arkasinda gercekten el degistiren para oldugunu gosterir.
 * Bu strateji o mumun yonunde devam bekliyor.
 *
 * Asil zorluk su: hacim patlamasi hem devamin hem ZIRVENIN isaretidir. Ayni
 * olcum, "yeni alicilar geliyor" da olabilir "son alicilar aliniyor" da.
 * Ayrimi tek bir sihirli kosula degil, uc filtreye yaydik:
 *
 *   1. GOVDE ORANI (minBodyPct): zirve mumu tipik olarak buyuk hacimle kosar
 *      ve uzun bir fitille geri doner — govdesi menzilinin kucuk bir parcasi
 *      kalir. Govde/menzil esigi bu mumu dogrudan eler.
 *   2. ASIRILIK FILTRESI (maxExtensionAtr): fiyat ortalamasindan cok
 *      uzaklasmisken gelen hacim tukenme (blow-off) hacmidir. Hareketin
 *      BASINDAKI patlama devam eder, SONUNDAKI patlama bitirir. Mesafeyi ATR
 *      cinsinden olcuyoruz ki esik BTC'de de oynak bir altcoinde de ayni
 *      seyi ifade etsin.
 *   3. YON TUTARLILIGI: patlama mumu yonlu olsa bile ortalamanin ters
 *      tarafinda kapaniyorsa bu bir devam degil donus denemesidir; devam
 *      stratejisinin isi degildir.
 *
 * Bilerek YAPILMAYAN sey: "kapanis onceki mumun yuksegini asmali" kosulunu
 * eklemedik. Eklesek strateji 1 mumluk Donchian kirilimina donusur ve
 * donchian-breakout.ts ile ayni fikri olcmeye baslardi; iki stratejinin ayni
 * seyi test etmesi karsilastirmayi degersizlestirir.
 *
 * Stop bilerek saf ATR: patlama mumunun dibine yaslamak daha "dogal" gorunur
 * ama dev bir mumda stop mesafesi patlar, pozisyon boyutu erir ve uretilen R
 * degerleri diger stratejilerinkiyle karsilastirilamaz hale gelir. Sabit ATR
 * carpani bu karsilastirilabilirligi koruyor.
 *
 * Gelecege bakma yok: seriler tum diziden hesaplaniyor ama her deger yalnizca
 * kendi indeksine kadarki mumlara dayaniyor; karar i. mumun KAPANISINDA
 * veriliyor, motor girisi i+1'in acilisinda yapiyor.
 */
export function volumeThrust(
  params: VolumeThrustParams = DEFAULT_VOLUME_THRUST,
): Strategy {
  // ATR periyodu bilerek parametre degil: Wilder 14 fiili standart, ve bunu da
  // ayri bir eksen yapmak dort filtreli bir fikri yedi boyutlu bir arama
  // uzayina cevirip asiri uydurma (overfit) riskini buyutur.
  const ATR_PERIOD = 14;

  let prepared: {
    ref: Bar[];
    avgVol: (number | null)[];
    mean: (number | null)[];
    atr: (number | null)[];
  } | null = null;

  // ema-pullback.ts'teki onbellek deseni: seriler mum dizisi basina BIR kez
  // hesaplanir. Her cagrida yeniden hesaplasaydik 8760 mumluk bir kosu O(n^2)
  // olur ve dakikalarca surerdi.
  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const closes = bars.map((b) => b.close);
    prepared = {
      ref: bars,
      avgVol: sma(
        bars.map((b) => b.volume),
        params.volLookback,
      ),
      // Asirilik referansi olarak hacim penceresiyle AYNI periyodu kullaniyoruz:
      // "son bir gunun normali" hem hacimde hem fiyatta ayni zaman olceginden
      // okunsun. Farkli pencereler iki filtrenin birbiriyle celismesine yol acar.
      mean: ema(closes, params.volLookback),
      atr: atrSeries(
        bars.map((b) => b.high),
        bars.map((b) => b.low),
        closes,
        ATR_PERIOD,
      ),
    };
    return prepared;
  };

  return {
    name: `Hacim ${params.volMult}x patlama devami (stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    // +2 pay: ortalama hacmi i-1'den okudugumuz icin i. mumda bir onceki
    // indeksin de dolu olmasi gerekiyor. Yarim hesaplanmis seriden sinyal
    // uretmektense birkac mum gec baslamak yeglenir.
    warmup: Math.max(params.volLookback, ATR_PERIOD) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      // Ortalama hacmi i-1'den okuyoruz: patlama mumu kendi referansinin
      // icinde olursa ortalamayi yukari ceker, oran sistematik olarak kucuk
      // cikar ve esik farkinda olmadan yumusar.
      const avgVol = p.avgVol[i - 1];
      const mean = p.mean[i];
      const atrVal = p.atr[i];

      // NEDEN sadece "=== null" yetmiyor da Number.isFinite gerekiyor: bozuk
      // tek bir hacim degeri (Binance satirindan parseFloat ile NaN gelmesi)
      // veriye girebiliyor — isValidBar yalnizca OHLC'yi denetliyor, hacmi
      // denetlemiyor. Ve sma'nin yuvarlanan toplami bir kez NaN olunca bir daha
      // duzelmiyor: tek bozuk mum, avgVol'u kosunun SONUNA KADAR NaN yapiyor.
      // NaN her karsilastirmada false dondugu icin "avgVol <= 0" suzgeci onu
      // yakalamaz; boyle bir seri sessizce gecer ve asagidaki patlama kosulunu
      // de kapatir — yani strateji hacim kanitina hic bakmadan islem uretmeye
      // baslar. Sayinin gercekten sayi oldugunu dogrulamak bunun tek savunmasi.
      if (
        avgVol === null ||
        mean === null ||
        atrVal === null ||
        !Number.isFinite(avgVol) ||
        !Number.isFinite(mean) ||
        !Number.isFinite(atrVal) ||
        avgVol <= 0 ||
        atrVal <= 0
      ) {
        return null;
      }

      const bar = bars[i];
      const range = bar.high - bar.low;
      // Menzili sifir olan mum (islem gormemis / duraklatilmis sembol)
      // bolme islemini patlatir; oran hesaplarindan once eliyoruz.
      if (range <= 0) return null;

      // 1. Hacim patlamasi var mi.
      //    NEDEN once finite kontrolu: "NaN < esik" false dondugu icin bozuk bir
      //    hacim degeri sessizce "esigi asti" muamelesi gorur ve stratejinin ASIL
      //    kaniti ortadan kalkar. Eksik veriyi patlama sanmaktansa o mumu atlamak
      //    dogru olan; atlanan mum en fazla bir firsat kaybi, uydurulan sinyal ise
      //    canlida gercek para.
      if (!Number.isFinite(bar.volume)) return null;
      if (bar.volume < avgVol * params.volMult) return null;

      // 2. Yonlu ve dolgun govde. Ayni kosul, uzun fitille reddedilmis
      //    zirve/dip mumunu de eliyor.
      const body = bar.close - bar.open;
      if (body === 0) return null;
      if (Math.abs(body) < range * params.minBodyPct) return null;

      const long = body > 0;

      // 3. Zirve filtresi: hareket ortalamadan cok uzaklasmisken gelen hacim
      //    yeni para degil son para olabilir.
      const extensionAtr = Math.abs(bar.close - mean) / atrVal;
      if (extensionAtr > params.maxExtensionAtr) return null;

      // 4. Yon tutarliligi — parametre gerektirmeyen ikinci zirve korumasi.
      //    Ortalamanin altinda kapanan bir alici mumu "devam" degil, dip
      //    toplama denemesidir; onu bu strateji almamali.
      if (long && bar.close < mean) return null;
      if (!long && bar.close > mean) return null;

      const side = long ? 'LONG' : 'SHORT';
      const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak
      const stopDist = atrVal * params.stopAtr;

      const volRatio = bar.volume / avgVol;

      return {
        side,
        stopLoss: long ? entry - stopDist : entry + stopDist,
        takeProfit: long
          ? entry + stopDist * params.rr
          : entry - stopDist * params.rr,
        reason:
          `Ortalamanin ${volRatio.toFixed(1)}x hacmiyle gelen ` +
          `${long ? 'alici' : 'satici'} mumunun devami`,
      };
    },
  };
}
