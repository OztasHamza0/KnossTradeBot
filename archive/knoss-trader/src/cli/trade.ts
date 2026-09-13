import * as fs from 'fs';
import * as path from 'path';
import { BinanceFuturesClient } from '../live/client';
import { Executor } from '../live/executor';
import { fetchKlines } from '../data/binance';
import { INTERVAL_MS } from '../data/types';
import { donchianBreakout } from '../strategies/donchian-breakout';

/**
 * CANLI (testnet) ISLEM DONGUSU.
 *
 * ONEMLI CERCEVE: bu bir PERFORMANS testi degil, TESISAT testidir.
 * Bir aksamda 2-5 islem olur; olculen edge'i gormek icin binlerce islem
 * gerektigi zaten hesaplandi (+0.05 R icin 4361 islem). Yani bu kosunun
 * kar/zarar sonucu GURULTUDUR ve ona bakilarak karar verilmemelidir.
 *
 * Bu kosunun cevapladigi sorular sunlar ve hepsi gercek:
 *   - Anahtarlar calisiyor mu, hesaba erisiliyor mu?
 *   - Emir borsanin miktar/fiyat adimlarina uyuyor mu?
 *   - Stop ve hedef BORSAYA yaziliyor mu?
 *   - Koruma yazilamazsa pozisyon geri kapatiliyor mu?
 *   - Bot yeniden baslatilinca ikinci pozisyon acmiyor mu?
 *
 * Kullanim:
 *   npx ts-node src/cli/trade.ts --dry-run          (emir gondermez)
 *   npx ts-node src/cli/trade.ts                    (testnet'e gercek emir)
 */

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
/**
 * Tesisat testi icin yapay sinyal.
 *
 * Sebep: emir yolunu sinamak icin sinyalin GERCEK olmasi gerekmiyor.
 * Kirilim stratejisi gunlerce sinyal uretmeyebilir; o sirada API,
 * yuvarlama, stop yerlestirme ve geri alma yollari hic denenmemis kalir.
 * Bu bayrak piyasa fiyatindan bir pozisyon acar — KAR AMACI YOK, yalnizca
 * borunun ucuna kadar su gidiyor mu diye bakar. Sadece testnet'te anlamli.
 */
const FORCE = args.includes('--force-signal');
const SYMBOL = (args.find((a) => a.startsWith('--symbol='))?.split('=')[1] ?? 'BTCUSDT').toUpperCase();
const INTERVAL = args.find((a) => a.startsWith('--interval='))?.split('=')[1] ?? '15m';
const LEVERAGE = parseInt(args.find((a) => a.startsWith('--leverage='))?.split('=')[1] ?? '3', 10);
const RISK_PCT = parseFloat(args.find((a) => a.startsWith('--risk='))?.split('=')[1] ?? '1');

/**
 * Strateji: donchian-20, genis stop.
 * Secim sebebi "en iyisi" oldugu icin DEGIL — hicbirinin olculebilir edge'i
 * yok. Sik islem uretmesi icin secildi, ki tesisat bir aksamda sinansin.
 */
const STRATEGY = donchianBreakout({
  lookback: 20,
  atrPeriod: 14,
  stopAtr: 3,
  rr: 3,
  trendEma: 200,
});

function loadKeys(): { apiKey: string; apiSecret: string } {
  const envFile = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
  const apiKey = process.env.BINANCE_TESTNET_KEY ?? '';
  const apiSecret = process.env.BINANCE_TESTNET_SECRET ?? '';
  return { apiKey, apiSecret };
}

