import * as fs from 'fs';
import * as path from 'path';
import { BinanceFuturesClient } from '../live/client';
import { loadState } from '../live/state';
import { korumaDurumu } from '../live/protection';

/**
 * NOBET KONTROLU — borsanin gercegi ile botun kaydini karsilastirir.
 *
 * NEDEN AYRI ARAC: bu kontrol gozetimsiz bir gece boyunca yarim saatte bir
 * kosuyor ve her seferinde elle yeniden yazilmasi iki risk uretiyordu —
 * her yazimda biraz farkli olmasi, ve acele edilince bir adimin atlanmasi.
 * Kontrolun kendisi de kod; koda girmesi lazim.
 *
 * NEDEN verify-mainnet.ts DEGIL: o arac botun KULLANMADIGI emir ucunu
 * dogruluyor ve algo (koruma) emirlerini hic gormuyor — yani "her sey
 * yolunda" dedigi bir durumda pozisyon korumasiz olabilir. Denetimde
 * bulundu; nobette kullanilmamali.
 *
 * Cikis kodu 0 = temiz, 1 = mudahale gerekiyor. Boylece bir betikten
 * kosulup sonucu dogrudan okunabilir.
 *
 * Kullanim:  npm run check
 *            npm run check -- --symbols=BTCUSDT,ETHUSDT
 */

const DEFAULT_SYMBOLS =
  'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,' +
  'LINKUSDT,DOTUSDT,LTCUSDT,NEARUSDT,ATOMUSDT,UNIUSDT,FILUSDT,APTUSDT,' +
  'ARBUSDT,OPUSDT,INJUSDT,SUIUSDT';

const args = process.argv.slice(2);
const val = (k: string, d: string) =>
  args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;

const SYMBOLS = val('symbols', DEFAULT_SYMBOLS)
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

/**
 * Mainnet BILEREK desteklenmiyor: bu arac yalnizca OKUR ama yanlis hesaba
 * baglanip "her sey yolunda" demek, gozetimsiz bir gecede en pahali hata
 * olurdu. Mainnet kontrolu ayri ve bilincli bir is olmali.
 */
function keys(): { apiKey: string; apiSecret: string } {
  const txt = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
  const o: Record<string, string> = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return {
    apiKey: o.BINANCE_TESTNET_KEY ?? '',
    apiSecret: o.BINANCE_TESTNET_SECRET ?? '',
  };
}

const saat = (t: number) => {
  const d = new Date(t);
  const utc = d.toISOString().slice(11, 19);
  const tr = new Date(t + 3 * 3600_000).toISOString().slice(11, 19);
  return `${tr} (UTC+3) / ${utc} UTC`;
};

