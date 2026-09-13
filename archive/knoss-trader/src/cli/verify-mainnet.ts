import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import * as crypto from 'crypto';

/**
 * CANLI BORSA DOGRULAMASI — SIFIR RISK.
 *
 * Bu dosya bilerek Executor'i ve marketEntry'yi KULLANMIYOR. Yalnizca iki
 * sey yapabilir:
 *   1. GET ile okuma (bakiye, pozisyon, acik emir, izinler)
 *   2. /fapi/v1/order/test — emri GONDERMEDEN gecerliligini dogrular
 *
 * Yani bu script gercek bir emir acamaz, pozisyon degistiremez, para
 * harcayamaz. Tasarim boyle: para riske atan kod ile dogrulama yapan kod
 * ayni dosyada olmamali, yanlislikla calistirilmasi mumkun olmasin.
 *
 * Cevapladigi soru: canli borsa STOP_MARKET ve TAKE_PROFIT_MARKET emirlerini
 * benim gonderdigim parametrelerle kabul ediyor mu? Testnet etmiyordu.
 */

const BASE = 'https://fapi.binance.com';

function loadKeys(): { key: string; secret: string } {
  const f = path.resolve(__dirname, '../../.env.mainnet');
  if (!fs.existsSync(f)) {
    console.error('.env.mainnet bulunamadi.');
    process.exit(1);
  }
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return { key: env.BINANCE_KEY ?? '', secret: env.BINANCE_SECRET ?? '' };
}

const { key, secret } = loadKeys();

function sign(params: Record<string, any>): string {
  const q = Object.entries({ ...params, timestamp: Date.now(), recvWindow: 10000 })
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const sig = crypto.createHmac('sha256', secret).update(q).digest('hex');
  return `${q}&signature=${sig}`;
}

async function get<T>(pathname: string, params: Record<string, any> = {}): Promise<T> {
  const r = await axios.get<T>(`${BASE}${pathname}?${sign(params)}`, {
    headers: { 'X-MBX-APIKEY': key },
    timeout: 20000,
  });
  return r.data;
}

/** SADECE dogrulama ucu. Gercek emir ucu bu dosyada YOK. */
async function orderTest(params: Record<string, any>): Promise<void> {
  await axios.post(`${BASE}/fapi/v1/order/test?${sign(params)}`, null, {
    headers: { 'X-MBX-APIKEY': key },
    timeout: 20000,
  });
}

function err(e: any): string {
  const d = e?.response?.data;
  return d?.msg ? `${d.code}: ${d.msg}` : (e?.message ?? String(e));
}

