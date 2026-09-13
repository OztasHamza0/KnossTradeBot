import { Bar } from '../data/types';

/**
 * IZGARA (GRID) SIMULATORU — sekizinci hipotez sinifi.
 *
 * NEDEN YAPISAL OLARAK FARKLI: denenen yedi eksenin hepsi "yonu tahmin et,
 * gir, stop koy, hedef koy" seklindeydi. Izgara YON TAHMIN ETMEZ.
 * Fiyatin etrafina bir merdiven kurar, asagida alir yukarida satar ve
 * SALINIMDAN kazanir. Fiyatin nereye gidecegi hakkinda hicbir iddiasi yok.
 *
 * IKINCI FARK: emirler LIMIT, yani MAKER. Binance USD-M'de maker %0.02,
 * taker %0.05 — maliyet duvarinin yaridan fazlasi buharlasir. Yedi eksenin
 * tikandigi yer tam da maliyetti.
 *
 * === AMA IZGARA BEDAVA PARA DEGIL — NE OLDUGUNU DOGRU ADLANDIRALIM ===
 * Izgara "kisa gamma"dir: yukselise satar, dususe alir. Kucuk ve sik kazanir,
 * SEYREK ve BUYUK kaybeder. Fiyat aralikitan cikip trend yaparsa envanter
 * tek yone birikir ve zarar sinirsizdir.
 *
 * Yani izgaranin sorusu "kazandiriyor mu" degil:
 *   **kucuk kazanclarin toplami, seyrek buyuk kaybi KARSILIYOR MU?**
 * Bu soru ancak UZUN gecmiste ve TREND donemlerini iceren veride
 * cevaplanabilir. Elimizde 6 yil var ve icinde 2021 bogasi, 2022 ayisi
 * ve yatay donemler birlikte duruyor — tam gereken sey.
 *
 * === ALEYHTE VARSAYIMLAR (motorun geri kalaniyla ayni ilke) ===
 * 1. Bir seviye ancak fiyat ONUN ICINDEN GECERSE dolar (low < seviye,
 *    kesin esitsizlik). Tam degip donmek dolum SAYILMAZ: limit emir
 *    sirasinda onunde baskalari vardir.
 * 2. Bir mumda birden cok seviye gecildiyse HEPSI dolar. Gercek de budur
 *    ve aleyhimizedir: trendde envanter hizla birikir.
 * 3. Mum ici sira bilinmiyor; once EN KOTU yon islenir (mumun aleyhte
 *    ucu once gorulur).
 * 4. Fonlama her 8 saatte bir envanter uzerinden odenir/alinir.
 */

export interface GridConfig {
  /** Kac seviye (merkezin ustunde ve altinda toplam). */
  levels: number;
  /** Izgara genisligi: merkez +- bu yuzde. */
  rangePct: number;
  /** Baslangic sermayesi (USDT). */
  capitalUsdt: number;
  /** MAKER komisyonu (%), tek yon. */
  makerFeePct: number;
  /** 8 saatlik fonlama orani (%). Long envanterde pozitifse ODENIR. */
  fundingPct: number;
  /**
   * Envanter tavani: |envanter| x fiyat, sermayenin bu katini asamaz.
   * Izgaranin gercek riski budur — sinirsiz birikim hesabi siler.
   */
  maxLeverage: number;
  /**
   * Fiyat izgaranin disina cikinca ne olsun.
   * 'bekle'    : hicbir sey, envanter tasinir (klasik izgara — ve olduren sey)
   * 'yeniden'  : izgara yeni fiyata tasinir, envanter TASINIR
   * 'kes'      : envanter kapatilir, izgara yeniden kurulur (stop'lu izgara)
   */
  disariCikinca: 'bekle' | 'yeniden' | 'kes';
}

export const DEFAULT_GRID: GridConfig = {
  levels: 20,
  rangePct: 5,
  capitalUsdt: 1000,
  makerFeePct: 0.02,
  fundingPct: 0.01,
  maxLeverage: 3,
  disariCikinca: 'yeniden',
};