async function main() {
  console.log('\n=== TESISAT TESTI (Binance testnet) ===');
  console.log(`sembol ${SYMBOL} | mum ${INTERVAL} | kaldirac ${LEVERAGE}x | risk %${RISK_PCT}`);
  console.log(DRY_RUN ? 'KURU MOD — hicbir emir gonderilmeyecek\n' : 'GERCEK EMIR MODU (testnet, sahte para)\n');

  const { apiKey, apiSecret } = loadKeys();
  if (!apiKey || !apiSecret) {
    console.error(
      'Anahtar bulunamadi.\n\n' +
        '1. https://testnet.binancefuture.com adresine GitHub ile giris yap\n' +
        '2. Sayfanin altindaki "API Key" bolumunden anahtar uret\n' +
        '3. Proje kokune .env dosyasi olustur:\n\n' +
        '   BINANCE_TESTNET_KEY=...\n' +
        '   BINANCE_TESTNET_SECRET=...\n',
    );
    process.exit(1);
  }

  const client = new BinanceFuturesClient({ apiKey, apiSecret, testnet: true });

  // 1. Baglanti
  process.stdout.write('1. Hesaba baglaniliyor... ');
  const ping = await client.ping();
  console.log(`tamam. Bakiye ${ping.balanceUsdt.toFixed(2)} USDT, islem izni: ${ping.canTrade}`);
  if (ping.balanceUsdt <= 0) {
    console.error('   Testnet bakiyesi sifir. Testnet panelinden bakiye talep et.');
    process.exit(1);
  }

  const exec = new Executor(
    client,
    { symbol: SYMBOL, leverage: LEVERAGE, riskPct: RISK_PCT, dryRun: DRY_RUN },
    (m) => console.log(m),
  );

  // 2. Sembol kurallari
  process.stdout.write('2. Sembol kurallari aliniyor... ');
  await exec.prepare();
  console.log('tamam.');

  // 3. Ucus oncesi: koruma emri yazilabiliyor mu?
  process.stdout.write('3. Koruma emri destegi sinaniyor... ');
  const canProtect = await exec.canPlaceProtection();
  if (!canProtect.ok) {
    console.log('DESTEKLENMIYOR\n');
    console.error(
      `   Bu borsa STOP_MARKET emrini kabul etmiyor:\n   ${canProtect.reason}\n\n` +
        '   Islem ACILMAYACAK. Sebep: stopu borsaya yazamiyorsak, pozisyonu\n' +
        '   koruyamayiz. Botun hafizasindaki stop, stop degildir — surec\n' +
        '   coker ya da PC uyursa pozisyon savunmasiz kalir.\n\n' +
        '   Bu, kodun degil bu testnet ortaminin sinirlamasi: ayni emirler\n' +
        '   canli borsada standarttir. Kontrol etmeden girseydik her denemede\n' +
        '   gidis-donus komisyonu yanacakti.\n',
    );
    process.exit(1);
  }
  console.log('tamam.');

  // 4. Mutabakat
  process.stdout.write('4. Borsayla mutabakat... ');
  const rec = await exec.reconcile();
  console.log(rec.detail);

  if (rec.hasPosition) {
    console.log('\nAcik pozisyon korunuyor. Yeni sinyal aranmayacak.');
    console.log('Pozisyon stop ya da hedefle kapaninca bot yeniden calistirilabilir.\n');
    return;
  }

  // 4. Sinyal ara
  console.log('4. Mum verisi cekiliyor ve strateji calistiriliyor...');
  const step = INTERVAL_MS[INTERVAL];
  const need = (STRATEGY.warmup + 50) * step;
  const bars = await fetchKlines(SYMBOL, INTERVAL, Date.now() - need, Date.now());

  if (bars.length < STRATEGY.warmup + 2) {
    console.error(`   Yeterli mum yok (${bars.length}, gereken ${STRATEGY.warmup + 2}).`);
    process.exit(1);
  }

  // SON mum henuz KAPANMADI. Strateji yalnizca kapali mumlarla calisir —
  // kapanmamis mumdan sinyal uretmek, backtest'te asla yapmadigimiz seyi
  // canlida yapmak olurdu ve iki sonuc karsilastirilamaz hale gelirdi.
  const closed = bars.slice(0, -1);
  const i = closed.length - 1;
  let signal = STRATEGY.onBar(closed, i);

  const lastClose = new Date(closed[i].closeTime).toLocaleString('tr-TR');
  console.log(`   ${closed.length} kapali mum, sonuncusu ${lastClose}`);

  if (!signal && FORCE) {
    // Yapay sinyal: son kapanistan, ATR benzeri bir mesafeyle.
    const last = closed[i];
    const span = closed.slice(-14);
    const atrLike =
      span.reduce((acc, b) => acc + (b.high - b.low), 0) / span.length;
    const dist = atrLike * 3;

    signal = {
      side: 'LONG',
      stopLoss: last.close - dist,
      takeProfit: last.close + dist * 3,
      reason: 'YAPAY SINYAL — yalnizca tesisat testi, piyasa gorusu DEGIL',
    };

    console.log('\n   Gercek sinyal yok; --force-signal ile YAPAY sinyal uretildi.');
    console.log('   Bu bir islem onerisi DEGIL — emir yolunu sinamak icin.');
  }

  if (!signal) {
    console.log(`\n   Sinyal yok. Strateji: ${STRATEGY.name}`);
    console.log('   Tesisatin geri kalani (emir gonderimi) bu turda sinanmadi.');
    console.log('   Sinyal cikana kadar periyodik calistir, ya da --symbol ile');
    console.log('   baska bir parite dene.');
    console.log('   Ya da tesisati hemen sinamak icin: --force-signal\n');
    return;
  }

  console.log(`\n   SINYAL: ${signal.side} — ${signal.reason}`);
  console.log(`   stop ${signal.stopLoss.toFixed(4)} | hedef ${signal.takeProfit.toFixed(4)}`);

  // 5. Uygula
  console.log('\n5. Emir gonderiliyor...');
  const result = await exec.execute(signal, ping.balanceUsdt);
  console.log(`   [${result.action}] ${result.detail}`);

  if (result.action === 'girildi') {
    console.log('\n6. Borsadaki durum dogrulaniyor...');
    const pos = await client.position(SYMBOL);
    const orders = await client.openOrders(SYMBOL);
    console.log(`   pozisyon: ${pos.positionAmt} @ ${pos.entryPrice}`);
    console.log(`   acik koruma emri: ${orders.length}`);
    for (const o of orders) {
      console.log(`     - ${o.type} @ ${o.stopPrice} (id ${o.orderId})`);
    }
    if (orders.length < 2) {
      console.log('   !! UYARI: iki koruma emri bekleniyordu.');
    } else {
      console.log('\n   Tesisat calisiyor: giris + stop + hedef borsada.');
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error('\nHATA:', e?.message ?? e);
  process.exit(1);
});
