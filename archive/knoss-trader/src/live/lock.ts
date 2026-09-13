import * as fs from 'fs';
import * as path from 'path';

/**
 * TEK KOPYA KILIDI.
 *
 * Ayni hesapta iki bot calisirsa:
 *  - Risk IKIYE KATLANIR: her ikisi de "en fazla 4 pozisyon, toplam %4
 *    risk" sanir, gercekte 8 pozisyon ve %8 risk olur.
 *  - Guvenlik sinirlari SUREC BASINA olur: iki bot x %15 zarar siniri =
 *    fiilen %30. run.ts bu tehlikeyi "neden tek surec" yorumunda zaten
 *    anlatiyor ama HICBIR SEY engellemiyordu.
 *  - Durum dosyasi birbirini ezer; sonra her ikisi de kendi pozisyonunu
 *    "yabanci" sanip durur.
 *
 * Kaza senaryosu basit: terminal penceresi kapanmadan ikinci kez
 * "npm run bot:testnet" yazmak. Ya da nobet betiginin, aslinda yasayan
 * bir botu olmus sanip yenisini baslatmasi.
 *
 * BAYAT KILIT SORUNU: bot cokerse kilit dosyasi kalir. Bu yuzden yalnizca
 * dosyanin varligina bakmiyoruz — icindeki PID'in GERCEKTEN yasayip
 * yasamadigini kontrol ediyoruz. process.kill(pid, 0) sinyal GONDERMEZ,
 * yalnizca surecin var olup olmadigini sorar (Windows'ta da calisir).
 */

export interface LockInfo {
  pid: number;
  at: number;
  argv: string;
}

const FILE =
  process.env.BOT_LOCK_FILE ?? path.resolve(__dirname, '../../bot.lock');

export function lockFilePath(): string {
  return FILE;
}

/** Surec gercekten yasiyor mu? */
function yasiyorMu(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Sinyal 0 = "var mi" sorusu; surec yoksa ESRCH firlatir.
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM = surec VAR ama baska kullaniciya ait. Yasiyor sayilir:
    // "izin yok" ile "yok" ayni sey degil.
    return e?.code === 'EPERM';
  }
}

export type LockSonuc =
  | { ok: true; bayatAlindi: boolean }
  | { ok: false; sahip: LockInfo };

/**
 * Kilidi almaya calisir.
 *
 * Bozuk ya da bayat (sahibi olmus) bir kilit devralinir — o durumda
 * bayatAlindi: true doner ki cagiran taraf loglayabilsin.
 */
export function acquireLock(): LockSonuc {
  let bayatAlindi = false;

  if (fs.existsSync(FILE)) {
    let info: LockInfo | null = null;
    try {
      info = JSON.parse(fs.readFileSync(FILE, 'utf8')) as LockInfo;
    } catch {
      info = null; // bozuk dosya = bayat sayilir
    }

    if (info && info.pid !== process.pid && yasiyorMu(info.pid)) {
      return { ok: false, sahip: info };
    }
    bayatAlindi = true;
  }

  const benim: LockInfo = {
    pid: process.pid,
    at: Date.now(),
    argv: process.argv.slice(2).join(' '),
  };
  fs.writeFileSync(FILE, JSON.stringify(benim, null, 2));
  return { ok: true, bayatAlindi };
}

/**
 * Kilidi birakir — YALNIZCA bizimse.
 *
 * Sahiplik kontrolu sart: bayat kilidi devralan baska bir surec varsa,
 * bizim cikisimiz ONUN kilidini silmemeli.
 */
export function releaseLock(): void {
  try {
    if (!fs.existsSync(FILE)) return;
    const info = JSON.parse(fs.readFileSync(FILE, 'utf8')) as LockInfo;
    if (info.pid === process.pid) fs.unlinkSync(FILE);
  } catch {
    // Kilidi birakamamak botu durdurmamali; bir sonraki calistirma
    // bayat kilidi zaten devralir.
  }
}
