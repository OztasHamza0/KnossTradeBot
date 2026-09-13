import * as fs from 'fs';
import * as path from 'path';
import { BinanceFuturesClient } from '../live/client';

/**
 * KOSU RAPORU — bir soak testinin sonucunu DURUSTCE okumak icin.
 *
 * Neden ayri bir arac: bakiye farkina bakmak yaniltir. Tek bir sayi,
 * "strateji ne kazandi" ile "komisyon ne goturdu" sorularini ayiramaz —
 * ve bu projede olculmek istenen sey tam olarak o ayrim. Backtest motoru
 * komisyonu, kaymayi ve fonlamayi ayri ayri modelliyor; canlida da ayni
 * ayrimi gorebilmeliyiz, yoksa "backtest ile canli tutuyor mu" sorusu
 * cevaplanamaz.
 *
 * Iki kaynagi birlestiriyor:
 *   1. run.log     — botun ne YAPMAK istedigi (giris, stop, hedef, miktar)
 *   2. /fapi/v1/income — borsanin ne OLDUGUNU soyledigi (gerceklesen kar,
 *                        komisyon, fonlama)
 *
 * R KATSAYISI, kayitli riskten degil GERCEKLESEN riskten hesaplanir:
 * miktar x |giris - stop|. Kayitli risk bir donem planlanan degeri
 * tutuyordu ve gercegin 3 katiydi; R muhasebesini ona dayandirmak tum
 * olcumu bozar.
 *
 * Kullanim:  npm run report            (varsayilan: son 24 saat)
 *            npm run report -- 48      (son 48 saat)
 */

const HOURS = parseFloat(process.argv[2] ?? '24');
const MAINNET = process.argv.includes('--mainnet');

interface Giris {
  zaman: number;
  sembol: string;
  yon: 'LONG' | 'SHORT';
  miktar: number;
  giris: number;
  stop: number;
  hedef: number;
  /** GERCEKLESEN risk: miktar x |giris - stop|. */
  risk: number;
}

function keys(): { apiKey: string; apiSecret: string } {
  const file = MAINNET ? '.env.mainnet' : '.env';
  const txt = fs.readFileSync(path.resolve(__dirname, '../../', file), 'utf8');
  const o: Record<string, string> = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) o[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return MAINNET
    ? { apiKey: o.BINANCE_KEY ?? '', apiSecret: o.BINANCE_SECRET ?? '' }
    : { apiKey: o.BINANCE_TESTNET_KEY ?? '', apiSecret: o.BINANCE_TESTNET_SECRET ?? '' };
}

/**
 * run.log'dan girisleri cikarir.
 *
 * Iki satir eslestiriliyor cunku miktar ve gercek dolum fiyati "giris doldu"
 * satirinda, stop/hedef ise "[girildi]" satirinda. Tek satira guvenmek,
 * marj tavani miktari kirptiginda yanlis miktar okumak demekti.
 */
function girisleriOku(logPath: string, since: number): Giris[] {
  if (!fs.existsSync(logPath)) return [];
  const satirlar = fs.readFileSync(logPath, 'utf8').split('\n');
  const out: Giris[] = [];

  const re =
    /^\[([^\]]+)\]\s+\[girildi\]\s+(LONG|SHORT)\s+([\d.]+)\s+(\w+)\s+@\s+~([\d.]+)\s+\|\s+stop\s+([\d.]+)\s+\|\s+hedef\s+([\d.]+)/;

  for (const s of satirlar) {
    const m = s.match(re);
    if (!m) continue;
    const zaman = Date.parse(m[1]);
    if (!Number.isFinite(zaman) || zaman < since) continue;
    const miktar = parseFloat(m[3]);
    const giris = parseFloat(m[5]);
    const stop = parseFloat(m[6]);
    out.push({
      zaman,
      yon: m[2] as 'LONG' | 'SHORT',
      miktar,
      sembol: m[4],
      giris,
      stop,
      hedef: parseFloat(m[7]),
      risk: miktar * Math.abs(giris - stop),
    });
  }
  return out;
}

function tl(n: number, w = 9): string {
  return n.toFixed(2).padStart(w);
}