async function main() {
  console.log('\n=== CANLI BORSA DOGRULAMASI (sifir risk, emir GONDERILMEZ) ===\n');

  // --- 1. Hesap ---
  console.log('1. HESAP');
  let acc: any;
  try {
    acc = await get<any>('/fapi/v2/account');
  } catch (e) {
    console.error('   Baglanti basarisiz: ' + err(e));
    console.error('   Anahtar yanlis olabilir, ya da IP kisitlamasi var.');
    process.exit(1);
  }
  const usdt = (acc.assets ?? []).find((a: any) => a.asset === 'USDT');
  const wallet = parseFloat(usdt?.walletBalance ?? '0');
  const avail = parseFloat(usdt?.availableBalance ?? '0');
  console.log(`   Futures cuzdan : ${wallet.toFixed(2)} USDT`);
  console.log(`   Kullanilabilir : ${avail.toFixed(2)} USDT`);
  console.log(`   Islem izni     : ${acc.canTrade}`);
  console.log(`   Toplam teminat : ${parseFloat(acc.totalMarginBalance ?? '0').toFixed(2)} USDT`);

  // --- 2. Anahtar izinleri — para cekme acik mi? ---
  console.log('\n2. ANAHTAR IZINLERI');
  try {
    const q = Object.entries({ timestamp: Date.now(), recvWindow: 10000 })
      .map(([k, v]) => `${k}=${v}`).join('&');
    const sig = crypto.createHmac('sha256', secret).update(q).digest('hex');
    const r = await axios.get<any>(
      `https://api.binance.com/sapi/v1/account/apiRestrictions?${q}&signature=${sig}`,
      { headers: { 'X-MBX-APIKEY': key }, timeout: 20000 },
    );
    const p = r.data;
    console.log(`   Para cekme     : ${p.enableWithdrawals ? '!!! ACIK — KAPAT !!!' : 'kapali (dogru)'}`);
    console.log(`   Futures islem  : ${p.enableFutures ? 'acik' : 'kapali'}`);
    console.log(`   IP kisitlamasi : ${p.ipRestrict ? 'var (iyi)' : 'yok'}`);
  } catch (e) {
    console.log('   Izin bilgisi okunamadi (anahtarda spot yetkisi yok olabilir): ' + err(e));
  }

  // --- 3. Mevcut durum — dokunmuyoruz, sadece bakiyoruz ---
  console.log('\n3. MEVCUT POZISYONLAR (dokunulmuyor)');
  const positions = await get<any[]>('/fapi/v2/positionRisk');
  const open = positions.filter((p) => Math.abs(parseFloat(p.positionAmt)) > 0);
  if (open.length === 0) {
    console.log('   Acik pozisyon yok.');
  } else {
    for (const p of open) {
      console.log(
        `   ${p.symbol}: ${p.positionAmt} @ ${p.entryPrice} | ` +
          `PnL ${parseFloat(p.unRealizedProfit).toFixed(2)} USDT | ${p.leverage}x`,
      );
    }
    console.log('   !! Bu pozisyonlara HIC dokunulmayacak.');
  }

  const allOrders = await get<any[]>('/fapi/v1/openOrders');
  console.log(`   Acik emir: ${allOrders.length}`);
  for (const o of allOrders.slice(0, 10)) {
    console.log(`     - ${o.symbol} ${o.type} ${o.side} @ ${o.stopPrice || o.price}`);
  }

  // --- 4. ASIL SORU: koruma emirleri kabul ediliyor mu? ---
  console.log('\n4. KORUMA EMRI DOGRULAMASI (emir GONDERILMEZ, sadece sinanir)');

  const info = await axios.get<any>(`${BASE}/fapi/v1/exchangeInfo`, { timeout: 20000 });
  const testSymbols = ['SOLUSDT', 'BTCUSDT'];

  for (const symbol of testSymbols) {
    const s = info.data.symbols.find((x: any) => x.symbol === symbol);
    const pf = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
    const tick = parseFloat(pf.tickSize);
    const prec = s.pricePrecision;

    const mk = await axios.get<any>(`${BASE}/fapi/v1/premiumIndex`, {
      params: { symbol }, timeout: 20000,
    });
    const mark = parseFloat(mk.data.markPrice);

    // Tetiklenmesi imkansiz fiyatlar — yalnizca emrin KABUL edilip
    // edilmedigi sinaniyor, hicbir sey gonderilmiyor.
    const round = (v: number) => (Math.floor(v / tick) * tick).toFixed(prec);
    const stopPx = round(mark * 0.5);
    const tpPx = round(mark * 1.5);

    console.log(`\n   ${symbol} (mark ${mark.toFixed(prec)})`);

    for (const [label, params] of [
      ['STOP_MARKET (closePosition)', {
        symbol, side: 'SELL', type: 'STOP_MARKET',
        stopPrice: stopPx, closePosition: 'true', workingType: 'MARK_PRICE',
      }],
      ['TAKE_PROFIT_MARKET (closePosition)', {
        symbol, side: 'SELL', type: 'TAKE_PROFIT_MARKET',
        stopPrice: tpPx, closePosition: 'true', workingType: 'MARK_PRICE',
      }],
    ] as [string, Record<string, any>][]) {
      try {
        await orderTest(params);
        console.log(`     ${label.padEnd(36)} KABUL`);
      } catch (e) {
        console.log(`     ${label.padEnd(36)} RED  ${err(e)}`);
      }
    }
  }

  console.log('\n=== BITTI. Hicbir emir gonderilmedi, hicbir pozisyon degismedi. ===\n');
}

main().catch((e) => {
  console.error('\nHATA: ' + err(e));
  process.exit(1);
});
