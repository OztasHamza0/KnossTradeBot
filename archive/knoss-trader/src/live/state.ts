import * as fs from 'fs';
import * as path from 'path';

/**
 * Kalici bot durumu.
 *
 * Iki ayri gercek sorunu cozuyor, ikisi de denetimden cikti:
 *
 * 1. BOTUN KENDI POZISYONUNU AYIRT EDEMEMESI. reconcile(), semboldeki HER
 *    pozisyonu kendi pozisyonu sayiyordu. Kullanici elle bir pozisyon acmis
 *    olsa bot onu "korumasiz" bulup PIYASADAN KAPATIRDI — ustelik cancelAll
 *    ile kullanicinin emirlerini de silerdi. Bot artik yalnizca KENDI actigi
 *    pozisyonu yonetiyor; tanimadigi bir pozisyon varsa hic baslamiyor.
 *
 * 2. GUVENLIK SINIRLARININ SIFIRLANMASI. MAX_TRADES ve MAX_LOSS_PCT surec
 *    hafizasindaydi. Bot cokup yeniden baslayinca sayaclar sifirlaniyordu:
 *    "en fazla 20 islem" sinirini bir cokme dongusu sonsuza kadar delebilirdi.
 *    Ayni gun icinde sayaclar dosyadan devam ediyor.
 */

export interface OwnPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  openedAt: number;
  clientOrderId: string;
  /** Bu pozisyonda riske atilan tutar (USDT) — toplam risk tavani icin. */
  riskUsdt: number;
}

export interface BotState {
  /** Sayaclarin ait oldugu gun (UTC, YYYY-MM-DD). Gun degisince sifirlanir. */
  day: string;
  /** Bu gun acilan islem sayisi (TUM semboller). */
  trades: number;
  /** Basarisiz/geri alinan giris denemeleri — bunlar da komisyon yakar. */
  failedAttempts: number;
  /**
   * Gunun ilk OZKAYNAGI (walletBalance + gerceklesmemis kar/zarar).
   * Zarar sinirinin referansi. Kullanilabilir bakiye DEGIL: acik pozisyonun
   * bloke ettigi marj onu dusurur ve bot bunu zarar sanardi.
   */
  dayStartEquity: number;
  /**
   * Botun actigi pozisyonlar, SEMBOL BAZINDA.
   *
   * Onceden tek bir ownPosition vardi ve durum dosyasi tek bir sabit yola
   * yaziliyordu. Coklu sembolu "her sembol icin ayri surec" diye calistirmak
   * bu yuzden TEHLIKELIYDI: iki surec ayni dosyayi ezer, biri digerinin
   * pozisyon kaydini silerdi. Sonra o bot kendi pozisyonunu "yabanci" sanip
   * ya hic baslamaz ya da ona dokunurdu.
   *
   * Cozum ayri surecler degil, TEK SUREC + sembol bazli kayit: sayaclar ve
   * risk tavani hesap genelinde tek yerde toplanir.
   */
  positions: Record<string, OwnPosition>;
  /**
   * NIYET KAYDI — giris emri GONDERILMEDEN ONCE yazilir, islem bittikten
   * sonra silinir.
   *
   * Neden gerekli: emir borsaya gidip pozisyon acildiktan SONRA ama durum
   * dosyasi yazilmadan ONCE bot cokerse (elektrik, OOM, kill), pozisyon
   * borsada var ama kayitta yok. Yeniden baslarken "botun ACMADIGI bir
   * pozisyon var" kapisi devreye girer ve bot BIR DAHA HIC BASLAMAZ —
   * yalnizca o sembol icin degil, 20 sembolun TAMAMININ mutabakati durur.
   *
   * Bu pencere kucuk ama gozetimsiz ve gercek parayla calisan bir sistemde
   * "kucuk" yeterli bir cevap degil. Niyet kaydi sayesinde bot, kendi
   * actigi bir pozisyonu tanidigini KANITLAYABILIR ve sahiplenebilir;
   * tanimadigi pozisyona hala dokunmaz.
   */
  pending?: Record<string, { symbol: string; side: 'LONG' | 'SHORT'; at: number }>;
  /**
   * Sembol basina EN SON ISLENEN mumun acilis zamani.
   *
   * Neden kalici olmasi gerekiyor: bu kayit "ayni mumda iki kez islem
   * acma" korumasi. Surec hafizasinda tutuldugu surece, bot her yeniden
   * baslayisinda bos gelir ve en son kapanmis mumu "hic gorulmemis"
   * sayar.
   *
   * Bayat mum kapisi bunun cogunu kapatiyor (3 dakikadan eski mumla
   * islem acilmiyor), ama pencere tamamen kapanmiyor: mum kapanir, bot
   * girer, stop calisir, bot olur ve UC DAKIKA ICINDE yeniden baslarsa —
   * pozisyon artik kapali oldugu icin reconcile() de engellemez —
   * AYNI mumda ikinci kez girilir.
   *
   * Dar bir pencere, ama gozetimsiz ve gercek parayla calisan bir
   * sistemde "dar" yeterli bir cevap degil. Ustelik elle yeniden
   * baslatma bu pencereyi bilerek acar.
   */
  lastBar?: Record<string, number>;
  /**
   * Durum dosyasi OKUNAMADI ya da BOZUK.
   *
   * "Okuyamadim" ile "durum yok" AYNI SEY DEGIL — bu projede iki kez para
   * kaybettirebilecek hataya yol acan ayrim. Onceki hali bozuk dosyayi
   * sessizce temiz durum sayiyordu ve bunu "guvenli taraf" diye bir testle
   * sabitlemisti. Guvenli DEGILDI:
   *
   *   dayStartEquity GUNCEL bakiyeye sifirlaniyordu. Yani bot gunun ilk
   *   yarisinda %10 kaybettikten sonra dosya bozulursa, zarar sinirinin
   *   referansi dusmus bakiye oluyor ve bot TAZE bir %15 butcesi kazaniyor.
   *   Ayni sekilde MAX_TRADES sayaci sifirlaniyor.
   *
   * Bilinmeyen bir durumla gozetimsiz islem yapmak yerine bot BASLAMAYI
   * REDDEDER. Borsadaki koruma emirleri yerinde durdugu icin acik
   * pozisyonlar bu sirada korumasiz kalmaz.
   */
  bozuk?: boolean;
}

