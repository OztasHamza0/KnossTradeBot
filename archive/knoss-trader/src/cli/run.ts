import * as fs from 'fs';
import * as path from 'path';
import { BinanceFuturesClient } from '../live/client';
import { Executor } from '../live/executor';
import { fetchKlines, setKlineSource } from '../data/binance';
import { INTERVAL_MS, sonKapananMum } from '../data/types';
import { donchianBreakout } from '../strategies/donchian-breakout';
import { Signal } from '../backtest/types';
import {
  loadState,
  rollDayIfNeeded,
  saveState,
  stateFilePath,
  totalRiskUsdt,
  openCount,
  BotState,
} from '../live/state';
import { acquireLock, releaseLock, lockFilePath } from '../live/lock';
import { korumaDurumu } from '../live/protection';

/**
 * SUREKLI CALISAN BOT — DAYANIKLILIK (SOAK) TESTI, COKLU SEMBOL.
 *
 * NE OLCTUGU KONUSUNDA NET OLALIM: bu kosunun kar/zarari HICBIR SEY ifade
 * etmez. +0.05 R'lik bir edge'i gorebilmek icin 4361 islem gerektigi
 * olculdu; alti sembolde bir gece 10-20 islem eder — hedefin %0.5'i.
 * Ustelik calistirilan strateji sans testinde rastgelenin %64'unde kaldi.
 *
 * COKLU SEMBOLUN ASIL FAYDASI OLCUM DEGIL, KAPSAM: daha cok sinyal, daha
 * cok kod yolu, esszamanli pozisyon, daha genis hata yuzeyi. Tek sembolde
 * gece boyu hic sinyal cikmayabilir ve sabah elimizde "calisti ama hicbir
 * sey yapmadi" kalir.
 *
 * NEDEN AYRI SUREC DEGIL, TEK SUREC:
 * Her sembol icin ayri surec calistirmak ilk akla gelen yol ama BOZUKTUR.
 * Durum dosyasi ve log tek bir sabit yola yaziliyor; iki surec birbirinin
 * pozisyon kaydini ezer, sonra bot kendi pozisyonunu "yabanci" sanir.
 * Daha kotusu guvenlik sinirlari surec basina olur: 6 bot x %15 zarar
 * siniri = fiilen %90'a kadar hicbiri durmaz.
 *
 * TOPLAM RISK TAVANI:
 * Alti sembolde islem basina %1 risk, "toplam %1" demek DEGILDIR. Kripto
 * neredeyse tek varlik gibi hareket eder; sert bir dususte alti pozisyonun
 * altisi da ayni anda stop olur. O yuzden acik pozisyonlarin TOPLAM riski
 * ayrica sinirlaniyor.
 */

const args = process.argv.slice(2);
const val = (k: string, d: string) =>
  args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;

