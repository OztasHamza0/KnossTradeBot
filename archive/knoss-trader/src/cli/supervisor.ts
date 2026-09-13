import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * NOBETCI — botu ayakta tutan surec.
 *
 * NEDEN VAR: 4 Eylul 2026, 08:52 UTC. Bot bir DNS hatasi logladi (1/8),
 * dokuz dakika daha sorunsuz tikledi, sonra kapanis raporu bile yazamadan
 * yok oldu. Iki saat kirk sekiz dakika olu kaldi ve kimse fark etmedi.
 * Pozisyonlar borsadaki stop+hedef emirlerine emanet kaldigi icin para
 * riski dogmadi, ama mutabakat, zaman asimli cikis ve yeni sinyal durdu.
 * Ayni sey bir kez daha, 3.7 saatlik bir olumle yasanmisti.
 *
 * IKI AYRI OLUM SEKLI VAR ve ikisi de yakalanmali:
 *
 *  1. SUREC OLUR. Cikis kodu ne olursa olsun surec biter. Yakalamasi kolay.
 *  2. SUREC YASAR, DONGU KILITLENIR. Ag catisi asili kalir, bir await hic
 *     donmez. `tasklist` botu "calisiyor" gosterir ama bot hicbir sey
 *     yapmiyordur. CLAUDE.md'nin 6. kurali tam olarak bunu soyluyor:
 *     "Surec ayakta demek, bot calisiyor demek DEGIL."
 *     Tek kanit NABIZ DOSYASININ ZAMAN DAMGASIDIR.
 *
 * KASITLI DURUS ILE KAZAYI AYIRT ETMEK SART. Bot zarar sinirini ya da islem
 * tavanini gorup kendini kapattiysa, onu yeniden baslatmak guvenlik sinirini
 * DELMEK olur — nobetci, korumasi gereken seyi yok eder. Kasitli durusta
 * bot 0 ile ciker; nobetci yalnizca SIFIR OLMAYAN cikislarda ve kilitlenmede
 * yeniden baslatir.
 */

const args = process.argv.slice(2);

/** Nabiz bu kadar bayatsa dongu kilitlenmis sayilir ve surec oldurulur. */
const NABIZ_AZAMI_SN = parseInt(
  args.find((a) => a.startsWith('--nabiz-azami='))?.split('=')[1] ?? '300',
  10,
);

/**
 * Yeniden baslatma araligi (sn) — ustel geri cekilme ile buyur.
 * Ilk deneme hemen: gecici bir ag kesintisinde bot saniyeler icinde geri
 * gelsin. Israrli bir arizada aralik acilsin ki log sismesin ve borsa
 * gereksiz yere dovulmesin.
 */
const ILK_BEKLEME_SN = 10;
const AZAMI_BEKLEME_SN = 300;

/**
 * Bir saat icinde bu kadar cokme olursa nobetci de durur.
 *
 * Cokme dongusu bedavaya calismaz: her acilis exchangeInfo + position +
 * koruma kontrolu demek, ve bot her acilista islem acabilir. Sonsuza kadar
 * yeniden baslatmak, "gozetimsiz calisan sistem" fikrini bir kacak donguye
 * cevirir. Bot kendi MAX_TRADES sayacini diskte tuttugu icin islem tavani
 * yeniden baslatmalari asar — ama nobetcinin de bir siniri olmali.
 */
const SAATTE_AZAMI_COKME = 12;

const LOG_FILE = path.resolve(__dirname, '../../supervisor.log');
const HEARTBEAT_FILE = path.resolve(__dirname, '../../heartbeat.json');
const RUN_SCRIPT = path.resolve(__dirname, 'run.ts');

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* log yazamamak nobetciyi durdurmamali */
  }
}