/**
 * Durum dosyasi yolu.
 *
 * Ortam degiskeniyle degistirilebilir olmasi SART: testler stateFilePath()
 * ile gercek dosyayi kullaniyordu, yani 'npm test' calistirmak CANLI botun
 * pozisyon kaydini siliyordu. Bot o sirada calisiyorsa kendi pozisyonunu
 * 'yabanci' sanip bir daha hic baslamazdi.
 */
const FILE =
  process.env.BOT_STATE_FILE ??
  path.resolve(__dirname, '../../bot-state.json');

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function emptyState(day: string, balance: number): BotState {
  return {
    day,
    trades: 0,
    failedAttempts: 0,
    dayStartEquity: balance,
    positions: {},
    pending: {},
    lastBar: {},
  };
}

export function loadState(now: number, balance: number): BotState {
  const day = utcDay(now);
  if (!fs.existsSync(FILE)) return emptyState(day, balance);

  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8')) as BotState;
    // Gun degistiyse sayaclar sifirlanir ama ACIK POZISYON KAYDI KORUNUR —
    // pozisyon gun sinirini bilmez.
    if (s.day !== day) {
      // Gun degisse de ACIK POZISYONLAR korunur; pozisyon gun sinirini bilmez.
      return {
        ...emptyState(day, balance),
        positions: s.positions ?? {},
        pending: s.pending ?? {},
        // Gun donse de korunur: mum kimligi gunden bagimsiz.
        lastBar: s.lastBar ?? {},
      };
    }
    return {
      ...s,
      positions: s.positions ?? {},
      pending: s.pending ?? {},
      lastBar: s.lastBar ?? {},
    };
  } catch {
    // Bozuk/okunamayan dosya TEMIZ DURUM DEGILDIR. Isaretleyip donuyoruz;
    // cagiran taraf (run.ts) baslamayi reddediyor. Bkz. BotState.bozuk.
    return { ...emptyState(day, balance), bozuk: true };
  }
}

