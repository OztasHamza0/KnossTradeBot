import { Bar } from '../data/types';
import { Signal, Strategy } from '../backtest/types';
import { atrSeries } from '../core/ma';

export interface TsMomentumParams {
  /** Kisa pencere — tetikleyici. */
  shortLb: number;
  /** Orta pencere — trendin govdesi. */
  midLb: number;
  /** Uzun pencere — rejim filtresi. */
  longLb: number;
  atrPeriod: number;
  /** Stop kac ATR uzakta. */
  stopAtr: number;
  /** Hedef, riskin kac kati. */
  rr: number;
}

/**
 * Varsayilanlar 1h mum icin secildi (CLI'nin varsayilani da 1h).
 *
 * Akademik TSMOM 1/3/12 AY penceresi kullanir; kripto ayni hikayeyi cok daha
 * hizli yasadigi icin oranlari koruyup olcegi kuculttum:
 *   12 mum  = yarim gun  — tetikleyici, "su an hareket var mi"
 *   48 mum  = 2 gun      — govde, gunluk gurultunun ustu
 *   168 mum = 1 hafta    — rejim, haftalik yon
 * Pencereler arasi ~4x oran onemli: 12/24/48 gibi ic ice gecmis pencereler
 * ayni bilgiyi uc kez sayar ve "uc onay" yanilsamasi yaratir.
 */
export const DEFAULT_TS_MOMENTUM: TsMomentumParams = {
  shortLb: 12,
  midLb: 48,
  longLb: 168,
  // ATR 14 Wilder standardi; diger stratejilerle ayni tutuldu ki karsilastirma
  // stop mantigindaki farki degil strateji fikrindeki farki olcsun.
  atrPeriod: 14,
  stopAtr: 2,
  rr: 2,
};

/**
 * N mumluk ham getiri serisi: (close[i] - close[i-N]) / close[i-N].
 *
 * Tek gecisde uretiliyor cunku onBar her mumda cagriliyor; her cagride
 * yeniden hesaplamak 8760 mumluk kosuyu O(n^2) yapardi.
 *
 * i < period icin null — yarim pencereyle uretilen getiri, gercekte olmayan
 * bir momentumu varmis gibi gosterir.
 */
function returnSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const past = closes[i - period];
    // Bozuk/sifir veri gelirse bolme sonsuza gider ve strateji cop sinyal uretir.
    if (!Number.isFinite(past) || past <= 0) continue;
    out[i] = (closes[i] - past) / past;
  }
  return out;
}

/**
 * Zaman serisi momentumu (TSMOM).
 *
 * Fikir EMA kesisiminden BASKA bir sey: hareketli ortalamalarin birbirine
 * gore konumuna degil, varligin KENDI ham getirisine bakiyor. "Fiyat 168 mum
 * once neredeydi, simdi nerede" sorusu, iki yumusatilmis serinin kesismesinden
 * farkli bir soru — EMA kesisimi gecmis fiyatlari agirliklandirip gecikme
 * yaratirken ham getiri iki noktayi dogrudan karsilastirir, gecikmesi yoktur.
 *
 * Kurallar:
 *
 *   1. UC PENCERE AYNI YONE BAKMALI. Tek pencereli momentum, o pencerenin
 *      uzunluguna asiri duyarlidir: 20 mumda pozitif olan seri 21 mumda
 *      negatif cikabilir. Farkli olceklerde ayni isaret istemek, sonucu tek
 *      bir parametre secimine bagimli olmaktan cikarir. Uzun pencere rejimi,
 *      orta pencere trendi, kisa pencere de "su anda gercekten hareket
 *      ediyor mu"yu soyler.
 *
 *   2. KISA GETIRI EN AZ 1 ATR KADAR OLMALI. Isaret sarti tek basina cok
 *      zayif: yatay piyasada getiri sifirin milyonda biri kadar pozitif
 *      olabilir ve bu "momentum" sayilir. Esigi ATR'ye baglamak, esigi
 *      varligin kendi oynakligiyla olcekler — BTC'de %1'lik hareket haberdir,
 *      volatil bir altcoinde gurultudur. Esik icin ayri bir parametre
 *      koymadim: "hareket, tipik bir mumun menzilinden buyuk olmali" keyfi
 *      bir sayi degil, dogal bir sinir.
 *
 *   3. STOP ATR'YE BAGLI. Sabit yuzde stop BTC'de gereksiz genis, oynak
 *      altcoinde gurultuye takilir. Varsayilan 2 ATR — digerlerinden (1.5)
 *      biraz genis, cunku momentum girisleri tanim geregi hareketin ORTASINDA
 *      olur ve dar stop normal geri cekilmede supurulur.
 *
 * Gelecege bakma yok: getiri ve ATR serilerinin i. elemani yalniz bars[0..i]
 * verisine dayanir, sinyal i. mumun kapanisinda uretilir, motor girisi
 * i+1'in acilisinda yapar.
 */