(async () => {
  const k = keys();
  if (!k.apiKey || !k.apiSecret) {
    console.error('API anahtari bulunamadi.');
    process.exit(1);
  }

  const since = Date.now() - HOURS * 3600_000;
  const c = new BinanceFuturesClient({ ...k, testnet: !MAINNET });

  console.log('='.repeat(78));
  console.log(`KOSU RAPORU — son ${HOURS} saat  (${MAINNET ? 'CANLI' : 'TESTNET'})`);
  console.log('='.repeat(78));

  const girisler = girisleriOku(path.resolve(__dirname, '../../run.log'), since);
  const gelir = await c.income(since);

  // --- Borsanin gercegi: kalem kalem ---
  const kalem = (t: string) =>
    gelir.filter((g) => g.incomeType === t).reduce((a, g) => a + parseFloat(g.income), 0);

  const realized = kalem('REALIZED_PNL');
  const komisyon = kalem('COMMISSION');
  const fonlama = kalem('FUNDING_FEE');
  const net = realized + komisyon + fonlama;

  // --- Sembol bazinda ---
  const semboller = Array.from(new Set(gelir.map((g) => g.symbol).filter(Boolean))).sort();

  console.log('');
  console.log('SEMBOL BAZINDA (borsanin gelir kaydindan)');
  console.log('-'.repeat(78));
  console.log('SEMBOL      GERCEKLESEN   KOMISYON    FONLAMA        NET   ISLEM');
  for (const s of semboller) {
    const g = gelir.filter((x) => x.symbol === s);
    const r = g.filter((x) => x.incomeType === 'REALIZED_PNL').reduce((a, x) => a + parseFloat(x.income), 0);
    const ko = g.filter((x) => x.incomeType === 'COMMISSION').reduce((a, x) => a + parseFloat(x.income), 0);
    const fo = g.filter((x) => x.incomeType === 'FUNDING_FEE').reduce((a, x) => a + parseFloat(x.income), 0);
    const adet = girisler.filter((x) => x.sembol === s).length;
    console.log(`${s.padEnd(11)} ${tl(r, 11)} ${tl(ko, 10)} ${tl(fo, 10)} ${tl(r + ko + fo, 10)} ${String(adet).padStart(7)}`);
  }

  console.log('-'.repeat(78));
  console.log(`${'TOPLAM'.padEnd(11)} ${tl(realized, 11)} ${tl(komisyon, 10)} ${tl(fonlama, 10)} ${tl(net, 10)}   ${girisler.length}`);

  // --- Islem listesi ve R katsayilari ---
  console.log('');
  console.log('ACILAN ISLEMLER (run.log)');
  console.log('-'.repeat(78));
  console.log('ZAMAN(UTC)        SEMBOL     YON     MIKTAR      GIRIS   GERCEK RISK');
  for (const g of girisler) {
    console.log(
      `${new Date(g.zaman).toISOString().slice(5, 19).replace('T', ' ')}  ` +
        `${g.sembol.padEnd(10)} ${g.yon.padEnd(6)} ${String(g.miktar).padStart(9)} ` +
        `${g.giris.toFixed(4).padStart(10)} ${tl(g.risk, 12)}`,
    );
  }

  const toplamRisk = girisler.reduce((a, g) => a + g.risk, 0);
  const ortRisk = girisler.length ? toplamRisk / girisler.length : 0;

  // --- Ozet ---
  console.log('');
  console.log('OZET');
  console.log('-'.repeat(78));
  console.log(`acilan islem              : ${girisler.length}`);
  console.log(`gerceklesen kar/zarar     : ${realized.toFixed(2)} USDT`);
  console.log(`komisyon                  : ${komisyon.toFixed(2)} USDT`);
  console.log(`fonlama                   : ${fonlama.toFixed(2)} USDT`);
  console.log(`NET                       : ${net.toFixed(2)} USDT`);
  console.log('');
  console.log(`ortalama gerceklesen risk : ${ortRisk.toFixed(2)} USDT  (islem basina 1R)`);
  if (ortRisk > 0) {
    console.log(`net, R cinsinden          : ${(net / ortRisk).toFixed(2)} R`);
    console.log(`islem basina beklenti     : ${(net / ortRisk / Math.max(1, girisler.length)).toFixed(3)} R`);
  }
  if (girisler.length) {
    const min = Math.min(...girisler.map((g) => g.risk));
    const max = Math.max(...girisler.map((g) => g.risk));
    console.log(`risk araligi              : ${min.toFixed(2)} — ${max.toFixed(2)} USDT  (${(max / min).toFixed(1)}x savrulma)`);
  }
  const oran = realized !== 0 ? Math.abs(komisyon / realized) * 100 : NaN;
  if (Number.isFinite(oran)) {
    console.log(`komisyon / gerceklesen    : %${oran.toFixed(1)}`);
  }

  console.log('');
  console.log('!'.repeat(78));
  console.log('DIKKAT: bu kadar az islemde kar/zarar ISTATISTIKSEL OLARAK ANLAMSIZDIR.');
  console.log('+0.05R\'lik bir edge\'i gorebilmek icin 4361 islem gerektigi olculdu.');
  console.log('Bakilacak sey: hata sayisi, korumanin her islemde yerine oturmasi,');
  console.log('ve gerceklesen riskin planlanandan ne kadar saptigi.');
  console.log('!'.repeat(78));
})();