/**
 * Durumu ATOMIK yazar: once gecici dosyaya, sonra yerine tasir.
 *
 * NEDEN ATOMIK OLMASI GEREKIYOR — ve bu ihtiyac BUGUN ARTTI:
 *   Dogrudan FILE uzerine yazarken surec yazmanin ORTASINDA olurse
 *   (elektrik, OOM, zorla oldurme) geriye YARIM bir JSON kalir. Eskiden
 *   bunun bedeli sinirliydi: loadState bozuk dosyayi sessizce temiz durum
 *   sayip devam ediyordu.
 *
 *   Ama bugun o davranisi degistirdim — bozuk dosya artik botu
 *   BASLATMIYOR, cunku temiz durumla devam etmek gunluk zarar sinirinin
 *   referansini sifirliyordu. Dogru bir duzeltmeydi, ama yarim yazmanin
 *   bedelini "biraz guvenlik kaybi"ndan "bot hic acilmaz"a cikardi.
 *
 *   Yani kendi duzeltmem, bu ikinci duzeltmeyi ZORUNLU kildi. Durum
 *   dosyasi her islemde yaziliyor; gozetimsiz bir gecede o pencerede
 *   olme ihtimali kucuk ama sifir degil.
 *
 * rename() ayni dosya sisteminde atomiktir: ya eski dosya tamamen
 * durur, ya yeni dosya tamamen yerindedir. Yarim hal YOKTUR. Windows'ta
 * Node bunu MOVEFILE_REPLACE_EXISTING ile yapar, yani hedef varken de
 * calisir.
 */
export function saveState(s: BotState): void {
  const gecici = FILE + '.tmp';
  try {
    fs.writeFileSync(gecici, JSON.stringify(s, null, 2));
    fs.renameSync(gecici, FILE);
  } catch {
    // Durum yazamamak botu durdurmamali; bir sonraki tik tekrar dener.
    // Gecici dosya kaldiysa temizle — birakmak, bir sonraki yazmanin
    // uzerine yazacagi olu bir dosya birakmak demek.
    try {
      if (fs.existsSync(gecici)) fs.unlinkSync(gecici);
    } catch {
      /* temizlik de basarisizsa yapacak bir sey yok */
    }
  }
}

/**
 * Gun dondu mu — dondu ise sayaclari sifirlar ve true doner.
 *
 * NEDEN AYRI FONKSIYON: ayni mantik loadState() icinde de var ama o YALNIZCA
 * ACILISTA cagriliyor. Calisan bir surecte gun hic donmuyordu; yani gun
 * donusu, canli yolda OLU KODDU. Olculdu: bot 02 Eylul 21:50 UTC'de basladi,
 * 03 Eylul 05:30'da hala day = "2026-09-02" diyordu.
 *
 * Sonucu, kodun soyledigi ile yaptiginin ayrismasiydi:
 *  - "gunluk en fazla N islem" fiilen OMUR BOYU tavan oluyordu;
 *  - "gunluk %N zarar siniri" surecin baslatildigi andan olculuyordu.
 *
 * ACIK POZISYON KAYDI KORUNUR: pozisyon gun sinirini bilmez, ve kaydi
 * silinirse bot kendi pozisyonunu "yabanci" sanip durur.
 */
export function rollDayIfNeeded(
  s: BotState,
  now: number,
  equity: number,
): boolean {
  const today = utcDay(now);
  if (s.day === today) return false;
  s.day = today;
  s.trades = 0;
  s.failedAttempts = 0;
  s.dayStartEquity = equity;
  return true;
}

export function stateFilePath(): string {
  return FILE;
}

/** Su an acik olan pozisyonlarin toplam riski (USDT). */
export function totalRiskUsdt(s: BotState): number {
  return Object.values(s.positions).reduce((sum, p) => sum + (p.riskUsdt || 0), 0);
}

/** Acik pozisyon sayisi. */
export function openCount(s: BotState): number {
  return Object.keys(s.positions).length;
}
