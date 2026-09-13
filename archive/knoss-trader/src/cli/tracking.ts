import * as fs from 'fs';
import * as path from 'path';
import { fetchKlines } from '../data/binance';
import { INTERVAL_MS } from '../data/types';
import { BinanceFuturesClient } from '../live/client';
import { DEFAULT_CONFIG } from '../backtest/types';

/**
 * TAKIP TESTI — canli, backtest'in MODELLEDIGI gibi mi davraniyor?
 *
 * NEDEN BU TEST VAR:
 *   "Bot dogru secimler yapiyor mu?" sorusunun cevabini canli kosu AYLARCA
 *   veremez. Islem sonucunun standart sapmasi 1.685 R; +0.05 R'lik bir
 *   edge'i gormek 4.363 islem, yani gunde 12 islemle 12 AY eder. Bir aylik
 *   canli kosu yalnizca 0.17 R ve uzeri etkileri gorebilir.
 *
 *   O soruyu backtest zaten cevapladi ve cok daha hizli: 16 sembolde
 *   1 saatlik veriyle ts-momentum 4.117 islem uretti — 11 AYLIK canli
 *   kosuya denk, ve 20 saniyede kosuyor.
 *
 *   Ama backtest'in cevabina guvenmek icin bir sartimiz var: canlinin
 *   backtest'in MODELLEDIGI gibi davranmasi. Model iyimserse (kayma daha
 *   az, komisyon daha ucuz varsayilmissa) backtest'in "edge yok" hukmu
 *   bile FAZLA IYIMSER olur.
 *
 * NEDEN HIZLI CEVAP VERIR:
 *   Bu bir ESLESTIRILMIS karsilastirma. Her islem icin "model ne dedi,
 *   gercekte ne oldu" farkina bakiyoruz. O farkin gurultusu islem
 *   sonucunun gurultusu (1.685 R) DEGIL — binde birkac. Sistematik bir
 *   sapmayi 20-30 islemde gorursun.
 *
 * NE OLCUYOR:
 *   1. KAYMA — canli dolum fiyati vs motorun modeli (sonraki mumun acilisi)
 *   2. KOMISYON — borsanin gercek kesintisi vs modeldeki %0.05/yon
 *   3. SINYAL SADAKATI — canli giris, mumun kapanisindan ne kadar sonra
 *      gerceklesti (motor "hemen sonraki acilis" varsayiyor)
 *
 * Kullanim:  npm run tracking            (son 24 saat)
 *            npm run tracking -- 48
 */

const HOURS = parseFloat(process.argv[2] ?? '24');
const INTERVAL = process.argv[3] ?? '1h';

interface Giris {
  zaman: number;
  sembol: string;
  yon: 'LONG' | 'SHORT';
  miktar: number;
  dolum: number;
}

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

/** run.log'daki "giris doldu" satirlari — GERCEK dolum fiyatini tasiyan tek yer. */
function girisleriOku(since: number): Giris[] {
  const p = path.resolve(__dirname, '../../run.log');
  if (!fs.existsSync(p)) return [];
  const satirlar = fs.readFileSync(p, 'utf8').split('\n');
  const out: Giris[] = [];

  // Yon "[girildi]" satirinda; dolum fiyati "giris doldu" satirinda.
  // Ikisi ardisik geldigi icin son gorulen yonu tasiyoruz.
  const reDoldu = /^\[([^\]]+)\]\s+\[(\w+)\]\s+giris doldu:\s+([\d.]+)\s+@\s+([\d.]+)/;
  const reGirildi = /\[girildi\]\s+(LONG|SHORT)\s+[\d.]+\s+(\w+)/;

  let bekleyen: Omit<Giris, 'yon'> | null = null;
  for (const s of satirlar) {
    const d = s.match(reDoldu);
    if (d) {
      const zaman = Date.parse(d[1]);
      if (Number.isFinite(zaman) && zaman >= since) {
        bekleyen = {
          zaman,
          sembol: d[2],
          miktar: parseFloat(d[3]),
          dolum: parseFloat(d[4]),
        };
      }
      continue;
    }
    const g = s.match(reGirildi);
    if (g && bekleyen && g[2] === bekleyen.sembol) {
      out.push({ ...bekleyen, yon: g[1] as 'LONG' | 'SHORT' });
      bekleyen = null;
    }
  }
  return out;
}

