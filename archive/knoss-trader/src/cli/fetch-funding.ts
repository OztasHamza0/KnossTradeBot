import { getFunding } from '../data/funding';

/**
 * Fonlama gecmisi indirici — 16 sembol, 6 yil.
 *
 * NEDEN AYRI BIR EKSEN: bugune kadar denenen alti hipotezin HEPSI islem
 * gorulen varligin kendi OHLCV'sini kullandi. Isimleri zit olsa da
 * (trend takibi / ortalamaya donus) bilgi kaynagi ayniydi, ve hepsi ayni
 * duvara tosladi.
 *
 * Fonlama orani FIYATTA OLMAYAN bir bilgi tasir: piyasadaki KONUMLANMA.
 * Pozitif fonlama, long'larin short'lara odedigi anlamina gelir — yani
 * long tarafi kalabalik ve o kalabaligin tasima maliyeti var. Bu, fiyat
 * grafiginden okunamayan bir sey.
 *
 * Fonlamayi HASAT olarak denedik (delta-notr) ve elendi. SINYAL olarak
 * hic denenmedi.
 */

const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

const DAYS = 2200;

async function main() {
  for (const s of SYMBOLS) {
    process.stdout.write(`${s} ... `);
    try {
      const d = await getFunding(s, DAYS);
      const ilk = d.length ? new Date(d[0].time).toISOString().slice(0, 10) : '?';
      const son = d.length ? new Date(d[d.length - 1].time).toISOString().slice(0, 10) : '?';
      console.log(`${d.length} kayit (${ilk} -> ${son})`);
    } catch (e: any) {
      console.log(`HATA: ${e?.message}`);
    }
  }
  console.log('\nFonlama verisi hazir.');
}

main().catch((e) => {
  console.error('HATA:', e?.message ?? e);
  process.exit(1);
});