export interface GridResult {
  /** Kac seviye dolumu oldu (islem sayisi). */
  dolum: number;
  /** Baslangic ve bitis ozkaynagi (USDT). */
  baslangicEquity: number;
  bitisEquity: number;
  getiriPct: number;
  /** En derin ozkaynak dususu (%). Izgarada ASIL bakilacak sayi. */
  maxDusus: number;
  /** Odenen toplam komisyon ve fonlama. */
  toplamKomisyon: number;
  toplamFonlama: number;
  /** Kac kez izgara disina cikildi. */
  disariCikis: number;
  /** Envanter tavanina kac kez dayandi (bloke edilen dolum). */
  tavanaDayandi: number;
  /** Bitisteki acik envanter (baz birim). */
  kalanEnvanter: number;
  /** Ozkaynak egrisi (her mum). */
  equityEgrisi: number[];
  /** Hesap sifirlandi mi — likidasyon. */
  iflas: boolean;
  /** Iflas hangi mumda oldu (-1 = olmadi). */
  iflasBar: number;
  /** Kac mum hayatta kaldi / toplam. */
  hayattaKalanMum: number;
}

function seviyeler(merkez: number, cfg: GridConfig): number[] {
  const out: number[] = [];
  const yari = Math.floor(cfg.levels / 2);
  const adim = (merkez * (cfg.rangePct / 100)) / yari;
  for (let k = -yari; k <= yari; k++) {
    if (k === 0) continue;
    const p = merkez + k * adim;
    if (p > 0) out.push(p);
  }
  return out.sort((a, b) => a - b);
}

