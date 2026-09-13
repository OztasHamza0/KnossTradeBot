import { getBars } from '../data/binance';

/**
 * Coklu sembol/aralik veri indirici.
 *
 * Ayri bir komut olmasinin sebebi: indirme dakikalar suruyor ama backtest
 * milisaniyeler. Veriyi bir kez indirip onlarca kez taramak istiyoruz.
 *
 * Kullanim: npm run data
 */

const SYMBOLS = [
  // Ayar sembolleri
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT',
  'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT',
  // Dokunulmamis semboller — hipotez testi burada yapiliyor
  'AVAXUSDT', 'ATOMUSDT', 'NEARUSDT', 'LTCUSDT',
  'DOTUSDT', 'UNIUSDT', 'FILUSDT', 'APTUSDT',
];

const INTERVALS: { interval: string; days: number }[] = [
  // ISTATISTIKSEL GUC = 1.96 x sd / sqrt(N). Veriyi buyutmek, tespit
  // esigini dusurmenin TEK ucuz yolu. Binance futures cogu major
  // paritede 2019-2020'ye kadar veri veriyor; listelenmeden oncesi
  // zaten yok, getBars elindekiyle yetinir.
  { interval: '1h', days: 2200 },
  { interval: '4h', days: 2200 },
];

async function main() {
  for (const symbol of SYMBOLS) {
    for (const { interval, days } of INTERVALS) {
      process.stdout.write(`${symbol} ${interval} ... `);
      try {
        const bars = await getBars(symbol, interval, days);
        const from = bars.length
          ? new Date(bars[0].openTime).toISOString().slice(0, 10)
          : '?';
        console.log(`${bars.length} mum (${from} →)`);
      } catch (e: any) {
        console.log(`HATA: ${e?.message}`);
      }
    }
  }
  console.log('\nVeri hazir.');
}

main().catch((e) => {
  console.error('HATA:', e?.message ?? e);
  process.exit(1);
});
