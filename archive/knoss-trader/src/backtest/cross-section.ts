import { Bar } from '../data/types';

/**
 * KESITSEL BAGLAM — varliklar ARASINDAKI bilgi.
 *
 * NEDEN BU DOSYA VAR: bu projede 12 strateji test edildi ve hicbiri
 * yazi-turadan ayrismadi. Ama sonradan fark edildi ki 12 hipotez degil,
 * BIR hipotez 12 kere test edilmisti. Donchian, EMA, RSI, Bollinger,
 * hacim, oynaklik, seans — hepsinin sekli ayni: "tek bir varligin KENDI
 * fiyat gecmisine bakip KENDI yonunu tahmin et."
 *
 * Varliklar ARASINDAKI bilgi — goreli guc, siralama — o stratejilerin
 * literal olarak GOREMEDIGI bir sey; girdilerinde yok. Bu, yapisal olarak
 * farkli bir hipotez sinifi ve ayrica denenmeyi hak ediyor.
 *
 * NEDEN YENI BIR MOTOR DEGIL: kesitsel karari her sembol icin bir SINYALE
 * cevirebiliyorsak, mevcut motor (giris i+1 acilisinda, stop/hedef, ayni
 * mumda stop oncelikli, komisyon+kayma+fonlama), mevcut OOS ayrimi,
 * judge() ve sans testi aynen kullanilabilir. Ustelik cikan strateji canli
 * yurutucude HICBIR degisiklik gerektirmez. Yeni bir motor yazmak, tum o
 * dogrulanmis makineyi bir kez daha, dogrulanmamis halde yazmak olurdu.
 *
 * GELECEGE BAKMA YOK: i. mumdaki siralama, yalnizca kapanis[i] ve
 * kapanis[i-lookback] kullanilarak hesaplanir — ikisi de gecmiste.
 * Siralamaya giren diger sembollerin verisi de AYNI zaman damgasindan
 * (openTime) alinir, ayni indeksten degil; sembollerin mum dizileri
 * farkli yerde baslayabilir ve indeks eslestirmek sessizce gelecege
 * bakmak olurdu.
 */

/** Bir sembolun, verilen zamandaki kesitsel yuzdelik sirasi. */
export type RankLookup = (openTime: number) => number | null;

/**
 * Siralamanin gecerli sayilmasi icin gereken en az sembol sayisi.
 *
 * Uc sembolun icinde "en guclu" olmak bir bilgi tasimaz; siralama ancak
 * yeterince genis bir evrende anlamlidir. Veri baslangiclari farkli
 * oldugu icin serinin basinda evren dogal olarak dar kalir, ve orada
 * uretilen sinyal gurultudur.
 */
export const MIN_UNIVERSE = 8;

/**
 * Her sembol icin zaman damgasindan yuzdelik siraya bir arama tablosu kurar.
 *
 * Yuzdelik: 0 = evrenin en zayifi, 1 = en guclusu.
 * Tek sembol varsa (ya da evren MIN_UNIVERSE altindaysa) null doner —
 * "bilmiyorum", "ortada" DEGIL.
 */
export function buildRanks(
  series: Record<string, Bar[]>,
  lookback: number,
): Record<string, RankLookup> {
  const symbols = Object.keys(series);

  // zaman -> sembol -> getiri
  const byTime = new Map<number, Map<string, number>>();

  for (const s of symbols) {
    const bars = series[s];
    for (let i = lookback; i < bars.length; i++) {
      const now = bars[i].close;
      const then = bars[i - lookback].close;
      if (!(now > 0) || !(then > 0)) continue;
      const ret = now / then - 1;
      if (!Number.isFinite(ret)) continue;
      let m = byTime.get(bars[i].openTime);
      if (!m) {
        m = new Map();
        byTime.set(bars[i].openTime, m);
      }
      m.set(s, ret);
    }
  }

  // zaman -> sembol -> yuzdelik
  const pctByTime = new Map<number, Map<string, number>>();
  for (const [t, m] of byTime) {
    if (m.size < MIN_UNIVERSE) continue;
    const sirali = [...m.entries()].sort((a, b) => a[1] - b[1]);
    const p = new Map<string, number>();
    // n === 1 durumu MIN_UNIVERSE ile zaten eleniyor; yine de bolme
    // guvenli olsun diye max(1, ...).
    const bolen = Math.max(1, sirali.length - 1);
    sirali.forEach(([sym], idx) => p.set(sym, idx / bolen));
    pctByTime.set(t, p);
  }

  const out: Record<string, RankLookup> = {};
  for (const s of symbols) {
    out[s] = (openTime: number) => {
      const p = pctByTime.get(openTime);
      if (!p) return null;
      const v = p.get(s);
      return v === undefined ? null : v;
    };
  }
  return out;
}