export function runGrid(bars: Bar[], cfg: GridConfig = DEFAULT_GRID): GridResult {
  const bos: GridResult = {
    dolum: 0, baslangicEquity: cfg.capitalUsdt, bitisEquity: cfg.capitalUsdt,
    getiriPct: 0, maxDusus: 0, toplamKomisyon: 0, toplamFonlama: 0,
    disariCikis: 0, tavanaDayandi: 0, kalanEnvanter: 0, equityEgrisi: [],
    iflas: false, iflasBar: -1, hayattaKalanMum: 0,
  };
  if (bars.length < 10 || cfg.levels < 2) return bos;

  let nakit = cfg.capitalUsdt;
  let envanter = 0; // baz birim; negatif = short
  let merkez = bars[0].close;
  let grid = seviyeler(merkez, cfg);
  /** Her seviyede bekleyen emir yonu: fiyatin altindakiler ALIS, ustundekiler SATIS. */
  const emirVar = new Map<number, boolean>();
  for (const s of grid) emirVar.set(s, true);

  let dolum = 0;
  let toplamKomisyon = 0;
  let toplamFonlama = 0;
  let disariCikis = 0;
  let tavanaDayandi = 0;
  let iflas = false;
  let iflasBar = -1;
  let zirve = cfg.capitalUsdt;
  let maxDusus = 0;
  const egri: number[] = [];

  const birimQty = cfg.capitalUsdt / cfg.levels / merkez;

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const fiyat = b.close;

    // --- Seviye dolumlari ---
    // ALEYHTE SIRA: once mumun bize zarar veren ucunu isliyoruz.
    // Long envanterdeysek once DUSUK (daha cok alis, daha cok birikim),
    // short'sak once YUKSEK. Mum ici sirayi bilmiyoruz; en kotusunu
    // varsaymak backtest'i sistematik olarak sismekten korur.
    const oncelikDusuk = envanter >= 0;
    const uclar = oncelikDusuk ? [b.low, b.high] : [b.high, b.low];

    for (const uc of uclar) {
      for (const s of grid) {
        if (!emirVar.get(s)) continue;
        // KESIN ESITSIZLIK: tam degip donmek dolum sayilmaz.
        const alisDoldu = uc < s && s < merkez;
        const satisDoldu = uc > s && s > merkez;
        if (!alisDoldu && !satisDoldu) continue;

        const yon = alisDoldu ? +1 : -1;
        const yeniEnvanter = envanter + yon * birimQty;
        // Envanter tavani — izgaranin gercek riski burada sinirlanir.
        if (Math.abs(yeniEnvanter) * s > cfg.capitalUsdt * cfg.maxLeverage) {
          tavanaDayandi++;
          continue;
        }

        const tutar = birimQty * s;
        const komisyon = tutar * (cfg.makerFeePct / 100);
        nakit -= yon * tutar;
        nakit -= komisyon;
        toplamKomisyon += komisyon;
        envanter = yeniEnvanter;
        dolum++;
        emirVar.set(s, false);
      }
    }

    // Dolan seviyenin KARSISINA yeni emir: klasik izgara boyle calisir.
    // (Bir seviye dolduysa, fiyat geri donunce ters islem yapilabilsin.)
    for (const s of grid) {
      if (emirVar.get(s)) continue;
      const geriDondu = (s < merkez && b.high > s) || (s > merkez && b.low < s);
      if (geriDondu) emirVar.set(s, true);
    }

    // --- Fonlama: 8 saatte bir, envanter uzerinden ---
    if (i % 8 === 0 && envanter !== 0) {
      // Long pozitif oranda ODER.
      const odeme = Math.abs(envanter) * fiyat * (cfg.fundingPct / 100);
      nakit -= envanter > 0 ? odeme : -odeme;
      toplamFonlama += envanter > 0 ? odeme : -odeme;
    }

    // --- Izgaranin disina cikildi mi ---
    const alt = merkez * (1 - cfg.rangePct / 100);
    const ust = merkez * (1 + cfg.rangePct / 100);
    if (fiyat < alt || fiyat > ust) {
      disariCikis++;
      if (cfg.disariCikinca === 'kes') {
        // Envanteri kapat — TAKER maliyetiyle, cunku piyasa emri.
        if (envanter !== 0) {
          const tutar = Math.abs(envanter) * fiyat;
          const kom = tutar * (0.05 / 100);
          nakit += envanter * fiyat - kom;
          toplamKomisyon += kom;
          envanter = 0;
        }
        merkez = fiyat;
        grid = seviyeler(merkez, cfg);
        emirVar.clear();
        for (const s of grid) emirVar.set(s, true);
      } else if (cfg.disariCikinca === 'yeniden') {
        merkez = fiyat;
        grid = seviyeler(merkez, cfg);
        emirVar.clear();
        for (const s of grid) emirVar.set(s, true);
      }
      // 'bekle' -> hicbir sey. Envanter tasinir, zarar birikir.
    }

    const equity = nakit + envanter * fiyat;
    egri.push(equity);
    zirve = Math.max(zirve, equity);
    if (zirve > 0) maxDusus = Math.max(maxDusus, ((zirve - equity) / zirve) * 100);

    /**
     * IFLAS — simulasyon BURADA durur.
     *
     * Ilk surum ozkaynak sifirin altina dustukten sonra da islem acmaya
     * devam ediyordu ve "-637% getiri" gibi anlamsiz sayilar uretiyordu.
     * Gercek dunyada orada likidasyon olur: pozisyon zorla kapanir, hesap
     * biter, geri donus yoktur.
     *
     * Bu, izgara icin ozellikle onemli: izgara kucuk ve sik kazanip
     * SEYREK ve BUYUK kaybeder. Iflasi modellemezsen, olumden sonraki
     * "toparlanmayi" kara yazarsin ve strateji hayatta kalmis gibi gorunur.
     */
    if (equity <= 0) {
      iflas = true;
      iflasBar = i;
      break;
    }
  }

  const son = bars[Math.min(iflas ? iflasBar : bars.length - 1, bars.length - 1)].close;
  const bitis = iflas ? 0 : nakit + envanter * son;

  return {
    dolum,
    baslangicEquity: cfg.capitalUsdt,
    bitisEquity: bitis,
    getiriPct: ((bitis - cfg.capitalUsdt) / cfg.capitalUsdt) * 100,
    maxDusus,
    toplamKomisyon,
    toplamFonlama,
    disariCikis,
    tavanaDayandi,
    kalanEnvanter: envanter,
    equityEgrisi: egri,
    iflas,
    iflasBar,
    hayattaKalanMum: iflas ? iflasBar : bars.length,
  };
}