const SYMBOLS = val('symbols', 'SOLUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const INTERVAL = val('interval', '15m');
const LEVERAGE = parseInt(val('leverage', '3'), 10);
const RISK_PCT = parseFloat(val('risk', '1'));
const TESTNET = !args.includes('--mainnet');

/**
 * MUM VERISI NEREDEN GELSIN.
 *
 * Varsayilan TUTARLI: emir nereye gidiyorsa veri de oradan. Testnet'te
 * calisirken mainnet mumu kullanmak, olcumun tamamini gecersiz kilar —
 * sinyalin stop/hedefi bir fiyat serisinden, giris ve tetikler BASKA bir
 * seriden gelir.
 *
 * `--veri=mainnet` ile bilerek secilebilir (testnet mumlari seyrek ve
 * bosluklu olabilir), ama artik SESSIZ degil: acilista buyuk harfle
 * uyariliyor ve o kosudan cikan hicbir "model uyuyor mu" sayisi
 * guvenilir sayilmamali.
 */
const MAINNET_VERISI = val('veri', '') === 'mainnet';

/** --- GUVENLIK SINIRLARI: gozetimsiz calisan bot icin sart --- */
/** Bu kadar islemden sonra dur (TUM semboller). Kacak dongu korumasi. */
const MAX_TRADES = parseInt(val('max-trades', '20'), 10);
/** Gun basi bakiyenin bu kadarini kaybedince dur. */
const MAX_LOSS_PCT = parseFloat(val('max-loss', '15'));
/** Ayni anda acik pozisyon sayisi tavani. */
const MAX_CONCURRENT = parseInt(val('max-concurrent', '3'), 10);
/**
 * Acik pozisyonlarin TOPLAM riski, bakiyenin yuzdesi olarak.
 * Islem basi %1 x 6 sembol = %6 degil; korelasyon yuzunden hepsi birden
 * stop olabilir. Bu tavan gercek maruziyeti sinirlar.
 */
const MAX_TOTAL_RISK_PCT = parseFloat(val('max-total-risk', '3'));

/**
 * Acik pozisyonlarin TOPLAM marji, ozkaynagin bu yuzdesini asamaz.
 *
 * MAX_MARGIN_RATIO (%25) yalnizca islem basina tavandi; portfoy
 * toplaminda hicbir sinir yoktu. Dort pozisyon x %25 = hesabin TAMAMI
 * kilitlenebilirdi. O noktada kullanilabilir nakit sifir olur:
 *  - acil kapatma / zaman asimli cikis icin manevra alani kalmaz,
 *  - borsanin marj cagrisina karsi tampon yok olur,
 *  - ve fiyat aleyhe giderse izole marj tek tek erimeye baslar.
 *
 * %60 varsayilan: dort pozisyon rahatca sigar (1 saatlik/5x'te olculen
 * ortalama marj pozisyon basina ~%7.4, yani ~%30) ama kuyruk durumlarda
 * hesabin tamami baglanmaz.
 */
const MAX_PORTFOLIO_MARGIN_PCT = parseFloat(val('max-portfolio-margin', '60'));
/** Ust uste bu kadar hata alinca dur. */
const MAX_ERRORS = 8;
/** Basarisiz giris denemesi siniri — her deneme gidis-donus komisyonu yakar. */
const MAX_FAILED = 5;
/** Backtest ile ayni: bu kadar mumdan sonra pozisyon zorla kapatilir. */
const MAX_BARS_IN_TRADE = 200;
/**
 * Gosterge penceresi. warmup+50 yetersizdi: EMA ozyinelemeli oldugu icin
 * kisa pencerede hesaplanan EMA200, backtest tum gecmisten hesaplarken
 * FARKLI bir sayi verir — yani calisan strateji, test edilen strateji
 * olmaktan cikar.
 */
const HISTORY_BARS = 1200;
/** Dongu araligi (sn). */
const TICK_SEC = parseInt(val('tick', '60'), 10);

const STRATEGY = donchianBreakout({
  lookback: 20,
  atrPeriod: 14,
  stopAtr: 3,
  rr: 3,
  trendEma: 200,
});

const LOG_FILE = path.resolve(__dirname, '../../run.log');
const HEARTBEAT_FILE = path.resolve(__dirname, '../../heartbeat.json');

/**
 * Her tikte yazilan nabiz dosyasi.
 *
 * Neden gerekli: durum satiri log'a 20 tikte bir yaziliyor, yani 20 dakikada
 * bir. Gozetimsiz bir gece boyunca "bot hala yasiyor mu, yoksa 40 dakika
 * once mi dondu" sorusunu log'dan kesin cevaplamak mumkun degildi. Surecin
 * ayakta gorunmesi de yetmez — surec yasayip dongusu kilitlenmis olabilir.
 * Bu dosyanin ZAMAN DAMGASI, dongunun gercekten dondugunun kaniti.
 */
function heartbeat(data: Record<string, unknown>): void {
  try {
    fs.writeFileSync(
      HEARTBEAT_FILE,
      JSON.stringify({ at: new Date().toISOString(), ...data }, null, 2),
    );
  } catch {
    /* nabiz yazamamak botu durdurmamali */
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* log yazamamak botu durdurmamali */
  }
}

function loadKeys(): { apiKey: string; apiSecret: string } {
  const file = path.resolve(__dirname, TESTNET ? '../../.env' : '../../.env.mainnet');
  const env: Record<string, string> = {};
  if (fs.existsSync(file)) {
    for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return TESTNET
    ? { apiKey: env.BINANCE_TESTNET_KEY ?? '', apiSecret: env.BINANCE_TESTNET_SECRET ?? '' }
    : { apiKey: env.BINANCE_KEY ?? '', apiSecret: env.BINANCE_SECRET ?? '' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Stats {
  ticks: number;
  signals: number;
  trades: number;
  errors: number;
  consecutiveErrors: number;
  // NOT: "son islenen mum" kaydi buradan KALDIRILDI. Surec hafizasinda
  // tutuldugu surece her yeniden baslatma onu sifirliyor ve ayni mumda
  // ikinci kez islem acilabiliyordu. Artik BotState.lastBar icinde,
  // yani diske yaziliyor.
}

async function main() {
  const { apiKey, apiSecret } = loadKeys();
  if (!apiKey || !apiSecret) {
    console.error(`Anahtar yok (${TESTNET ? '.env' : '.env.mainnet'}).`);
    process.exit(1);
  }

  /**
   * TEK KOPYA KILIDI — borsaya baglanmadan ONCE.
   *
   * Ayni hesapta iki bot calisirsa risk ikiye katlanir ve guvenlik
   * sinirlari surec basina olur: iki bot x %15 zarar siniri = fiilen %30.
   * Kaza senaryosu basit — terminali kapatmadan ikinci kez baslatmak, ya
   * da nobetin yasayan bir botu olmus sanip yenisini acmasi.
   */
  const kilit = acquireLock();
  if (!kilit.ok) {
    const yas = ((Date.now() - kilit.sahip.at) / 60000).toFixed(0);
    console.error('DURDURULDU: baska bir bot zaten calisiyor.');
    console.error(`  PID ${kilit.sahip.pid}, ${yas} dakikadir acik`);
    console.error(`  parametreler: ${kilit.sahip.argv || '(yok)'}`);
    console.error(`  kilit dosyasi: ${lockFilePath()}`);
    console.error('  Ayni hesapta iki bot riski IKIYE KATLAR ve her ikisi de');
    console.error('  kendi zarar sinirini kullanir. Once digerini durdur.');
    process.exit(1);
  }
  // Cikis yolu ne olursa olsun kilit birakilsin (yalnizca bizimse siler).
  process.on('exit', releaseLock);

  const client = new BinanceFuturesClient({ apiKey, apiSecret, testnet: TESTNET });

  log('='.repeat(70));
  log(`DAYANIKLILIK TESTI — ${TESTNET ? 'TESTNET (sahte para)' : '!!! CANLI PARA !!!'}`);
  log(`Semboller: ${SYMBOLS.join(', ')}`);
  log(`${INTERVAL} | kaldirac ${LEVERAGE}x | islem basi risk %${RISK_PCT} | tik ${TICK_SEC}sn`);
  log(
    `Sinirlar: max ${MAX_TRADES} islem, max %${MAX_LOSS_PCT} zarar, ` +
      `es zamanli ${MAX_CONCURRENT} pozisyon, toplam risk %${MAX_TOTAL_RISK_PCT}, portfoy marji %${MAX_PORTFOLIO_MARGIN_PCT}`,
  );
  log(`Strateji: ${STRATEGY.name}`);

  // VERI KAYNAGI — emirle ayni ortam mi?
  const veriKaynagi = setKlineSource(TESTNET, MAINNET_VERISI);
  const icraKaynagi = TESTNET ? 'testnet' : 'mainnet';
  log(`Mum verisi: ${veriKaynagi}  |  emir icrasi: ${icraKaynagi}`);
  if (veriKaynagi !== icraKaynagi) {
    log('');
    log('!!! DIKKAT: VERI VE ICRA FARKLI ORTAMLARDAN.');
    log(`    Sinyal ${veriKaynagi} mumlarindan uretiliyor, giris ve koruma`);
    log(`    emirleri ${icraKaynagi} fiyatiyla calisiyor. Stop mesafesi iki`);
    log('    ayri fiyat serisi arasindaki farktan hesaplaniyor.');
    log('    Bu kosudan cikan hicbir "model uyuyor mu" sayisi GUVENILIR DEGIL.');
    log('    Tutarli olcum icin --veri=mainnet bayragini KALDIR.');
    log('');
  }

  log('NOT: bu kosunun kar/zarari istatistiksel olarak ANLAMSIZDIR.');
  log('='.repeat(70));

  // AYAR TUTARLILIGI — cakisan sinirlarla hic baslama.
  // MAX_TOTAL_RISK_PCT, MAX_LOSS_PCT'ten buyukse tek bir kotu gunde tum
  // pozisyonlar stop olsa bile zarar siniri devreye girmeden once hesap
  // planlanandan fazla erir. Bu, calisma sirasinda fark edilmesi zor ama
  // baslangicta bakmasi bedava olan bir celiski.
  /**
   * ES ZAMANLI POZISYON TAVANI ILE RISK TAVANI CELISIYOR MU.
   *
   * Iki ayri sinir aslinda ayni seyi sinirliyor ve hangisinin gecerli
   * oldugu ayarlardan okunamiyordu. Canli kosuda MAX_CONCURRENT=4 ve
   * MAX_TOTAL_RISK_PCT=4, islem basi risk %1: 4 x %1 = %4, yani tavanla
   * TAM ESIT. Dorduncu pozisyonun acilip acilmayacagina hesabin o anki
   * ozkaynagi karar veriyor — tasarim degil, yuvarlama gurultusu.
   *
   * Operatorun hangi sinirin fiilen calistigini BILMESI gerekiyor; bu
   * yuzden etkin es zamanlilik hesaplanip yaziliyor. Durdurmuyoruz:
   * risk tavaninin baglayici olmasi mesru bir tercih olabilir.
   */
  const etkinEsZamanli = Math.floor(MAX_TOTAL_RISK_PCT / RISK_PCT);
  if (etkinEsZamanli < MAX_CONCURRENT) {
    log(
      `UYARI: es zamanli pozisyon tavani ${MAX_CONCURRENT} ama toplam risk ` +
        `tavani (%${MAX_TOTAL_RISK_PCT}) islem basi %${RISK_PCT} riskle en fazla ` +
        `${etkinEsZamanli} pozisyona izin verir.`,
    );
    log(
      `  Fiilen gecerli olan sinir: ${etkinEsZamanli} pozisyon. ` +
        `--max-concurrent=${MAX_CONCURRENT} olu bir ayar.`,
    );
    log(
      `  Istenen ${MAX_CONCURRENT} ise: --max-total-risk=${MAX_CONCURRENT * RISK_PCT + 1} ` +
        `ya da --risk=${(MAX_TOTAL_RISK_PCT / MAX_CONCURRENT).toFixed(2)}`,
    );
  }

  if (MAX_TOTAL_RISK_PCT >= MAX_LOSS_PCT) {
    log(
      `DURDURULDU: toplam risk tavani (%${MAX_TOTAL_RISK_PCT}) zarar sinirindan ` +
        `(%${MAX_LOSS_PCT}) kucuk olmali. Aksi halde zarar siniri hicbir zaman ` +
        `koruyucu olmaz.`,
    );
    return;
  }

  const ping = await client.ping();
  const state: BotState = loadState(Date.now(), ping.equityUsdt);

  /**
   * Durum dosyasi okunamadiysa BASLAMA.
   *
   * Temiz durumla devam etmek "guvenli taraf" gibi gorunuyor ama degil:
   * gunluk zarar sinirinin referansi (dayStartEquity) guncel bakiyeye
   * sifirlanir ve bot, gunun kaybini unutup taze bir butce kazanir. Ayni
   * sekilde islem sayaci da sifirlanir.
   *
   * Acik pozisyonlar bu sirada korumasiz kalmaz: stop ve hedef emirleri
   * BORSADA duruyor.
   */
  if (state.bozuk) {
    log('DURDURULDU: durum dosyasi okunamadi ya da bozuk.');
    log(`  dosya: ${stateFilePath()}`);
    log('  Temiz durumla devam etmek gunluk zarar sinirini ve islem');
    log('  sayacini sifirlar — yani botun bugunku kaybini unutmasi demek.');
    log('  Dosyayi elle incele. Borsada acik pozisyon YOKSA silip yeniden');
    log('  baslatabilirsin; VARSA once pozisyonlari kontrol et.');
    return;
  }

  const stats: Stats = {
    ticks: 0,
    signals: 0,
    trades: state.trades,
    errors: 0,
    consecutiveErrors: 0,
  };

  log(`Baslangic bakiyesi: ${ping.balanceUsdt.toFixed(4)} USDT`);
  log(
    `Kalici durum (${state.day}): ${state.trades} islem, ` +
      `${state.failedAttempts} basarisiz deneme, ${openCount(state)} acik pozisyon kaydi, ` +
      `gun basi ozkaynak ${state.dayStartEquity.toFixed(2)} USDT`,
  );

  // Sembol basina yurutucu; her biri kendi filtrelerini ve kaldiracini kurar.
  const execs = new Map<string, Executor>();
  for (const symbol of SYMBOLS) {
    const e = new Executor(
      client,
      { symbol, leverage: LEVERAGE, riskPct: RISK_PCT, dryRun: false },
      (m) => log(`  [${symbol}] ${m.trim()}`),
    );
    await e.prepare();
    execs.set(symbol, e);

    // TANIMADIGI POZISYONLA BASLAMA — sembol bazinda.
    const existing = await client.position(symbol);
    if (Math.abs(existing.positionAmt) > 0 && !state.positions[symbol]) {
      /**
       * Niyet kaydi TAZE olmali.
       *
       * Mesru senaryo "emir gonderilirken cokuldu, dakikalar sonra yeniden
       * baslatildi". Gunler once kalmis bir kayit, o sembolde kullanicinin
       * ELLE actigi bir pozisyonu sahiplenmemize yol acar — botun en temel
       * kuralinin ("baskasinin pozisyonuna dokunma") delinmesi demek.
       * Alti saat, cokme penceresi (saniyeler) icin fazlasiyla comert.
       */
      const NIYET_OMRU_MS = 6 * 3600_000;
      const ham = state.pending?.[symbol];
      const niyet =
        ham && Date.now() - ham.at <= NIYET_OMRU_MS ? ham : undefined;
      if (ham && !niyet) {
        log(
          `  [${symbol}] bayat niyet kaydi yok sayildi ` +
            `(${((Date.now() - ham.at) / 3600_000).toFixed(1)} saat once)`,
        );
        delete state.pending![symbol];
        saveState(state);
      }
      if (niyet) {
        /**
         * KURTARMA: giris emri gonderilmis ama durum kaydi yazilmadan
         * cokulmus. Pozisyon BIZIM — niyet kaydi bunu kanitliyor.
         *
         * Miktar ve giris fiyati BORSADAN okunuyor; hafizadaki tahminden
         * degil. Risk, borsadaki stop emrinden hesaplaniyor; stop yoksa
         * pozisyon KORUMASIZ demektir ve ilk tikteki reconcile() bunu
         * yakalayip kapatacak — o yuzden burada kapatmiyoruz, yalnizca
         * risk tarafinda MUHAFAZAKAR bir deger koyuyoruz.
         */
        const algo = await client.openAlgoOrders(symbol).catch(() => null);
        const stop = (algo ?? []).find(
          (o: any) =>
            (o.orderType ?? o.type) === 'STOP_MARKET' &&
            !String(o.clientAlgoId ?? '').startsWith('pf-'),
        );
        const trig = stop
          ? parseFloat(stop.triggerPrice ?? stop.stopPrice ?? 'NaN')
          : NaN;
        const qty = Math.abs(existing.positionAmt);
        const risk =
          Number.isFinite(trig) && existing.entryPrice > 0
            ? qty * Math.abs(existing.entryPrice - trig)
            : ping.equityUsdt * (RISK_PCT / 100);

        state.positions[symbol] = {
          symbol,
          side: existing.positionAmt > 0 ? 'LONG' : 'SHORT',
          qty,
          entryPrice: existing.entryPrice,
          openedAt: niyet.at,
          clientOrderId: 'kurtarildi',
          riskUsdt: risk,
        };
        delete state.pending![symbol];
        saveState(state);
        log('');
        log(`KURTARILDI: ${symbol} — giris emri gonderilmis ama kayit`);
        log('  yazilmadan cokulmus. Niyet kaydi bu pozisyonun BIZIM');
        log(`  oldugunu kanitliyor. ${existing.positionAmt} @ ${existing.entryPrice}`);
        log(
          `  koruma emri: ${algo === null ? 'OKUNAMADI' : algo.length}` +
            `, risk ${risk.toFixed(2)} USDT` +
            (Number.isFinite(trig) ? '' : ' (stop bulunamadi — muhafazakar tahmin)'),
        );
        continue;
      }

      log('');
      log(`DURDURULDU: ${symbol} icin botun ACMADIGI bir pozisyon var.`);
      log(`  ${existing.positionAmt} @ ${existing.entryPrice}`);
      log('  Bot baskasinin pozisyonuna DOKUNMAZ. Pozisyonu kapat ya da');
      log(`  durum dosyasini duzenle: ${stateFilePath()}`);
      return;
    }
  }
  if (kilit.ok && kilit.bayatAlindi) {
    log('NOT: bayat kilit dosyasi devralindi — onceki bot duzgun');
    log('     kapanmamis (cokme ya da zorla oldurme). Sorun degil, ama');
    log(`     o kosunun neden bittigini run.log dosyasindan kontrol et.`);
  }
  /**
   * OKSUZ KAYITLAR — artik izlenmeyen sembollerin pozisyon kayitlari.
   *
   * Sembol listesi degistiginde (orn. 20 sembolden 6'ya dusuldugunde),
   * listeden cikan sembollerin kaydi durum dosyasinda KALIR. Sembol
   * dongusu onlara hic ugramaz, yani:
   *  - openCount() onlari sonsuza kadar sayar -> es zamanli pozisyon
   *    tavani gereksiz yere dolu gorunur,
   *  - totalRiskUsdt() risklerini toplamaya devam eder -> risk butcesi
   *    hic bosalmaz ve bot bir sure sonra HIC islem acamaz,
   *  - ve borsadaki gercek pozisyon MUTABAKAT GORMEZ: korumasiz kalsa
   *    bile kimse fark etmez.
   *
   * Acilista bir kez temizleniyor. Borsada pozisyon YOKSA kayit silinir;
   * VARSA bot baslamayi reddeder — cunku o pozisyonu yonetecek kimse yok.
   */
  const oksuz = Object.keys(state.positions).filter((s) => !SYMBOLS.includes(s));
  for (const symbol of oksuz) {
    const p = await client.position(symbol).catch(() => null);
    if (p === null) {
      // "Okuyamadim" ile "yok" ayni sey degil — karar vermiyoruz.
      log('');
      log(`DURDURULDU: ${symbol} kayitta var ama sembol listesinde yok,`);
      log('  ve borsadaki durumu OKUNAMADI. Karar vermeden once kontrol et.');
      return;
    }
    if (Math.abs(p.positionAmt) === 0) {
      log(`  [${symbol}] artik izlenmiyor ve borsada pozisyon yok — kayit silindi`);
      delete state.positions[symbol];
      saveState(state);
      continue;
    }
    log('');
    log(`DURDURULDU: ${symbol} icin ACIK pozisyon var ama bu sembol`);
    log(`  artik izlenmiyor: ${p.positionAmt} @ ${p.entryPrice}`);
    log('  Bu pozisyonu yonetecek kimse yok — mutabakat gormez, zaman');
    log('  asimi calismaz, koruma emri dusse fark edilmez.');
    log(`  Ya sembolu listeye geri ekle, ya pozisyonu kapat.`);
    return;
  }

  log(`${SYMBOLS.length} sembol hazirlandi.`);

  /**
   * Koruma emri destegi bir kez sinanir; hesap geneli bir ozellik.
   *
   * KONTROL POZISYONSUZ BIR SEMBOLDE YAPILIR. Onceki hali her zaman
   * SYMBOLS[0]'i kullaniyordu; o sembolde acik pozisyon ve onun
   * closePosition stop emri varsa Binance -4130 doner ve bot BASLAMAZ.
   * Gece 01:21'de tam bu oldu — pozisyonlar dogru sahiplenildi, sonra
   * bu kontrol botu 3.7 saat ayakta tutmadi.
   *
   * -4130 artik "kabul edildi" sayiliyor (executor'daki gerekce), ama
   * kontrolu bos bir sembolde yapmak carpismayi bastan onler: probe
   * emri gercekten yazilir ve iptal edilir, yani yetenek GERCEKTEN
   * sinanmis olur — hataya bakarak cikarim yapmak yerine.
   */
  const bosSembol = SYMBOLS.find((s) => !state.positions[s]) ?? SYMBOLS[0];
  if (bosSembol !== SYMBOLS[0]) {
    log(`Koruma emri destegi ${bosSembol} uzerinde sinaniyor ` +
        `(${SYMBOLS[0]} pozisyon tasiyor).`);
  }
  const protect = await execs.get(bosSembol)!.canPlaceProtection();
  if (!protect.ok) {
    log(`DURDURULDU: koruma emri yazilamiyor — ${protect.reason}`);
    log('Stopu borsaya koyamiyorsak pozisyon acmayiz.');
    return;
  }
  log('Koruma emri destegi: tamam.');

  let running = true;
  const stop = (why: string) => {
    log(`\n>>> DURDURULUYOR: ${why}`);
    running = false;
  };
  process.on('SIGINT', () => stop('elle durduruldu (Ctrl+C)'));
  process.on('SIGTERM', () => stop('SIGTERM alindi'));

  const step = INTERVAL_MS[INTERVAL];

  /**
   * Tik araligi, mum boyuna gore cok buyukse giris gecikmesi modelden
   * ciddi sapar. Motor girisi mumun ACILISINDA varsayiyor; canli, yeni
   * mumu en erken BIR TIK sonra gorur. Tik, mumun %10'undan uzunsa o
   * sapma artik "kucuk bir gecikme" degildir ve backtest ile canli ayni
   * seyi olcmez.
   */
  if (TICK_SEC * 1000 > step * 0.1) {
    const oran = (((TICK_SEC * 1000) / step) * 100).toFixed(0);
    const oneri = Math.max(5, Math.floor((step * 0.05) / 1000));
    log(
      `UYARI: tik araligi (${TICK_SEC} sn), ${INTERVAL} mumun %${oran}'i kadar.`,
    );
    log('  Giris, motorun varsaydigi mum acilisindan belirgin sapabilir.');
    log(`  Oneri: --tick=${oneri} ya da daha uzun bir mum araligi.`);
  }

  while (running) {
    stats.ticks++;

    // --- Hesap geneli guvenlik sinirlari (sembol dongusunden ONCE) ---
    try {
      const acct = await client.ping();
      const bal = acct.balanceUsdt;      // yeni emre yetiyor mu
      const equity = acct.equityUsdt;    // hesabin GERCEK degeri

      // Gun donusu. state.ts'teki mantik loadState ile ayni; buraya da
      // gerekiyor cunku loadState yalnizca aciliste cagriliyor ve calisan
      // surecte gun hic donmuyordu (bkz. rollDayIfNeeded yorumu).
      if (rollDayIfNeeded(state, Date.now(), equity)) {
        log(
          `GUN DONDU -> ${state.day}. Sayaclar sifirlandi ` +
            `(onceki islem ${stats.trades}), gun basi ozkaynak ` +
            `${equity.toFixed(2)} USDT. Acik ${openCount(state)} pozisyonun ` +
            `kaydi korunuyor.`,
        );
        // stats.trades, MAX_TRADES kapisinin baktigi sayac — o da sifirlanmali,
        // yoksa gun donse bile bot ayni yerde durur.
        stats.trades = 0;
        saveState(state);
      }

      // Zarar OZKAYNAK uzerinden olculur. availableBalance kullanmak,
      // acilan her pozisyonun bloke ettigi marji 'zarar' saymak demekti:
      // iki es zamanli pozisyon kullanilabilir bakiyeyi ~%21 dusurur ve
      // bot hic para kaybetmeden %15 sinirini tetikleyip kendini kapatirdi.
      const lossPct = ((state.dayStartEquity - equity) / state.dayStartEquity) * 100;
      if (Number.isFinite(lossPct) && lossPct >= MAX_LOSS_PCT) {
        stop(`zarar siniri asildi (%${lossPct.toFixed(2)} >= %${MAX_LOSS_PCT})`);
        break;
      }
      if (stats.trades >= MAX_TRADES) {
        stop(`islem siniri doldu (${stats.trades})`);
        break;
      }

      // Nabiz HER tikte — dongunun gercekten dondugunun kaniti.
      heartbeat({
        tick: stats.ticks,
        balance: bal,
        equity,
        openPositions: openCount(state),
        maxConcurrent: MAX_CONCURRENT,
        totalRiskUsdt: totalRiskUsdt(state),
        trades: stats.trades,
        signals: stats.signals,
        errors: stats.errors,
        failedAttempts: state.failedAttempts,
        symbols: SYMBOLS.length,
        positions: Object.keys(state.positions),
      });

      // Log'a daha seyrek — dosyayi sismesin diye.
      if (stats.ticks % 10 === 1) {
        log(
          `tik ${stats.ticks}: bakiye ${bal.toFixed(2)} USDT, ` +
            `acik ${openCount(state)}/${MAX_CONCURRENT}, ` +
            `toplam risk ${totalRiskUsdt(state).toFixed(2)} USDT, ` +
            `islem ${stats.trades}, sinyal ${stats.signals}, hata ${stats.errors}`,
        );
      }

      // --- Sembol dongusu ---
      // Bu tikte bir sorun yasandi mi (hata sayacinin birikmesi icin).
      let tickHadProblem = false;
      /** Bu tikte KAC sembolde sorun cikti — hepsi mi, biri mi. */
      let sorunluSembol = 0;
      /**
       * Bu tikte acilan pozisyonlarin bloke ettigi marj (USDT).
       *
       * equity/bal tik BASINDA bir kez okunuyor; ayni tikte acilan ikinci,
       * ucuncu, dorduncu pozisyon o bayat goruntuye gore butce hesaplarsa
       * portfoy marj tavani bir tik icinde BAGLAYICI OLMAKTAN CIKAR. Toplam
       * risk tavani ayni sorunu kendi kaydini toplayarak cozuyor; marj
       * tarafinin da yerel bir sayaca ihtiyaci var.
       */
      let tiktekiMarj = 0;

      for (const symbol of SYMBOLS) {
        if (!running) break;
        const exec = execs.get(symbol)!;

        // SEMBOL BASINA HATA YALITIMI.
        // Onceden tum dongu tek bir try icindeydi: listenin 3. sembolunde
        // olusan gecici bir ag hatasi, kalan 17 sembolun MUTABAKATINI da
        // iptal ediyordu. Yani bir sembolun hatasi yuzunden digerlerinin
        // korumasiz pozisyonu fark edilmeden geciyordu.
        try {
        /**
         * SAHIPLIK KANITI reconcile'a GECIYOR.
         *
         * Kanit, durum dosyasindaki pozisyon kaydidir. Kayit yoksa bot o
         * pozisyonun kendisine ait oldugunu KANITLAYAMAZ ve dokunmaz.
         *
         * Aciliste bunu denetleyen bir kapi zaten vardi ("botun ACMADIGI bir
         * pozisyon var" -> baslamaz), ama CALISMA SIRASINDA hicbir kontrol
         * yoktu: reconcile semboldeki her pozisyonu kendi pozisyonu sayip,
         * eslesen stop bulamayinca PIYASADAN KAPATIYORDU. Yani bot koserken
         * panelden elle acilan bir pozisyon bir sonraki tikte kapatilirdi.
         */
        const rec = await exec.reconcile({ owned: !!state.positions[symbol] });

        // Borsayla konusulamadiysa KARAR VERME.
        if (rec.state === 'bilinmiyor') {
          log(`  [${symbol}] durum okunamadi: ${rec.detail}`);
          tickHadProblem = true;
          sorunluSembol++;
          continue;
        }

        // Bizim olmayan pozisyon: dokunulmuyor, ama SESSIZ de kalinmiyor.
        // Hata sayilmaz (bot bozuk degil, ortam boyle) — o yuzden
        // consecutiveErrors'a katkisi yok; yalnizca seyrek loglanir.
        if (rec.state === 'yabanci') {
          if (stats.ticks % 20 === 1) {
            log(`  [${symbol}] YABANCI POZISYON — ${rec.detail}`);
          }
          continue;
        }

        // Stop yerinde ama hedef kayip: pozisyon korumasiz degil, ama artik
        // backtest'in olctugu stop+hedef sistemi degil. Gorunur olmali.
        if (rec.tpEksik) {
          log(`  [${symbol}] !! HEDEF EMRI YOK (stop yerinde) — ${rec.detail}`);
          tickHadProblem = true;
        }

        if (rec.hasPosition) {
          // Zaman asimli cikis — backtest ile canliyi ayni yapan sart.
          const rec2 = state.positions[symbol];
          if (rec2 && Date.now() - rec2.openedAt > MAX_BARS_IN_TRADE * step) {
            log(`  [${symbol}] zaman asimi (${MAX_BARS_IN_TRADE} mum), kapatiliyor`);
            // KAPATMANIN SONUCUNA GORE davran. Onceki hali sonucu okumadan
            // kaydi siliyordu: kapatma basarisiz olsa bile pozisyon "yok"
            // sayiliyor, openCount ve toplam risk onu saymayi birakiyor ve
            // hala acik pozisyonun USTUNE yenisi acilabiliyordu.
            const kapanis = await exec.closePosition();
            if (kapanis === 'kapandi' || kapanis === 'bos') {
              delete state.positions[symbol];
              saveState(state);
            } else {
              log(
                `  [${symbol}] !! zaman asimi kapatmasi DOGRULANMADI ` +
                  `(${kapanis}) — kayit KORUNUYOR, sonraki tikte tekrar denenecek`,
              );
              tickHadProblem = true;
            }
          }
          continue;
        }

        // Pozisyon kapanmis: kaydi temizle.
        if (state.positions[symbol]) {
          log(`  [${symbol}] pozisyon kapanmis, kayit temizlendi`);
          delete state.positions[symbol];
          saveState(state);
        }

        // --- Portfoy sinirlari ---
        /**
         * ISLEM TAVANI SEMBOL DONGUSUNDE DE KONTROL EDILIR.
         *
         * Tik basindaki kontrol tek basina yetmiyordu: bir tikte 20 sembol
         * geziliyor ve her biri islem acabiliyor. Tavana bir islem kala
         * girilen bir tik, MAX_CONCURRENT kadar (4) islem daha acabilir —
         * yani "en fazla 40 islem" fiilen 43 olur.
         *
         * Kucuk bir asim gibi gorunuyor ama bu bir GUVENLIK SINIRI; asilan
         * bir sinir, sinir degildir. Ve gozetimsiz calisan bir sistemde
         * "biraz asti" ile "cok asti" arasindaki fark yalnizca sembol
         * sayisidir.
         */
        if (stats.trades >= MAX_TRADES) {
          if (stats.ticks % 20 === 1) {
            log(`  [${symbol}] islem tavani dolu (${stats.trades}/${MAX_TRADES}) — atlaniyor`);
          }
          continue;
        }
        if (openCount(state) >= MAX_CONCURRENT) continue;

        /**
         * Risk butcesinin tabani: gun basi ozkaynak ile GUNCEL ozkaynagin
         * KUCUGU.
         *
         * Tavan yalnizca dayStartEquity'den hesaplaniyordu ama bir islemin
         * riski (`thisRisk`) GUNCEL equity'den. Iki farkli taban, kapiyi
         * yuvarlama gurultusune birakiyor: 4 pozisyon x %1 risk = tam olarak
         * %4 tavan oldugu icin dorduncu islemin acilip acilmamasini, hesabin
         * gun basina gore birkac USDT yukarida mi asagida mi oldugu belirler.
         * Olculdu: 146.18 + 48.08 = 194.26 vs tavan 194.39 — 0.13 USDT.
         *
         * min() iki seyi birden duzeltir: taban dususte DARALIR (zarar
         * ederken risk butcesi bol kalmaz), ve kar durumunda dayStartEquity'de
         * sabit kalarak gunluk zarar siniriyla iliskisini korur.
         */
        const maxTotalRisk =
          Math.min(state.dayStartEquity, equity) * (MAX_TOTAL_RISK_PCT / 100);
        const usedRisk = totalRiskUsdt(state);
        // Risk OZKAYNAKTAN hesaplanir, kullanilabilir nakitten degil:
        // marj bloke oldukca nakit duser ve ayni tikte acilan sonraki
        // pozisyonlar sebepsiz kuculurdu.
        const thisRisk = equity * (RISK_PCT / 100);
        if (usedRisk + thisRisk > maxTotalRisk) {
          if (stats.ticks % 20 === 1) {
            log(
              `  [${symbol}] toplam risk tavani: ${usedRisk.toFixed(2)} + ` +
                `${thisRisk.toFixed(2)} > ${maxTotalRisk.toFixed(2)} USDT — atlaniyor`,
            );
          }
          continue;
        }

        /**
         * GEREKSIZ KLINES CEKIMINI ATLA — API'ye SORMADAN.
         *
         * Asagidaki fetchKlines her tikte 1200 mum cekiyordu, sembol
         * basina. 1 saatlik mumda yeni mum SAATTE BIR kapanir; 70
         * saniyelik tikte bu gereksiz cekimin 60 kati demek.
         *
         * Bedeli teorik degil: Binance testnet IP'yi -1003 ile
         * YASAKLADI ("Way too many requests"). Bot dogru davranip
         * pozisyonlara dokunmadi (koruma okunamayinca karar vermedi),
         * ama yasak surerken yeni sinyal de goremezdi.
         *
         * En son kapanan mumu zaten islediysek cekmeye gerek yok, ve
         * bunu saat aritmetigiyle KESIN biliyoruz.
         */
        const beklenenMum = sonKapananMum(Date.now(), step);
        if (
          Number.isFinite(beklenenMum) &&
          (state.lastBar ?? {})[symbol] === beklenenMum
        ) {
          continue;
        }

        // --- Yeni kapali mum var mi ---
        const bars = await fetchKlines(
          symbol, INTERVAL, Date.now() - HISTORY_BARS * step, Date.now(),
        );
        const closed = bars.slice(0, -1);
        if (closed.length < STRATEGY.warmup + 2) continue;

        const i = closed.length - 1;
        const barTime = closed[i].openTime;
        // Kayit KALICI: surec hafizasinda tutulursa her yeniden
        // baslatma en son mumu "hic gorulmemis" sayar ve ayni mumda
        // ikinci kez islem acilabilir.
        state.lastBar = state.lastBar ?? {};
        if (barTime === state.lastBar[symbol]) continue;
        state.lastBar[symbol] = barTime;
        saveState(state);

        /**
         * BAYAT MUMLA ISLEM ACMA.
         *
         * Motor girisi "sinyal mumunun kapanisindan SONRAKI mumun
         * ACILISINDAN" yapiyor — yani kapanistan saniyeler sonra. Kararli
         * durumda canli da boyle: tik 60 saniyede bir dondugu icin yeni
         * mum en fazla 60 sn gecikmeyle yakalanir.
         *
         * AMA ACILISTA OYLE DEGIL. Bot ilk tikinde en son KAPANMIS mumu
         * "yeni" sayar — o mum 59 dakika once kapanmis olsa bile. Fiyat o
         * arada nereye giderse gitsin, bot mumun kapanis mantigina gore
         * girer ve modelin varsaydigi fiyattan cok uzakta dolar.
         *
         * TAKIP TESTI BUNU ILK KOSUDA YAKALADI: bot 19:28'de basladi,
         * 19:00'da kapanmis mumla ARBUSDT ve OPUSDT actı — 29 dakika
         * bayat. Modelin varsaydigi fiyattan sapma %1.9 ve %0.7 idi.
         * Islem basi riskin %1 oldugu bir sistemde %1.9'luk bir giris
         * sapmasi, o islemin R hesabini bastan bozar.
         *
         * Ayni sey duraklatma/devam ettirme ve uzun bir ag kesintisi
         * sonrasinda da olusur. Esik cömert: kararli durumda gecikme
         * en fazla bir tik (60 sn), burada uc tike kadar izin veriliyor.
         */
        const mumYasiMs = Date.now() - (barTime + step);
        // Taban: kararli durumda gecikme en fazla BIR tik olur; iki tike
        // izin veriyoruz. Tavan: mumun %5'i. Ikisinin BUYUGU aliniyor,
        // cunku tik muma gore yavassa her sinyali elemek botu ise yaramaz
        // kilardi — o durum acilista ayrica uyariliyor.
        const AZAMI_YAS_MS = Math.max(2 * TICK_SEC * 1000, step * 0.05);
        if (mumYasiMs > AZAMI_YAS_MS) {
          log(
            `  [${symbol}] mum bayat (${(mumYasiMs / 60000).toFixed(0)} dk once ` +
              `kapandi, azami ${(AZAMI_YAS_MS / 60000).toFixed(0)} dk) — ` +
              `islem ACILMIYOR, bir sonraki mum beklenecek`,
          );
          continue;
        }

        const signal: Signal | null = STRATEGY.onBar(closed, i);
        if (!signal) continue;

        stats.signals++;
        log(`[${symbol}] SINYAL #${stats.signals}: ${signal.side} — ${signal.reason}`);
        log(
          `  stop ${signal.stopLoss.toFixed(4)} | hedef ${signal.takeProfit.toFixed(4)}`,
        );

        /**
         * PORTFOY MARJ BUTCESI — NIYET KAYDINDAN **ONCE**.
         *
         * Iki ayri hatayi birden kapatiyor:
         *
         * 1. NIYET KAYDI SIZINTISI. Bu kapi eskiden niyet kaydinin ALTINDAydi
         *    ve `continue` ediyordu. Niyet kaydi diske yazilmis, temizligi
         *    yapan try/finally'ye ise HIC girilmemis oluyordu — yani taze bir
         *    'pending' kaydi diskte kaliyordu. Alti saat icinde kullanici o
         *    sembolde elle bir pozisyon acarsa, yeniden baslatmadaki KURTARMA
         *    yolu o kaydi "bu pozisyon bizim" kaniti sayip sahipleniyordu.
         *    Botun dokunmamasi gereken pozisyona dokunmasi demek.
         *    Kapinin hicbir girdisi `signal`'a bagli olmadigi icin yukari
         *    tasinmasi bedava.
         *
         * 2. TIK ICI BUTCE KORLUGU. `equity` ve `bal` tik BASINDA bir kez
         *    okunuyor; ayni tikte 20 sembol geziliyor ve her biri pozisyon
         *    acabiliyor. Butce her sembolde AYNI bayat goruntuden hesaplandigi
         *    icin dort pozisyon %60 tavanini birlikte asabilirdi — her biri
         *    tek basina butceye sigiyor gorunurken. Toplam risk tavani bu
         *    sorunu kendi kaydini toplayarak cozuyordu; marj tarafinda ayni
         *    seyi yapmak gerekiyordu: `tiktekiMarj`, bu tikte acilan
         *    pozisyonlarin bloke ettigi marji yerel olarak biriktirir.
         */
        const kullanilanMarj = Math.max(0, equity - bal) + tiktekiMarj;
        const marjButcesi =
          equity * (MAX_PORTFOLIO_MARGIN_PCT / 100) - kullanilanMarj;
        if (marjButcesi <= 0) {
          if (stats.ticks % 20 === 1) {
            log(
              `  [${symbol}] portfoy marj tavani: ${kullanilanMarj.toFixed(0)} / ` +
                `${(equity * MAX_PORTFOLIO_MARGIN_PCT / 100).toFixed(0)} USDT dolu — atlaniyor`,
            );
          }
          continue;
        }

        /**
         * NIYET KAYDI — emir gonderilmeden ONCE diske yazilir.
         *
         * Emir borsaya gidip pozisyon acildiktan sonra ama asagidaki
         * kayit yazilmadan once cokersek, pozisyon borsada var kayitta
         * yok olur ve bot bir daha HIC baslamaz. Niyet kaydi, yeniden
         * baslarken o pozisyonun BIZIM oldugunu kanitlar.
         *
         * Buradan sonra `continue` eden hicbir dal KALMAMALI: kaydi silen
         * try/finally'ye her yol ugramak zorunda.
         */
        state.pending = state.pending ?? {};
        state.pending[symbol] = { symbol, side: signal.side, at: Date.now() };
        saveState(state);

        let result;
        try {
          result = await exec.execute(signal, bal, equity, marjButcesi);
        } finally {
          // Sonuc ne olursa olsun niyet kaydi temizlenir — VE DISKE YAZILIR.
          // Yalnizca bellekten silmek yetmez: 'atlandi' dalinda asagida
          // saveState cagrilmiyor, yani kayit diskte KALIRDI. Bayat bir
          // niyet kaydi, kullanicinin sonradan elle actigi bir pozisyonun
          // "kurtarilmasina" yol acabilirdi — botun dokunmamasi gereken
          // pozisyona dokunmasi demek.
          delete state.pending[symbol];
          saveState(state);
        }
        log(`  [${result.action}] ${result.detail}`);

        if (result.action === 'girildi') {
          stats.trades++;
          state.trades = stats.trades;
          state.positions[symbol] = {
            symbol,
            side: signal.side,
            qty: result.quantity ?? 0,
            entryPrice: result.entryPrice ?? 0,
            openedAt: Date.now(),
            clientOrderId: `e-${Date.now()}`,
            // PLANLANAN degil, GERCEKLESEN risk. Marj tavani miktari kirpinca
            // ikisi ayrisiyor ve planlanani kaydetmek toplam risk tavanini
            // sisirip yeni islemleri gereksiz yere blokluyordu.
            riskUsdt: result.riskUsdt ?? thisRisk,
          };
          saveState(state);

          // Bu tikte bloke edilen marji biriktir — sonraki sembollerin
          // butcesi artik guncel.
          tiktekiMarj +=
            ((result.quantity ?? 0) * (result.entryPrice ?? 0)) / LEVERAGE;

          // Koruma DOGRULAMASI sayiya degil, YAPIYA bakar: 'iki emir var'
          // demek 'dogru iki emir var' demek degil. Ayni yordam mutabakatta
          // ve nobet aracinda da kullaniliyor.
          const algo = await client.openAlgoOrders(symbol).catch(() => null);
          if (algo === null) {
            log('  !! koruma emirleri OKUNAMADI — sonraki tikte mutabakat bakacak');
            tickHadProblem = true;
          } else {
            const k = korumaDurumu(
              algo,
              signal.side === 'LONG' ? 1 : -1,
              result.entryPrice ?? 0,
            );
            log(
              `  koruma emri: stop ${k.stops.length}, hedef ${k.tps.length} (1+1 bekleniyor)`,
            );
            if (!k.stopVar || !k.tpVar) {
              log(
                `  !! UYARI: koruma eksik — ${!k.stopVar ? 'STOP YOK' : 'hedef yok'}`,
              );
              tickHadProblem = true;
            }
          }
        } else if (result.action === 'hata') {
          /**
           * BORSADA ACIK KALAN POZISYONU KAYDA GEC.
           *
           * ExecutionResult yalnizca dort eylem tasiyordu ve execute()'un
           * "pozisyon acildi ama geri kapatilamadi / kapatildigi
           * dogrulanamadi" diyen DORT dali da 'hata' olarak donuyordu.
           * Burasi yalnizca failedAttempts++ yapiyordu: state.positions'a
           * hicbir sey yazilmiyordu.
           *
           * Sonucu, bu projede uc kez duzeltilen hatanin dorduncu yuzu:
           * borsada ACIK (ve muhtemelen KORUMASIZ) bir pozisyon var ama
           * openCount() saymiyor, totalRiskUsdt() toplamiyor, marj butcesi
           * gormuyor. Tavanlar delinir, ustune yeni pozisyon acilabilir ve
           * koruma emirleri closePosition oldugu icin yeni stop BIRLESIK
           * pozisyonu kapatir — gerceklesen zarar hedeflenen riskin KATI.
           *
           * Kayit ayrica SAHIPLIK KANITI: reconcile artik kaniti olmayan
           * pozisyona dokunmuyor, yani bu satir olmadan kendi korumasiz
           * artigimiz "yabanci" sayilip yonetilemez hale gelirdi. Iki
           * duzeltme birbirini ZORUNLU kiliyor.
           */
          if (result.positionOpen) {
            const q = result.openQty ?? result.quantity ?? 0;
            const ep = result.openEntryPrice ?? result.entryPrice ?? 0;
            state.positions[symbol] = {
              symbol,
              side: result.openSide ?? signal.side,
              qty: q,
              entryPrice: ep,
              openedAt: Date.now(),
              clientOrderId: 'acik-kaldi',
              // Korumasiz olabilecegi icin risk MUHAFAZAKAR: stop mesafesi
              // biliniyorsa ondan, bilinmiyorsa planlanan riskten.
              riskUsdt:
                q > 0 && ep > 0
                  ? q * Math.abs(ep - signal.stopLoss)
                  : thisRisk,
            };
            saveState(state);
            log(
              `  !! POZISYON ACIK KALDI (${result.positionOpen}) — kayda gecirildi, ` +
                `mutabakat bir sonraki tikte devralacak. ELLE KONTROL ET.`,
            );
            tickHadProblem = true;
          }

          state.failedAttempts++;
          saveState(state);
          if (state.failedAttempts >= MAX_FAILED) {
            stop(
              `cok fazla basarisiz giris (${state.failedAttempts}) — komisyon kanamasi`,
            );
            break;
          }
        }
        } catch (symErr: any) {
          // Bu sembolde bir sey patladi; DIGER sembollere devam.
          log(`  [${symbol}] HATA: ${symErr?.message ?? symErr}`);
          stats.errors++;
          tickHadProblem = true;
          sorunluSembol++;
        }
      }

      /**
       * Hata sayaci YALNIZCA HESAP/BORSA duzeyinde bir ariza icin birikir.
       *
       * Onceki hali: 20 sembolden HERHANGI birinde sorun cikinca
       * consecutiveErrors artiyordu. Bir tek sembolde gecici bir zaman asimi
       * ya da sembole ozgu bir Binance hatasi, kalan 19 sembol sorunsuz
       * calisirken botu sekiz tikte durduruyordu — ve durma gerekcesi
       * "borsa ya da ag bozuk olabilir" diyordu ki dogru degil.
       *
       * Ters yon de yanlisti: sayac YALNIZCA tamamen temiz bir tikte
       * sifirlaniyordu, yani tek bir sembolde surekli bir ariza (orn.
       * listeden kaldirilmis bir parite) botu kacinilmaz olarak durdururdu.
       *
       * Dogru esik "hepsi": borsa gercekten bozuksa 20 sembolun 20'si de
       * duser. Tek sembollu kosuda davranis eskisiyle ayni kalir.
       */
      if (sorunluSembol >= SYMBOLS.length) {
        stats.consecutiveErrors++;
        log(
          `  TUM semboller sorunlu (${sorunluSembol}/${SYMBOLS.length}) — ` +
            `hesap/borsa duzeyi ariza sayiliyor (${stats.consecutiveErrors}/${MAX_ERRORS})`,
        );
      } else {
        stats.consecutiveErrors = 0;
        if (tickHadProblem && stats.ticks % 20 === 1) {
          log(
            `  bu tikte ${sorunluSembol}/${SYMBOLS.length} sembolde sorun — ` +
              `hesap duzeyi ariza degil, hata sayaci artmadi`,
          );
        }
      }
    } catch (e: any) {
      stats.errors++;
      stats.consecutiveErrors++;
      log(`HATA (${stats.consecutiveErrors}/${MAX_ERRORS}): ${e?.message ?? e}`);
      if (stats.consecutiveErrors >= MAX_ERRORS) {
        stop('ust uste cok fazla hata — borsa ya da ag bozuk olabilir');
        break;
      }
      await sleep(TICK_SEC * 2000);
      continue;
    }

    if (stats.consecutiveErrors >= MAX_ERRORS) {
      stop('borsa durumu ust uste okunamiyor');
      break;
    }

    await sleep(TICK_SEC * 1000);
  }

  // --- Kapanis raporu ---
  /**
   * Kapanis raporu OZKAYNAK ile OZKAYNAGI kiyaslamali.
   *
   * Onceki hali bitis degeri olarak balanceUsdt (KULLANILABILIR NAKIT)
   * aliyor ve onu dayStartEquity (OZKAYNAK) ile cikariyordu. Acik
   * pozisyon varken marj bloke oldugu icin nakit dusuk olur; rapor
   * TAMAMEN SAHTE bir zarar bildirir.
   *
   * Bu kosuda somut olarak: baslangic 4913.91, bitis 4122.94 gorunurdu
   * — yani hic para kaybedilmemisken "-790.97 USDT" yani %16 zarar.
   * Sabah bu rapora bakip karar verilecekti.
   *
   * ping() ayni hatasi zarar sinirinda duzeltilmisti; kapanis raporunda
   * hayatta kalmis. Ayni hatanin TUM cagri yerlerini aramak bu projede
   * tekrar tekrar ogrenilen ders.
   */
  const sonDurum = await client
    .ping()
    .catch(() => ({ balanceUsdt: NaN, equityUsdt: NaN }));
  const endEquity = sonDurum.equityUsdt;
  const endBal = sonDurum.balanceUsdt;
  log('\n' + '='.repeat(70));
  log('DAYANIKLILIK TESTI RAPORU');
  log(`  calisma          : ${stats.ticks} tik x ${TICK_SEC}sn`);
  log(`  semboller        : ${SYMBOLS.join(', ')}`);
  log(`  uretilen sinyal  : ${stats.signals}`);
  log(`  acilan islem     : ${stats.trades}`);
  log(`  basarisiz deneme : ${state.failedAttempts}`);
  log(`  hata sayisi      : ${stats.errors}`);
  const bloke =
    Number.isFinite(endEquity) && Number.isFinite(endBal)
      ? Math.max(0, endEquity - endBal)
      : NaN;
  log(`  gun basi ozkaynak: ${state.dayStartEquity.toFixed(4)} USDT`);
  log(
    `  bitis ozkaynagi  : ${Number.isFinite(endEquity) ? endEquity.toFixed(4) : '?'} USDT` +
      (Number.isFinite(bloke) && bloke > 0
        ? `  (bunun ${bloke.toFixed(2)}'i acik pozisyonlarda marj olarak bloke)`
        : ''),
  );
  log(
    `  fark             : ${
      Number.isFinite(endEquity)
        ? (endEquity - state.dayStartEquity >= 0 ? '+' : '') +
          (endEquity - state.dayStartEquity).toFixed(4)
        : '?'
    } USDT` + (openCount(state) > 0 ? '   (acik pozisyonlarin kagit kari dahil)' : ''),
  );

  for (const symbol of SYMBOLS) {
    const p = await client.position(symbol).catch(() => null);
    const a = await client.openAlgoOrders(symbol).catch(() => []);
    log(`  ${symbol}: pozisyon ${p ? p.positionAmt : '?'}, koruma emri ${a.length}`);
  }

  log('');
  log('  DIKKAT: yukaridaki "fark" istatistiksel olarak ANLAMSIZDIR.');
  log('  Bakilacak sey: hata sayisi, coku olup olmadigi, korumanin her');
  log('  islemde yerine oturup oturmadigi.');
  log('='.repeat(70));
}

main().catch((e) => {
  log(`OLUMCUL HATA: ${e?.message ?? e}`);
  process.exit(1);
});