export function tsMomentum(
  params: TsMomentumParams = DEFAULT_TS_MOMENTUM,
): Strategy {
  let prepared: {
    ref: Bar[];
    retShort: (number | null)[];
    retMid: (number | null)[];
    retLong: (number | null)[];
    atr: (number | null)[];
  } | null = null;

  // ema-pullback'teki onbellek deseni: seriler bar dizisi basina BIR kez
  // hesaplanir, sonraki cagrilar ayni referansi gorup yeniden hesaplamaz.
  const prepare = (bars: Bar[]) => {
    if (prepared && prepared.ref === bars) return prepared;
    const closes = bars.map((b) => b.close);
    prepared = {
      ref: bars,
      retShort: returnSeries(closes, params.shortLb),
      retMid: returnSeries(closes, params.midLb),
      retLong: returnSeries(closes, params.longLb),
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
      `TS momentum ${params.shortLb}/${params.midLb}/${params.longLb} ` +
      `(stop ${params.stopAtr} ATR, R:R ${params.rr})`,
    // En uzun pencere kadar gecmis sart; +2 pay, kullanici pencereleri
    // sirasiz verirse (mid > long gibi) de dogru kalsin diye Math.max hepsini
    // kapsiyor.
    warmup:
      Math.max(
        params.shortLb,
        params.midLb,
        params.longLb,
        params.atrPeriod,
      ) + 2,

    onBar(bars: Bar[], i: number): Signal | null {
      const p = prepare(bars);

      const rS = p.retShort[i];
      const rM = p.retMid[i];
      const rL = p.retLong[i];
      const atrVal = p.atr[i];

      if (rS === null || rM === null || rL === null || atrVal === null || atrVal <= 0) {
        return null;
      }

      const bar = bars[i];
      if (bar.close <= 0) return null;

      // Kural 2: esik yuzde cinsinden, cunku getiriler de yuzde cinsinden.
      // ATR'yi fiyata bolmek onu "bir mumun tipik hareketi, yuzde olarak"
      // yapar ve boylece varliktan bagimsiz karsilastirilabilir olur.
      const noise = atrVal / bar.close;

      // Kural 1: uc pencere de ayni isaret. Kural 2: kisa pencere gurultuyu
      // asmis olmali — uzun pencerelere esik koymuyorum, onlarin isi buyukluk
      // olcmek degil YON dogrulamak.
      const longSetup = rS > noise && rM > 0 && rL > 0;
      const shortSetup = rS < -noise && rM < 0 && rL < 0;
      if (!longSetup && !shortSetup) return null;

      const side = longSetup ? 'LONG' : 'SHORT';
      const entry = bar.close; // motor gercek dolumu i+1 acilisindan alacak
      const stopDist = atrVal * params.stopAtr;

      const stopLoss = side === 'LONG' ? entry - stopDist : entry + stopDist;
      const takeProfit =
        side === 'LONG'
          ? entry + stopDist * params.rr
          : entry - stopDist * params.rr;

      // Cokus mumlarinda ATR fiyatin yarisini asabiliyor; o zaman LONG'un
      // stopu (entry - 2*ATR) SIFIRIN ALTINA duser. Motor stopu
      // "low <= stopLoss" diye ariyor ve hicbir dusuk sifirin altina inmedigi
      // icin boyle bir islem backtest'te ASLA ZARARLA KAPANMAZ: yalniz hedefe
      // ya da zaman asimina gider. Yani olcum, gercekte var olmayan risksiz
      // bir islem uretip sonuclari sessizce yukari siser — ve borsa negatif
      // fiyatli bir stop emrini zaten kabul etmez. Ayni sakatlik SHORT'un
      // hedefinde var: (entry - rr*2*ATR) negatifse hedefe hicbir zaman
      // ulasilamaz, islem yapay olarak stop/zaman asimina zorlanir.
      // Olculemeyen bir riski olculmus gibi gostermektense sinyali atmak
      // dogru: aleyhte varsayim, motorun geri kalaninda oldugu gibi.
      if (stopLoss <= 0 || takeProfit <= 0) return null;

      return {
        side,
        stopLoss,
        takeProfit,
        reason:
          `${params.shortLb}/${params.midLb}/${params.longLb} mumluk ham getiriler ` +
          `${side === 'LONG' ? 'pozitif' : 'negatif'} (kisa vade ${(rS * 100).toFixed(2)}%)`,
      };
    },
  };
}