/** Nabiz kac saniye once yazilmis. Dosya yoksa/okunamazsa NaN. */
function nabizYasiSn(): number {
  try {
    const h = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    const t = Date.parse(h.at);
    if (!Number.isFinite(t)) return NaN;
    return (Date.now() - t) / 1000;
  } catch {
    return NaN;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Botun kendi argumanlari — nobetciye ait olanlar ayiklanir. */
const botArgs = args.filter((a) => !a.startsWith('--nabiz-azami='));

let child: ChildProcess | null = null;
let durduruluyor = false;

/**
 * Botu bir kez calistirir ve BITIS SEBEBINI doner.
 *
 * 'kasitli'    : bot kendi kararyla ve temiz cikti (zarar siniri, islem
 *                tavani, Ctrl+C). YENIDEN BASLATILMAZ.
 * 'kaza'       : sifir olmayan cikis ya da sinyal. Yeniden baslatilir.
 * 'kilitlendi' : surec yasiyor ama nabiz bayat. Oldurulup baslatilir.
 */
function botuCalistir(): Promise<'kasitli' | 'kaza' | 'kilitlendi'> {
  return new Promise((resolve) => {
    let bitti = false;
    const bir = (sonuc: 'kasitli' | 'kaza' | 'kilitlendi') => {
      if (bitti) return;
      bitti = true;
      clearInterval(nabizTimer);
      resolve(sonuc);
    };

    child = spawn(
      process.execPath,
      [require.resolve('ts-node/dist/bin.js'), RUN_SCRIPT, ...botArgs],
      {
        // Bot kendi log dosyasina zaten yaziyor; ciktiyi da devraliyoruz ki
        // nobetci penceresinde gorunsun.
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
      },
    );

    log(`bot baslatildi (pid ${child.pid})`);

    /**
     * NABIZ BEKCISI. Sureci degil, DONGUYU izliyor.
     *
     * Ilk tik borsaya baglanma, exchangeInfo, sembol hazirligi ve koruma
     * kontrolunu icerdigi icin uzun surer; 20 sembolde dakikalari bulur.
     * O yuzden acilista nabiz dosyasi HENUZ YOKSA ya da eskiyse hemen
     * oldurmuyoruz — yalnizca surec ayaga kalktiktan sonra yazilan bir
     * nabzin BAYATLAMASI kilitlenme sayilir.
     */
    const basladi = Date.now();
    const nabizTimer = setInterval(() => {
      if (bitti || !child) return;
      const acilisPayiMs = Math.max(NABIZ_AZAMI_SN, 180) * 1000;
      if (Date.now() - basladi < acilisPayiMs) return;

      const yas = nabizYasiSn();
      if (!Number.isFinite(yas)) return; // okunamayan nabiz karar sebebi degil
      if (yas > NABIZ_AZAMI_SN) {
        log(
          `!! NABIZ BAYAT (${yas.toFixed(0)} sn > ${NABIZ_AZAMI_SN}) — ` +
            `surec yasiyor ama dongu donmuyor. Oldurulup yeniden baslatiliyor.`,
        );
        try {
          child.kill('SIGKILL');
        } catch {
          /* zaten olmus olabilir */
        }
        bir('kilitlendi');
      }
    }, 30_000);

    child.on('exit', (code, signal) => {
      child = null;
      if (durduruluyor) return bir('kasitli');
      if (signal) {
        log(`bot ${signal} ile sonlandi`);
        return bir('kaza');
      }
      if (code === 0) {
        // Temiz cikis = botun KENDI karari. Zarar siniri, islem tavani ya da
        // elle durdurma. Bunu ezmek guvenlik sinirini yok etmek olur.
        log('bot TEMIZ cikti (kod 0) — kasitli durus, yeniden BASLATILMIYOR.');
        log('  Sebep icin run.log dosyasinin sonuna bak.');
        return bir('kasitli');
      }
      log(`bot cokti (cikis kodu ${code})`);
      bir('kaza');
    });

    child.on('error', (e) => {
      log(`bot baslatilamadi: ${e?.message}`);
      bir('kaza');
    });
  });
}

async function main() {
  log('='.repeat(70));
  log('NOBETCI basladi');
  log(`  bot argumanlari : ${botArgs.join(' ') || '(yok)'}`);
  log(`  nabiz esigi     : ${NABIZ_AZAMI_SN} sn`);
  log(`  saatte azami cokme: ${SAATTE_AZAMI_COKME}`);
  log('='.repeat(70));

  const dur = (why: string) => {
    durduruluyor = true;
    log(`NOBETCI DURUYOR: ${why}`);
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* yok */
      }
    }
    // Bota kapanis raporunu yazmasi icin biraz zaman taniyoruz.
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGINT', () => dur('elle durduruldu (Ctrl+C)'));
  process.on('SIGTERM', () => dur('SIGTERM alindi'));

  /** Son bir saatteki cokme zaman damgalari. */
  const cokmeler: number[] = [];
  let bekleme = ILK_BEKLEME_SN;

  while (!durduruluyor) {
    const sonuc = await botuCalistir();
    if (durduruluyor) break;

    if (sonuc === 'kasitli') {
      log('Nobetci gorevini tamamladi — bot kasitli olarak durdu.');
      break;
    }

    const simdi = Date.now();
    cokmeler.push(simdi);
    // Bir saatten eski kayitlari dus.
    while (cokmeler.length && simdi - cokmeler[0] > 3600_000) cokmeler.shift();

    if (cokmeler.length >= SAATTE_AZAMI_COKME) {
      log(
        `!! SON BIR SAATTE ${cokmeler.length} COKME — kacak dongu sayiliyor, ` +
          `nobetci duruyor. Once sebebi bul (run.log).`,
      );
      break;
    }

    log(
      `${bekleme} sn sonra yeniden baslatilacak ` +
        `(son bir saatte ${cokmeler.length}/${SAATTE_AZAMI_COKME} cokme)`,
    );
    await sleep(bekleme * 1000);

    // Ustel geri cekilme: gecici ariza hizli toparlansin, israrli ariza
    // borsayi ve log'u dovmesin.
    bekleme = Math.min(AZAMI_BEKLEME_SN, bekleme * 2);
    // Bot bir tam saat sorunsuz calistiysa bekleme sifirlanir.
    if (!cokmeler.length) bekleme = ILK_BEKLEME_SN;
  }

  log('NOBETCI bitti.');
}

main().catch((e) => {
  log(`NOBETCI OLUMCUL HATA: ${e?.message ?? e}`);
  process.exit(1);
});