(async () => {
  const k = keys();
  if (!k.apiKey || !k.apiSecret) {
    console.error('Testnet API anahtari bulunamadi (.env).');
    process.exit(1);
  }
  const c = new BinanceFuturesClient({ ...k, testnet: true });

  console.log(`NOBET KONTROLU — ${saat(Date.now())}  (TESTNET)`);
  console.log('='.repeat(78));

  const acct = await c.ping();
  console.log(
    `ozkaynak ${acct.equityUsdt.toFixed(2)} USDT  |  ` +
      `kullanilabilir ${acct.balanceUsdt.toFixed(2)} USDT  ` +
      `(%${((acct.balanceUsdt / acct.equityUsdt) * 100).toFixed(0)} serbest)`,
  );

  // Nabiz — surec ayakta olsa bile dongusu kilitlenmis olabilir.
  const hbPath = path.resolve(__dirname, '../../heartbeat.json');
  let hbYas = NaN;
  if (fs.existsSync(hbPath)) {
    try {
      const hb = JSON.parse(fs.readFileSync(hbPath, 'utf8'));
      hbYas = (Date.now() - Date.parse(hb.at)) / 1000;
      console.log(
        `nabiz: tik ${hb.tick}, ${hbYas.toFixed(0)} sn once, ` +
          `${hb.trades} islem / ${hb.signals} sinyal / ${hb.errors} hata`,
      );
    } catch {
      console.log('nabiz: heartbeat.json OKUNAMADI');
    }
  } else {
    console.log('nabiz: heartbeat.json YOK');
  }

  const state = loadState(Date.now(), acct.equityUsdt);
  console.log('');

  let acik = 0;
  let sorun = 0;
  let toplamRisk = 0;

  for (const s of SYMBOLS) {
    const p = await c.position(s).catch(() => null);

    // "Okuyamadim" ile "pozisyon yok" AYNI SEY DEGIL — bu ayrim bu projede
    // iki kez para kaybettirebilecek hataya yol acti.
    if (p === null) {
      console.log(`${s.padEnd(10)} !! POZISYON OKUNAMADI`);
      sorun++;
      continue;
    }

    const kayitli = Boolean(state.positions[s]);
    if (Math.abs(p.positionAmt) === 0) {
      if (kayitli) {
        console.log(`${s.padEnd(10)} !! KAYITTA VAR, BORSADA YOK`);
        sorun++;
      }
      continue;
    }

    acik++;
    const algo = await c.openAlgoOrders(s).catch(() => null);
    if (algo === null) {
      console.log(`${s.padEnd(10)} !! KORUMA EMIRLERI OKUNAMADI`);
      sorun++;
      continue;
    }

    const long = p.positionAmt > 0;
    /**
     * Koruma tanima ORTAK modulden.
     *
     * Buradaki suzgec executor.ts'teki hasMatchingStop ile AYRI yazilmisti ve
     * ayrismislardi: burasi hedefi yalnizca TIPINE bakarak sayiyordu (yon ve
     * tetigin hangi tarafta oldugu denetlenmiyordu), executor ise hedefi hic
     * saymiyordu. Ayni soruya iki farkli cevap veren bir sistemde hangisinin
     * dogru oldugu bilinemez — nobet araci "KORUMASIZ" derken bot "korunuyor"
     * diyebiliyordu.
     */
    const koruma = korumaDurumu(algo, p.positionAmt, p.entryPrice);
    const stops = koruma.stops;
    const tps = koruma.tps;

    const st = koruma.stopTrigger;
    const risk = Number.isFinite(st)
      ? Math.abs(p.positionAmt) * Math.abs(p.entryPrice - st)
      : NaN;
    if (Number.isFinite(risk)) toplamRisk += risk;

    const korumali = stops.length >= 1 && tps.length >= 1;
    if (!korumali) sorun++;
    if (!kayitli) sorun++;

    console.log(
      `${s.padEnd(10)} ${long ? 'LONG ' : 'SHORT'} ${String(p.positionAmt).padStart(9)}` +
        ` @ ${p.entryPrice.toFixed(4).padStart(10)}` +
        `  PnL ${p.unrealizedProfit.toFixed(2).padStart(7)}` +
        `  koruma ${stops.length}+${tps.length}` +
        `  risk ${Number.isFinite(risk) ? risk.toFixed(2).padStart(6) : '     ?'}` +
        `${korumali ? '' : '  << KORUMASIZ'}${kayitli ? '' : '  << KAYITTA YOK'}`,
    );
  }

  // Nabiz bayatsa surec ayakta olsa bile dongu donmuyordur.
  if (Number.isFinite(hbYas) && hbYas > 300) {
    console.log(`\n!! NABIZ BAYAT: ${hbYas.toFixed(0)} sn — dongu kilitlenmis olabilir`);
    sorun++;
  }

  console.log('');
  console.log(
    `acik pozisyon: ${acik}  |  sorun: ${sorun}  |  ` +
      `borsadan olculen toplam risk: ${toplamRisk.toFixed(2)} USDT ` +
      `(=%${((toplamRisk / acct.equityUsdt) * 100).toFixed(2)})`,
  );
  console.log(
    sorun === 0
      ? '>> TEMIZ: her pozisyon korunuyor, kayit borsayla tutuyor.'
      : '>> !!! MUDAHALE GEREKIYOR',
  );
  process.exit(sorun === 0 ? 0 : 1);
})().catch((e) => {
  console.error('KONTROL BASARISIZ:', e?.message ?? e);
  process.exit(1);
});