const yuzde = (n: number, d = 3) => (n >= 0 ? '+' : '') + n.toFixed(d) + '%';

(async () => {
  const since = Date.now() - HOURS * 3600_000;
  const girisler = girisleriOku(since);

  console.log('='.repeat(84));
  console.log(`TAKIP TESTI — canli, backtest'in modeli gibi mi davraniyor?`);
  console.log(`son ${HOURS} saat | ${INTERVAL} | ${girisler.length} giris`);
  console.log('='.repeat(84));

  if (!girisler.length) {
    console.log('');
    console.log('Bu pencerede giris yok. Bot calistiktan sonra tekrar dene.');
    return;
  }

  const step = INTERVAL_MS[INTERVAL];
  const kaymalar: number[] = [];

  console.log('');
  console.log('SEMBOL      ZAMAN(UTC)   YON     CANLI DOLUM        MODEL       KAYMA   GECIKME');
  console.log('-'.repeat(84));

  for (const g of girisler) {
    // Motor girisi "sinyal mumunun kapanisindan SONRAKI mumun acilisindan"
    // yapiyor. Canli dolum o mumun icinde bir yerde gerceklesti; o mumun
    // ACILISI modelin varsaydigi fiyat.
    const mumBasi = Math.floor(g.zaman / step) * step;
    const bars = await fetchKlines(
      g.sembol,
      INTERVAL,
      mumBasi - step,
      mumBasi + step,
    ).catch(() => [] as any[]);
    const mum = bars.find((b: any) => b.openTime === mumBasi);
    if (!mum) {
      console.log(`${g.sembol.padEnd(11)} mum verisi alinamadi — atlaniyor`);
      continue;
    }

    // Kayma ALEYHTE oldugunda pozitif: LONG'da daha PAHALI dolmak kotudur.
    const ham = ((g.dolum - mum.open) / mum.open) * 100;
    const kayma = g.yon === 'LONG' ? ham : -ham;
    kaymalar.push(kayma);

    const gecikmeSn = (g.zaman - mumBasi) / 1000;
    console.log(
      `${g.sembol.padEnd(11)} ${new Date(g.zaman).toISOString().slice(11, 19)}   ` +
        `${g.yon.padEnd(6)}${g.dolum.toFixed(6).padStart(13)}` +
        `${mum.open.toFixed(6).padStart(13)}` +
        `${yuzde(kayma).padStart(12)}` +
        `${(gecikmeSn.toFixed(0) + ' sn').padStart(10)}`,
    );
  }

  if (!kaymalar.length) {
    console.log('\nKarsilastirilabilir giris yok.');
    return;
  }

  // --- Kayma ozeti ---
  const n = kaymalar.length;
  const ort = kaymalar.reduce((a, b) => a + b, 0) / n;
  const varyans =
    n > 1 ? kaymalar.reduce((a, b) => a + (b - ort) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(varyans);
  const se = n > 0 ? sd / Math.sqrt(n) : NaN;
  const model = DEFAULT_CONFIG.slippagePct;
  const ortGecikme = girisler.reduce((a,g)=>a+((g.zaman - Math.floor(g.zaman/step)*step)/1000),0)/girisler.length;

  console.log('-'.repeat(84));
  console.log('');
  console.log('MODEL SAPMASI (canli dolum vs mum acilisi)');
  console.log(`  olculen ortalama : ${yuzde(ort)}  (n=${n}, sd ${sd.toFixed(3)})`);
  console.log(`  model varsayimi  : ${yuzde(model)}`);
  if (Number.isFinite(se) && se > 0) {
    console.log(
      `  %95 GA           : [${yuzde(ort - 1.96 * se)}, ${yuzde(ort + 1.96 * se)}]`,
    );
    const z = (ort - model) / se;
    console.log(
      `  model iyimser mi : ${
        ort > model && Math.abs(z) >= 2
          ? `EVET — olculen kayma modelden ${(ort / model).toFixed(1)} kat buyuk (z=${z.toFixed(1)})`
          : Math.abs(z) < 2
            ? 'FARK ANLAMLI DEGIL (model tutuyor)'
            : 'HAYIR — model muhafazakar'
      }`,
    );
    // Bu testin asil degeri: ne kadar cabuk cevap verdigi.
    const hedef = model; // modelin kendisi kadar bir sapmayi gormek istiyoruz
    const gereken = Math.ceil(Math.pow((1.96 * sd) / hedef, 2));
    console.log('');
    console.log(
      `  Modelin kendisi kadar (${yuzde(model)}) bir sapmayi gormek icin gereken giris: ${gereken}`,
    );
    console.log(`  Elimizde: ${n}`);
    console.log(
      `  Kiyas: +0.05 R'lik bir EDGE'i gormek icin 4.363 islem gerekiyordu.`,
    );
  }

  // --- Komisyon ---
  const k = keys();
  if (k.apiKey && k.apiSecret) {
    const c = new BinanceFuturesClient({ ...k, testnet: true });
    const gelir = await c.income(since).catch(() => [] as any[]);
    const kom = Math.abs(
      gelir
        .filter((x: any) => x.incomeType === 'COMMISSION')
        .reduce((a: number, x: any) => a + parseFloat(x.income), 0),
    );
    const notional = girisler.reduce((a, g) => a + g.miktar * g.dolum, 0);
    // Komisyon her DOLUMDA kesilir: giris bir bacak, cikis bir bacak.
    // "2 x giris notional" varsaymak, cikislarin henuz olmadigi bir
    // pencerede orani YARIYA dusururdu. Gercek bacak sayisini gelir
    // kaydindaki COMMISSION satir sayisindan aliyoruz.
    const bacak = gelir.filter((x: any) => x.incomeType === 'COMMISSION').length;
    const ortNotional = girisler.length ? notional / girisler.length : 0;
    if (notional > 0 && kom > 0) {
      // Girisler tek yon; cikislar da olduysa gelir kaydinda onlar da var.
      // Bu yuzden ust sinir olarak "giris notional x 2 yon" aliniyor.
      const olculen = bacak > 0 && ortNotional > 0
        ? (kom / (bacak * ortNotional)) * 100
        : NaN;
      console.log('');
      console.log('KOMISYON');
      console.log(`  olculen : ${olculen.toFixed(4)}% / yon  (${bacak} bacak)`);
      console.log(`  model   : ${DEFAULT_CONFIG.feePct.toFixed(4)}% / yon`);
      console.log(
        `  ${
          olculen > DEFAULT_CONFIG.feePct
            ? 'MODEL IYIMSER — backtest gercekten oldugundan ucuz varsayiyor'
            : 'model muhafazakar — backtest gercekten pahali varsayiyor'
        }`,
      );
    }
  }

  console.log('');
  console.log('='.repeat(84));
  console.log('NASIL OKUNMALI');
  console.log('-'.repeat(84));
  console.log('Bu test "strateji ise yariyor mu" sorusuna CEVAP VERMEZ — o soruyu');
  console.log('canli kosu aylarca cevaplayamaz, ve backtest zaten cevapladi.');
  console.log('');
  console.log('Bu testin cevapladigi soru: BACKTESTE GUVENEBILIR MIYIZ?');
  console.log('Model iyimserse (kayma az, komisyon ucuz varsayilmissa) backtest\'in');
  console.log('"edge yok" hukmu bile FAZLA IYIMSER demektir — yani gercek daha kotu.');
  console.log('');
  console.log('SAPMA = kayma + GECIKME. Gecikme buyukse (mumun kucuk bir');
  console.log('kesrinden fazlasi) sapmanin cogu kayma degil, fiyatin o arada');
  console.log('gitmesidir. Motor girisi mumun ACILISINDA varsayiyor.');
  console.log('');
  console.log('Ve bu soru HIZLI cevaplanir, cunku esleştirilmis bir karsilastirma:');
  console.log('gurultu, islem sonucunun gurultusu degil, dolum farkinin gurultusu.');
})();
