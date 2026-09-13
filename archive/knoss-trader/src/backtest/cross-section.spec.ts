import { buildRanks, MIN_UNIVERSE } from './cross-section';
import { Bar } from '../data/types';

/**
 * Kesitsel kodda en kolay yapilan iki hata:
 *  1. Sembolleri INDEKSE gore eslestirmek. Mum dizileri farkli yerde
 *     baslayabilir; indeks eslestirmek, bir sembolun GELECEGINI baska
 *     bir sembolun BUGUNUYLE kiyaslamak demektir — sessiz gelecege bakma.
 *  2. Dar evrende siralama uretmek. Uc sembolun icinde "en guclu" olmak
 *     bilgi tasimaz.
 */

const H = 3_600_000;

/** Verilen kapanislardan, t0'dan baslayan bir mum dizisi. */
const seri = (closes: number[], t0 = 0): Bar[] =>
  closes.map((c, i) => ({
    openTime: t0 + i * H,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1,
    closeTime: t0 + i * H + H - 1,
  }));

/**
 * MIN_UNIVERSE'i doldurmak icin dolgu sembolleri.
 *
 * Getirileri BIRBIRINDEN FARKLI ve hepsi kucuk pozitif (%0.1 - %0.6):
 * duz seri tum sembolleri berabere birakir, beraberlikte siralama keyfi
 * olur ve test kodun davranisini degil sort'un kararliligini olcer.
 */
const dolgu = (n: number, t0 = 0, uzunluk = 10) => {
  const out: Record<string, Bar[]> = {};
  for (let k = 0; k < n; k++) {
    const adim = 0.001 * (k + 1); // %0.1, %0.2, ...
    out[`PAD${k}`] = seri(
      Array.from({ length: uzunluk }, (_, i) => 100 * (1 + adim * i)),
      t0,
    );
  }
  return out;
};

describe('buildRanks', () => {
  it('en guclu 1, en zayif 0 yuzdelik alir', () => {
    // 3 mum geriye bakis. 4. mumda (indeks 3) getiriler:
    //   YUKSEK: 130/100 = +%30   DUSUK: 90/100 = -%10   PADn: 0
    const series: Record<string, Bar[]> = {
      YUKSEK: seri([100, 110, 120, 130, 130, 130, 130, 130, 130, 130]),
      DUSUK: seri([100, 97, 94, 90, 90, 90, 90, 90, 90, 90]),
      ...dolgu(MIN_UNIVERSE - 2),
    };
    const r = buildRanks(series, 3);
    const t = 3 * H;
    expect(r.YUKSEK(t)).toBe(1);
    expect(r.DUSUK(t)).toBe(0);
  });

  it('evren MIN_UNIVERSE altindaysa null doner — "ortada" DEGIL', () => {
    // Uc sembolun icinde "en guclu" olmak bilgi tasimaz. Bu durumda
    // 0.5 gibi bir deger dondurmek, bilmedigimiz seyi biliyormus gibi
    // gostermek olurdu.
    const series: Record<string, Bar[]> = {
      A: seri([100, 110, 120, 130]),
      B: seri([100, 97, 94, 90]),
      C: seri([100, 100, 100, 100]),
    };
    const r = buildRanks(series, 3);
    expect(r.A(3 * H)).toBeNull();
    expect(r.B(3 * H)).toBeNull();
  });

  it('sembolleri ZAMANA gore eslestirir, indekse gore DEGIL', () => {
    /**
     * Asil tuzak bu. GEC sembolu 5 saat sonra basliyor. Indeks
     * eslestirilseydi GEC'in 3. mumu (t=8H) diger sembollerin 3. mumuyla
     * (t=3H) kiyaslanirdi — yani GEC'in GELECEGI digerlerinin BUGUNUYLE.
     */
    const series: Record<string, Bar[]> = {
      // t=0..9, sabit -> getiri 0
      ERKEN: seri([100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
      // t=5H..14H. t=8H'de getiri: 150/100 = +%50
      GEC: seri([100, 120, 140, 150, 150, 150, 150, 150, 150, 150], 5 * H),
      // GEC t=3H'de HENUZ YOK, yani o anda evren bir eksik. Dolgu
      // sayisi ona gore: ERKEN + dolgular = MIN_UNIVERSE.
      ...dolgu(MIN_UNIVERSE - 1, 0, 15),
    };
    const r = buildRanks(series, 3);

    // GEC t=8H'de var ve en guclu olmali.
    expect(r.GEC(8 * H)).toBe(1);
    // Ama t=3H'de GEC HENUZ YOK — o zamandaki siralamada bulunmamali.
    expect(r.GEC(3 * H)).toBeNull();
    // ERKEN o zaman var (dolgularla birlikte evren yeterli).
    expect(r.ERKEN(3 * H)).not.toBeNull();
  });

  it('lookback penceresi dolmadan siralama uretmez', () => {
    const series: Record<string, Bar[]> = {
      A: seri([100, 110, 120, 130, 140, 150, 160, 170, 180, 190]),
      ...dolgu(MIN_UNIVERSE - 1),
    };
    const r = buildRanks(series, 5);
    // Ilk 5 mumda geriye bakis penceresi dolmamis.
    expect(r.A(0)).toBeNull();
    expect(r.A(4 * H)).toBeNull();
    expect(r.A(5 * H)).not.toBeNull();
  });

  it('GELECEGE BAKMA YOK: siralama sonradan gelen mumlardan etkilenmez', () => {
    /**
     * Karsi kontrol: ayni seriyi, SONRASINA veri eklenmis haliyle tekrar
     * hesaplayip t anindaki siralamanin DEGISMEDIGINI dogruluyoruz.
     * Degisseydi, siralama gelecegi kullaniyor olurdu.
     */
    const kisa: Record<string, Bar[]> = {
      A: seri([100, 110, 120, 130]),
      B: seri([100, 97, 94, 90]),
      ...dolgu(MIN_UNIVERSE - 2, 0, 4),
    };
    const uzun: Record<string, Bar[]> = {
      // Ayni ilk 4 mum, ustune tamamen ZIT bir gelecek.
      A: seri([100, 110, 120, 130, 50, 40, 30, 20]),
      B: seri([100, 97, 94, 90, 500, 600, 700, 800]),
      ...dolgu(MIN_UNIVERSE - 2, 0, 8),
    };
    const rk = buildRanks(kisa, 3);
    const ru = buildRanks(uzun, 3);
    const t = 3 * H;
    expect(ru.A(t)).toBe(rk.A(t));
    expect(ru.B(t)).toBe(rk.B(t));
    // Ve karsi kontrol: gelecek gercekten zit, yani test bos gecmiyor.
    expect(ru.A(7 * H)).toBe(0);
    expect(ru.B(7 * H)).toBe(1);
  });

  it('bozuk fiyat (sifir/negatif) cokme yaratmaz, o sembol siralamaya girmez', () => {
    const series: Record<string, Bar[]> = {
      BOZUK: seri([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      IYI: seri([100, 110, 120, 130, 130, 130, 130, 130, 130, 130]),
      ...dolgu(MIN_UNIVERSE - 1),
    };
    const r = buildRanks(series, 3);
    expect(r.BOZUK(3 * H)).toBeNull();
    expect(r.IYI(3 * H)).toBe(1);
  });
});
