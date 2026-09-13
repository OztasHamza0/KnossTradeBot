import {
  BinanceFuturesClient,
  SymbolFilters,
  roundStep,
} from './client';
import { Signal } from '../backtest/types';
import {
  checkStopVsLiquidation,
  checkRiskReward,
  checkRiskPerTrade,
} from '../core/risk';
import { korumaDurumu } from './protection';

/**
 * Emir yurutucusu.
 *
 * Backtest ile canli arasindaki fark, strateji mantigi degil BU dosyadir.
 * Backtest'te "stop 95'te" bir sayidir; canlida borsada duran bir emirdir ve
 * o emir yoksa stop YOKTUR.
 *
 * Tasarim ilkeleri:
 *   1. Stop ve hedef, giristen HEMEN SONRA borsaya yazilir.
 *   2. Koruma yazilamadiysa pozisyon ANINDA kapatilir. Korumasiz pozisyon
 *      tasimaktansa islemi hic yapmamak yeglenir.
 *   3. Her calisma oncesi borsayla mutabakat yapilir — bot yeniden
 *      baslatilinca ikinci pozisyon acmamali.
 *   4. Kuru mod (dry run) gercek emir gondermez ama tum hesaplari yapar.
 */

/**
 * Tek islemin teminata koyabilecegi azami bakiye orani.
 * 'Risk %1' yalnizca stop tam fiyatindan dolarsa dogrudur; fiyat boslukla
 * atlarsa kayip marjin tamamina kadar cikar. O yuzden marjin kendisi de
 * sinirlanir.
 */
export const MAX_MARGIN_RATIO = 0.25;

export interface ExecutorConfig {
  symbol: string;
  leverage: number;
  /** Islem basina riske atilacak bakiye yuzdesi. */
  riskPct: number;
  /** true ise hicbir emir gonderilmez, yalnizca ne yapilacagi yazilir. */
  dryRun: boolean;
}

export interface ExecutionResult {
  action: 'girildi' | 'atlandi' | 'kuru-mod' | 'hata';
  detail: string;
  entryPrice?: number;
  quantity?: number;
  /**
   * GERCEKLESEN risk (USDT) — planlanan degil.
   *
   * Marj tavani miktari kirptiginda gercek risk planlanandan DUSUK kalir.
   * Onceki halinde run.ts, planlanan riski (bakiye x riskPct) kaydediyordu;
   * olculdu ki 4 acik pozisyonda kayitli toplam risk 143.60 USDT iken
   * gerceklesen 46.40 USDT idi — 3.1 kat sisirilmis. Bu iki seyi bozuyordu:
   *  - toplam risk tavani gereginden erken kapaniyor, islem kaciriliyordu;
   *  - R katsayisi (kar / risk) muhasebesi yanlis cikiyordu ki botun tum
   *    varlik sebebi olcum yapmak.
   * Gercek giris fiyatindan hesaplanir, mark fiyatindan degil.
   */
  riskUsdt?: number;
  stopOrderId?: number;
  tpOrderId?: number;
  /**
   * BORSADA POZISYON KALDI MI — 'hata' dalinin en onemli bilgisi.
   *
   * ExecutionResult yalnizca 'girildi' | 'atlandi' | 'kuru-mod' | 'hata'
   * tasiyordu. Ama execute() icinde DORT ayri dal "pozisyon acildi ama geri
   * kapatilamadi / kapatildigi dogrulanamadi" durumunu uretiyor ve hepsi
   * 'hata' olarak donuyordu. run.ts bunu gorunce yalnizca failedAttempts++
   * yapip geciyordu: state.positions'a HICBIR kayit yazilmiyordu.
   *
   * Sonucu, bu projede daha once uc kez duzeltilen hatanin dorduncu yuzu:
   * borsada ACIK (ve muhtemelen KORUMASIZ) bir pozisyon var ama openCount()
   * onu saymiyor, totalRiskUsdt() riskini toplamiyor, portfoy marj butcesi
   * gormuyor. Tavanlar delinir ve o artigin USTUNE yeni pozisyon acilabilir;
   * koruma emirleri closePosition ile yazildigi icin yeni stop BIRLESIK
   * pozisyonu kapatir, yani gerceklesen zarar hedeflenen riskin KATI olur.
   *
   * 'evet'       : borsadan OKUNARAK dogrulandi, pozisyon duruyor.
   * 'bilinmiyor' : okunamadi; var SAYILMALI (guvenli taraf, bilmedigimiz
   *                sey hakkinda karar vermemektir).
   */
  positionOpen?: 'evet' | 'bilinmiyor';
  /** positionOpen dolu ise: borsadan okunan miktar ve giris fiyati. */
  openQty?: number;
  openEntryPrice?: number;
  openSide?: 'LONG' | 'SHORT';
}

export class Executor {
  private filters: SymbolFilters | null = null;

  constructor(
    private readonly client: BinanceFuturesClient,
    private readonly cfg: ExecutorConfig,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  /**
   * ACIK POZISYON VARKEN KALDIRAC/MARJ AYARI DEGISTIRILMEZ.
   *
   * prepare() her acilista cagriliyor. Bot acik bir pozisyonla yeniden
   * baslarsa (cokme, elle yeniden baslatma, ya da parametre degisikligi),
   * setLeverage o pozisyonun LIKIDASYON MESAFESINI degistirir — ve
   * kaldirac yukseltilirse likidasyon fiyata YAKLASIR. Kullanici bunu
   * gormez; borsadaki stop emri yerinde durdugu icin her sey normal
   * gorunur, ama pozisyonun altindaki zemin kaymistir.
   *
   * Gercek senaryo: bot 3x ile pozisyon acti, sonra 5x parametresiyle
   * yeniden baslatildi. Eski pozisyonun likidasyonu %32.8'den %19.5'e
   * yaklasir. Stop hala %3'te oldugu icin tehlike dogrudan degil, ama
   * sistem artik olculdugu gibi davranmiyor.
   *
   * Dogru davranis: pozisyon acikken DOKUNMA, yalnizca logla. Pozisyon
   * kapaninca bir sonraki tikte zaten dogru ayarla acilacak.
   */
  async prepare(): Promise<void> {
    this.filters = await this.client.symbolFilters(this.cfg.symbol);
    if (this.cfg.dryRun) return;

    // "Okuyamadim" ile "pozisyon yok" ayni sey degil: okuma basarisiz
    // olursa DOKUNMUYORUZ. Ayar degistirmemek, yanlis ayar yapmaktan iyi.
    const pos = await this.client.position(this.cfg.symbol).catch(() => null);
    if (pos === null) {
      this.log(
        '  pozisyon okunamadi — kaldirac/marj ayarina DOKUNULMUYOR ' +
          '(acik pozisyon olabilir)',
      );
      return;
    }
    if (Math.abs(pos.positionAmt) > 0) {
      this.log(
        `  acik pozisyon var (${pos.positionAmt}) — kaldirac/marj ayari ` +
          `DEGISTIRILMIYOR. Mevcut kaldirac ${pos.leverage}x, ` +
          `istenen ${this.cfg.leverage}x.`,
      );
      return;
    }

    await this.client.setIsolated(this.cfg.symbol);
    await this.client.setLeverage(this.cfg.symbol, this.cfg.leverage);
  }

  /**
   * UCUS ONCESI KONTROL: bu borsa koruma emri kabul ediyor mu?
   *
   * Bu kontrol gercek bir arizadan sonra eklendi. Ilk testnet kosusunda bot
   * once GIRDI, sonra stop emrinin reddedildigini ogrendi ve pozisyonu geri
   * kapatti. Guvenlik acisindan dogru davranis, ama her denemede gidis-donus
   * komisyonu yaniyordu (5000.00 -> 4996.35 USDT).
   *
   * Dogrusu once sormak. /fapi/v1/order/test emri GONDERMEDEN gecerliligini
   * sinar, yani bu kontrol bedava. Borsa koruma emrini kabul etmiyorsa
   * islem HIC acilmamali: stopu borsaya yazamayacaksak, pozisyon aciamayiz.
   */
  async canPlaceProtection(): Promise<{ ok: boolean; reason?: string }> {
    if (this.cfg.dryRun) return { ok: true };

    // Algo ucunun /order/test karsiligi YOK, o yuzden kontrol gercek bir
    // emirle yapiliyor — ama tetigi piyasadan %50 uzakta, yani TETIKLENMESI
    // IMKANSIZ, ve hemen iptal ediliyor. Dolmayan emir komisyon dogurmaz,
    // dolayisiyla bu kontrol de bedava.
    let algoId: number | null = null;
    try {
      const mark = await this.client.markPrice(this.cfg.symbol);
      const f = this.filters!;
      const farPrice = roundStep(mark * 0.5, f.tickSize, f.pricePrecision);

      const probe = await this.client.protectiveOrder(
        this.cfg.symbol,
        'SELL',
        'STOP_MARKET',
        farPrice,
        `pf-${Date.now()}`,
      );
      algoId = probe.orderId;
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message ?? e);

      // -4509: "closePosition emri acik pozisyon gerektirir".
      // Bu bir RED degil, dogru cevap: emir TIPI kabul edildi, yalnizca
      // kapatacak pozisyon yok — kontrolu pozisyonsuz yaptigimiz icin
      // beklenen sonuc bu. Gercek engel -4120'dir ("bu uc bu emir tipini
      // desteklemiyor"). Ikisini ayirmazsak bot, koruma pekala calisirken
      // "yazamiyorum" deyip hic baslamaz.
      if (msg.includes('-4509')) {
        this.log(
          '  koruma emri tipi kabul ediliyor (kontrol pozisyonsuz yapildigi ' +
            'icin -4509 dondu, bu beklenen).',
        );
        return { ok: true };
      }

      /**
       * -4130: "An open stop or take profit order with GTE and closePosition
       * in the direction is existing."
       *
       * Bu da RED DEGIL — tam tersi KANIT. Borsa emir tipini kabul etti ve
       * yalnizca AYNI YONDE zaten bir closePosition emri oldugu icin
       * reddediyor. Yani koruma emri yazma yetenegi CALISIYOR; ustelik
       * korunmasi gereken pozisyonun korumasi ZATEN YERINDE.
       *
       * GERCEK OLAY: bot pozisyon tasirken yeniden baslatildiginda,
       * kontrol her zaman SYMBOLS[0] uzerinde yapildigi icin o sembolde
       * acik pozisyon + stop emri varsa -4130 aliniyordu ve bot BASLAMIYORDU.
       * Gece 01:21'de tam bu oldu: uc pozisyon dogru sahiplenildi, kaldirac
       * dogru korundu, sonra bu kontrol botu 3.7 saat ayakta tutmadi.
       *
       * Pozisyonlar borsadaki stoplarina emanet kaldigi icin para riski
       * dogmadi, ama mutabakat, zaman asimli cikis ve yeni sinyal durdu —
       * ve gercek parayla da ayni sey olurdu.
       */
      if (msg.includes('-4130')) {
        this.log(
          '  koruma emri tipi kabul ediliyor (bu sembolde zaten bir ' +
            'closePosition emri var — -4130 bunun KANITI, engel degil).',
        );
        return { ok: true };
      }

      return { ok: false, reason: msg };
    } finally {
      // Kontrol emri ASLA geride kalmamali.
      if (algoId !== null) {
        await this.client
          .cancelAlgoOrder(this.cfg.symbol, algoId)
          .catch((e: any) =>
            this.log(`  !! kontrol emri iptal edilemedi (${algoId}): ${e?.message}`),
          );
      }
    }
  }

  /**
   * Borsayla mutabakat.
   *
   * Bot her yeniden baslayisinda gercek durumu borsadan OGRENMELI, kendi
   * hafizasina guvenmemeli: hafiza cokusle birlikte gider, pozisyon gitmez.
   */
  async reconcile(opts: { owned?: boolean } = {}): Promise<{
    /**
     * 'bilinmiyor' = borsayla konusulamadi. Karar VERILMEZ, tik atlanir.
     * 'yabanci'    = pozisyon var ama BIZIM oldugunu kanitlayamiyoruz.
     */
    state: 'bos' | 'korunuyor' | 'kapatildi' | 'bilinmiyor' | 'yabanci';
    hasPosition: boolean;
    detail: string;
    /** Stop yerinde ama HEDEF emri kayip — backtest'ten ayrisma. */
    tpEksik?: boolean;
  }> {
    const pos = await this.client.position(this.cfg.symbol);
    if (Math.abs(pos.positionAmt) === 0) {
      // POZISYON KAPANDIYSA KALDIRAC AYARINI TAZELE.
      //
      // prepare() yalnizca ACILISTA cagriliyor ve acik pozisyon varken
      // kaldirac/marj ayarina bilerek DOKUNMUYOR (dogru davranis: calisan bir
      // pozisyonun likidasyon zeminini kaydirmak tehlikeli). Ama o pozisyon
      // kapandiktan sonra ayari yapan KIMSE YOKTU: sembol, bot yeniden
      // baslatilana kadar borsadaki ESKI kaldiracla islem acmaya devam
      // ediyordu. Yani "5x ile calisiyorum" diyen bot, o sembolde 3x (ya da
      // 20x) ile giriyor olabilirdi — likidasyon mesafesi hesaplanandan
      // farkli, checkStopVsLiquidation yanlis sayiyla karar veriyor.
      //
      // Burasi dogru yer: pozisyon SIFIR oldugu KESIN bilindigi an, ve
      // reconcile zaten her tik position() cagiriyor — ek API cagrisi yok.
      // setLeverage yalnizca GERCEKTEN farkliysa gonderiliyor.
      if (
        !this.cfg.dryRun &&
        Number.isFinite(pos.leverage) &&
        pos.leverage !== this.cfg.leverage
      ) {
        this.log(
          `  kaldirac borsada ${pos.leverage}x, istenen ${this.cfg.leverage}x — ` +
            `pozisyon kapali, duzeltiliyor`,
        );
        await this.client.setIsolated(this.cfg.symbol).catch(() => undefined);
        await this.client
          .setLeverage(this.cfg.symbol, this.cfg.leverage)
          .catch((e: any) => this.log(`  !! kaldirac ayarlanamadi: ${e?.message}`));
      }
      return { state: 'bos', hasPosition: false, detail: 'Acik pozisyon yok.' };
    }

    /**
     * SAHIPLIK — botun en temel kurali: baskasinin pozisyonuna DOKUNMA.
     *
     * Aciliste bunu denetleyen bir kapi vardi (run.ts, "botun ACMADIGI bir
     * pozisyon var" -> baslamaz). Ama CALISMA SIRASINDA hicbir kontrol yoktu:
     * reconcile() semboldeki HER pozisyonu kendi pozisyonu sayiyor, eslesen
     * stop bulamayinca PIYASADAN KAPATIYORDU.
     *
     * Yani bot calisirken Binance panelinden elle acilan (ve stopu heniz
     * konmamis) bir pozisyon, bir sonraki tikte bot tarafindan kapatilirdi.
     * Aciliste reddedilen davranisin calisma sirasinda serbest olmasi, kapinin
     * kendisini anlamsiz kilar.
     *
     * Sahiplik kaniti state.positions kaydidir ve run.ts'ten geliyor.
     * Kanit yoksa: OKU, LOGLA, DOKUNMA.
     */
    if (opts.owned === false) {
      return {
        state: 'yabanci',
        hasPosition: true,
        detail:
          `Bu pozisyon botun kaydinda YOK: ` +
          `${pos.positionAmt > 0 ? 'LONG' : 'SHORT'} ${Math.abs(pos.positionAmt)} ` +
          `@ ${pos.entryPrice}. Bot baskasinin pozisyonuna DOKUNMAZ — ` +
          `ne kapatiliyor ne koruma yaziliyor.`,
      };
    }

    // Koruma emirleri ALGO emirleridir ve /fapi/v1/openOrders'ta GORUNMEZLER.
    // 9 Aralik 2025 API degisikliginin yan etkisi.
    //
    // "OKUYAMADIM" ILE "KORUMA YOK" AYNI SEY DEGIL — onceki surumde
    // openAlgoOrders hatasi yakalanip bos liste sayiliyordu, yani tek bir
    // gecici ag hatasi SAGLAM VE KORUNAN bir pozisyonu piyasadan kapattiriyordu.
    // Daha da kotusu: bunu "guvenli taraf" diye bir testle sabitlemistim.
    // Guvenli taraf, bilmedigimiz sey hakkinda KARAR VERMEMEKTIR.
    let algo: any[];
    try {
      algo = await this.client.openAlgoOrders(this.cfg.symbol);
    } catch (e: any) {
      return {
        state: 'bilinmiyor',
        hasPosition: true,
        detail:
          `Koruma emirleri OKUNAMADI (${e?.message}). Pozisyona dokunulmuyor, ` +
          `bir sonraki tik'te tekrar denenecek.`,
      };
    }

    const koruma = korumaDurumu(algo, pos.positionAmt, pos.entryPrice);

    if (koruma.stopVar) {
      return {
        state: 'korunuyor',
        hasPosition: true,
        // HEDEF EMRI DE IZLENIYOR. Onceki hali yalnizca STOP ariyordu; hedef
        // kaybolsa (elle iptal, borsa tarafinda dusme) bot bunu HIC fark
        // etmezdi. Pozisyon korumasiz kalmaz ama olculen sistem degisir:
        // backtest her islemi stop VE hedef ile modelliyor, hedefsiz kalan
        // pozisyon yalnizca stop ya da zaman asimiyla cikar. Kapatma sebebi
        // DEGIL — hedefi olmayan bir pozisyonu piyasadan kapatmak, taker
        // komisyonu odeyip islem tezini bosa dusurmek olurdu.
        tpEksik: !koruma.tpVar,
        detail:
          `Acik pozisyon: ${pos.positionAmt > 0 ? 'LONG' : 'SHORT'} ` +
          `${Math.abs(pos.positionAmt)} @ ${pos.entryPrice}, ` +
          `PnL ${pos.unrealizedProfit.toFixed(2)} USDT, stop borsada` +
          (koruma.tpVar ? '.' : ' ama HEDEF EMRI YOK.'),
      };
    }

    this.log(
      '!! Acik pozisyon var ama ESLESEN STOP EMRI YOK. Korumasiz — kapatiliyor.',
    );
    if (this.cfg.dryRun) {
      return { state: 'kapatildi', hasPosition: false, detail: '(kuru mod)' };
    }

    // KAPATMANIN SONUCU OKUNMALI. Onceki surumde closeNow void donuyordu ve
    // reconcile kosulsuz "kapatildi" diyordu — kapatma basarisiz olsa bile.
    // Sonucu: run.ts pozisyon kaydini siliyor, openCount ve toplam risk o
    // pozisyonu saymiyor, portfoy tavanlari geciliyor ve borsada duran
    // korumasiz artigin USTUNE ikinci pozisyon aciliyordu. Koruma emirleri
    // closePosition ile yazildigi icin yeni stop BIRLESIK pozisyonu kapatir,
    // yani gerceklesen zarar planlanan riskin KATI olur.
    const outcome = await this.closeNow(pos);

    if (outcome === 'kapandi') {
      return {
        state: 'kapatildi',
        hasPosition: false,
        detail: 'Korumasiz pozisyon kapatildi.',
      };
    }

    // Kapanmadi ya da dogrulanamadi: pozisyon HALA VAR say. Boylece kayit
    // silinmez, maruziyet eksik sayilmaz ve yeni giris yapilmaz.
    return {
      state: 'bilinmiyor',
      hasPosition: true,
      detail:
        outcome === 'kismi'
          ? 'Kapatma emri gonderildi ama pozisyon hala acik — bir sonraki tik tekrar denenecek.'
          : 'Kapatma sonucu DOGRULANAMADI — pozisyon var sayiliyor.',
    };
  }

  /** Disaridan cagrilabilir kapatma — zaman asimli cikis icin. */
  /**
   * Disaridan cagrilabilir kapatma — zaman asimli cikis icin.
   *
   * SONUC DONER, void DEGIL. Onceki hali void donuyordu ve run.ts kapatmanin
   * basarili olup olmadigini BILMEDEN pozisyon kaydini siliyordu. Kayit
   * silinince openCount ve toplam risk o pozisyonu saymayi birakir, portfoy
   * tavanlari delinir ve hala acik olan pozisyonun USTUNE yenisi acilabilir;
   * koruma emirleri closePosition kullandigi icin yeni stop BIRLESIK
   * pozisyonu kapatir, yani gerceklesen zarar hedeflenen riskin kati olur.
   * Ayni hata reconcile() icinde bir kez duzeltilmisti; burada duruyordu.
   */
  async closePosition(): Promise<'kapandi' | 'kismi' | 'dogrulanamadi' | 'bos'> {
    const pos = await this.client.position(this.cfg.symbol);
    if (Math.abs(pos.positionAmt) === 0) return 'bos';
    return this.closeNow(pos);
  }

  /**
   * Bu stop GERCEKTEN bu pozisyonu koruyor mu?
   *
   * Onceden yalnizca "tipi STOP_MARKET olan bir emir var mi" diye
   * bakiliyordu. Bu yetersizdi: ucus oncesi kontrol emri (tetigi piyasanin
   * %50 altinda, iptal edilememis olabilir) ya da onceki bir kosudan kalmis
   * alakasiz bir emir "koruma var" sayiliyordu. Pozisyon fiilen savunmasizken
   * bot onu korunuyor sanip sabaha kadar birakabilirdi.
   *
   * Uc sart: dogru YON, tetik pozisyonun DOGRU TARAFINDA, ve kontrol emri
   * olmamali.
   */
  private hasMatchingStop(
    algo: any[],
    positionAmt: number,
    entryPrice: number,
  ): boolean {
    // Yordamin kendisi protection.ts'e tasindi: ayni soru check.ts'te AYRI
    // yazilmisti ve iki cevap ayrismisti. Tek kaynak.
    return korumaDurumu(algo, positionAmt, entryPrice).stopVar;
  }

  /**
   * Pozisyonu kapatir.
   *
   * Iki degisiklik, ikisi de denetimden cikti:
   *  - reduceOnly: pozisyon o sirada baska sebeple kapanmissa (stop tetiklendi,
   *    elle kapatildi, likidasyon) duz bir piyasa emri TERS YONDE YENI VE
   *    KORUMASIZ pozisyon acardi. reduceOnly bunu imkansiz kilar.
   *  - Miktar yeniden YUVARLANMIYOR: borsanin verdigi deger oldugu gibi
   *    gonderiliyor, yoksa bir adimlik artik acik kaliyordu.
   * Ayrica koruma emirleri, pozisyonun gercekten kapandigi DOGRULANDIKTAN
   * sonra iptal ediliyor.
   */
  private async closeNow(pos: {
    positionAmt: number;
    positionAmtRaw: string;
  }): Promise<'kapandi' | 'kismi' | 'dogrulanamadi'> {
    await this.client.closeMarket(
      this.cfg.symbol,
      pos.positionAmtRaw,
      `close-${Date.now()}`,
    );

    const after = await this.client
      .position(this.cfg.symbol)
      .catch(() => null);

    // KOSUL BILEREK "POZITIF DOGRULAMA" SEKLINDE:
    // Onceki hali `if (after && amt > 0) return;` idi. Okuma HATA verince
    // after null oluyor, kosul FALSE donuyor ve akis iptale dusuyordu —
    // yani pozisyonun kapandigini BILMEDEN stop ve hedef siliniyordu.
    // Bu, bir ust katmanda "okuyamadim ile koruma yok ayni sey degil" diye
    // duzelttigim hatanin bir kat asagida aynen tekrariydi.
    // Koruma yalnizca kapanma KESIN dogrulandiginda iptal edilir.
    if (!after) {
      this.log('  !! Kapatma sonrasi pozisyon OKUNAMADI — koruma emirlerine dokunulmuyor.');
      return 'dogrulanamadi';
    }

    if (Math.abs(after.positionAmt) > 0) {
      this.log(
        `  !! Kapatma sonrasi hala pozisyon var (${after.positionAmt}). ` +
          `Koruma emirleri IPTAL EDILMIYOR.`,
      );
      return 'kismi';
    }

    // YALNIZCA algo (koruma) emirleri iptal ediliyor.
    // Eskiden cancelAll da cagriliyordu; o, semboldeki TUM emirleri siler —
    // kullanicinin elle koydugu limit emirleri dahil.
    await this.client.cancelAllAlgo(this.cfg.symbol).catch(() => undefined);
    return 'kapandi';
  }

  /**
   * Sinyali isleme cevirir.
   *
   * Boyutlandirma riske gore: stop calisirsa bakiyenin riskPct'si gider.
   * Backtest'teki mantik birebir ayni — tutarlilik bilincli, yoksa canli
   * sonuclar backtest ile karsilastirilamaz.
   */
  /**
   * @param availableUsdt Marj olarak bloke OLMAYAN nakit. Yalnizca
   *   "bu emrin marjini karsilayabiliyor muyuz" sorusu icin.
   * @param equityUsdt Hesabin GERCEK degeri (walletBalance + gerceklesmemis
   *   kar/zarar). Pozisyon boyutu BUNDAN hesaplanir.
   *
   * IKISINI AYIRMAK SART. Onceki hali her ikisi icin de availableUsdt
   * kullaniyordu ve boyut, acilan her pozisyonun bloke ettigi marj yuzunden
   * kuculuyordu. Canlida olculdu: ayni tikte acilan 4 pozisyonun ilk ucu
   * ~49 USDT riskle acildi, dorduncusu 38.52 USDT ile — %21 kucuk, hicbir
   * stratejik sebep olmadan. Bu, "her islemde esit risk" ilkesini bozuyor;
   * tum istatistigimiz o ilkeye dayaniyor ve backtest tam %1 risk aliyor.
   *
   * Ayni hata daha once zarar sinirinda yakalanmisti (ping() availableBalance
   * donuyordu); boyutlandirma tarafi duzeltilmemisti.
   *
   * Varsayilan equityUsdt = availableUsdt: acik pozisyon yokken ikisi zaten
   * esittir, bu yuzden testler ve tek seferlik cagrilar bozulmaz.
   */
  async execute(
    signal: Signal,
    availableUsdt: number,
    equityUsdt: number = availableUsdt,
    /**
     * PORTFOY MARJ BUTCESI (USDT) — bu islemin kullanabilecegi azami marj.
     *
     * MAX_MARGIN_RATIO yalnizca ISLEM BASINA tavan. Dort es zamanli
     * pozisyonun her biri ozkaynagin %25'ini kullanabilseydi hesabin
     * TAMAMI kilitlenebilirdi: kullanilabilir nakit sifira duser, zaman
     * asimli cikis ya da acil kapatma icin manevra alani kalmaz, ve
     * borsanin marj cagrisina karsi tampon yok olur.
     *
     * Verilmezse sinirsiz (eski davranis) — testler ve tek seferlik
     * cagrilar bozulmasin diye.
     */
    marginBudgetUsdt: number = Infinity,
  ): Promise<ExecutionResult> {
    if (!this.filters) throw new Error('prepare() cagrilmadi');
    const f = this.filters;

    const mark = await this.client.markPrice(this.cfg.symbol);
    const stopDist = Math.abs(mark - signal.stopLoss);

    if (stopDist <= 0) {
      return { action: 'atlandi', detail: 'Stop mesafesi sifir.' };
    }

    // YON KONTROLU — canli calismada backtest'te olmayan bir risk.
    //
    // Sinyal mumun KAPANISINDAN uretiliyor, giris ise GUNCEL mark fiyatindan
    // oluyor. Arada fiyat sicradiysa stop girisin yanlis tarafina dusebilir:
    // LONG'da stop mark'in ustunde kalirsa pozisyon acilir acilmaz tetiklenir
    // ve islem daha baslamadan zararla kapanir. Backtest'te bu mumkun degildi
    // cunku orada giris ile sinyal ayni fiyat serisinden geliyordu.
    const long = signal.side === 'LONG';
    const ordered = long
      ? signal.stopLoss < mark && mark < signal.takeProfit
      : signal.takeProfit < mark && mark < signal.stopLoss;

    if (!ordered) {
      return {
        action: 'atlandi',
        detail:
          `Fiyat sinyalden bu yana kaydi: ${signal.side} icin siralama bozuk ` +
          `(stop ${signal.stopLoss.toFixed(4)}, mark ${mark.toFixed(4)}, ` +
          `hedef ${signal.takeProfit.toFixed(4)}). Islem acilmadi.`,
      };
    }

    // Fiyat hedefe cok yaklastiysa risk/odul bozulmustur; kovalamayalim.
    const reward = Math.abs(signal.takeProfit - mark);
    if (reward / stopDist < 1) {
      return {
        action: 'atlandi',
        detail:
          `Fiyat kaydi, kalan risk/odul 1:${(reward / stopDist).toFixed(2)} — ` +
          `giris artik kovalamaca olur.`,
      };
    }

    // --- core/risk.ts kapilari ---
    // Bu kontroller yazilmis ve test edilmisti ama CANLI YOLDA HIC
    // CAGRILMIYORDU: olu koddu. Backtest'te uygulanan kurallarin canlida
    // uygulanmamasi, test edilen sistemle calisan sistemin farkli olmasi
    // demek. Likidasyon kontrolu ozellikle onemli: stop likidasyonun
    // otesindeyse stop hic calismaz, pozisyon likide olur.
    const liq = checkStopVsLiquidation(mark, signal.stopLoss, this.cfg.leverage);
    if (!liq.ok) {
      return { action: 'atlandi', detail: liq.reason ?? 'Stop likidasyonun otesinde.' };
    }

    const rr = checkRiskReward(mark, signal.stopLoss, signal.takeProfit);
    if (!rr.ok) {
      return { action: 'atlandi', detail: rr.reason ?? 'Risk/odul yetersiz.' };
    }

    const riskUsdt = equityUsdt * (this.cfg.riskPct / 100);
    const riskQty = riskUsdt / stopDist;

    /**
     * MARJ TAVANI: REDDETME, KUCULT.
     *
     * Riske gore boyutlandirmada dar stop = buyuk miktar = buyuk marj:
     *   marj/bakiye = riskPct / (stopYuzdesi x kaldirac)
     * 3x ve %1 riskte, stop %1.33'un altindaysa marj bakiyenin %25'ini asar.
     * 5 dakikalik mumda 3 ATR cogu zaman bunun altinda kaliyor.
     *
     * Onceki hali islemi REDDEDIYORDU ve olculdu ki sinyallerin ~%87'sini
     * eliyordu — canli kosuda uretilen tek sinyal de tam buna takildi.
     * Bir guvenlik kapisinin isi islemleri engellemek degil, KUCULTMEKTIR:
     * miktar tavana gore kirpiliyor, gerceklesen risk planlanandan DUSUK
     * oluyor. Daha guvenli ve strateji calismaya devam ediyor.
     */
    // Islem basina tavan ILE portfoy butcesinin KUCUGU gecerli.
    const maxMarginUsdt = Math.min(
      equityUsdt * MAX_MARGIN_RATIO,
      marginBudgetUsdt,
    );
    const marginQty = (maxMarginUsdt * this.cfg.leverage) / mark;
    const cappedByMargin = marginQty < riskQty;
    const rawQty = Math.min(riskQty, marginQty);

    const qty = roundStep(rawQty, f.stepSize, f.quantityPrecision);
    const qtyNum = parseFloat(qty);

    if (cappedByMargin) {
      this.log(
        `  marj tavani: miktar ${riskQty.toFixed(4)} -> ${qty} ` +
          `(risk ${riskUsdt.toFixed(2)} -> ${(qtyNum * stopDist).toFixed(2)} USDT)`,
      );
    }

    // NaN her karsilastirmada false doner, yani asagidaki "< minQty"
    // kontrolunden SESSIZCE gecerdi ve borsaya "NaN" miktarli emir giderdi.
    if (!Number.isFinite(qtyNum)) {
      return { action: 'atlandi', detail: 'Miktar hesaplanamadi (NaN).' };
    }

    if (qtyNum < f.minQty || qtyNum <= 0) {
      return {
        action: 'atlandi',
        detail: `Hesaplanan miktar ${qty}, borsanin asgarisi ${f.minQty}. Bakiye yetersiz.`,
      };
    }

    const notional = qtyNum * mark;
    if (notional < f.minNotional) {
      return {
        action: 'atlandi',
        detail: `Emir buyuklugu ${notional.toFixed(2)} USDT, asgari ${f.minNotional} USDT.`,
      };
    }

    const margin = notional / this.cfg.leverage;
    // Bu kapi bilerek KULLANILABILIR nakde bakiyor: soru "hesap bu kadar
    // buyuk mu" degil, "bu emrin marjini SIMDI karsilayabiliyor muyuz".
    if (margin > availableUsdt) {
      return {
        action: 'atlandi',
        detail: `Gereken marj ${margin.toFixed(2)} USDT > kullanilabilir ${availableUsdt.toFixed(2)}.`,
      };
    }


    // Islem basina gercek risk: kaybedilen margin degil,
    // margin x kaldirac x stop yuzdesidir.
    const perTrade = checkRiskPerTrade(
      equityUsdt, margin, mark, signal.stopLoss, this.cfg.leverage,
      this.cfg.riskPct * 1.5, // yuvarlama paylari icin kucuk tolerans
    );
    if (!perTrade.ok) {
      return { action: 'atlandi', detail: perTrade.reason ?? 'Islem basi risk yuksek.' };
    }

    const side = signal.side === 'LONG' ? 'BUY' : 'SELL';
    const exitSide = signal.side === 'LONG' ? 'SELL' : 'BUY';
    const stopPrice = roundStep(signal.stopLoss, f.tickSize, f.pricePrecision);
    const tpPrice = roundStep(signal.takeProfit, f.tickSize, f.pricePrecision);

    const plan =
      `${signal.side} ${qty} ${this.cfg.symbol} @ ~${mark} | ` +
      `stop ${stopPrice} | hedef ${tpPrice} | ` +
      `marj ${margin.toFixed(2)} USDT | risk ${riskUsdt.toFixed(2)} USDT`;

    if (this.cfg.dryRun) {
      return { action: 'kuru-mod', detail: plan };
    }

    // --- Gercek emirler ---
    const stamp = Date.now();
    let entry;
    try {
      entry = await this.client.marketEntry(
        this.cfg.symbol,
        side,
        qty,
        `e-${stamp}`,
      );
    } catch (e: any) {
      // "Emir hata verdi" ILE "pozisyon acilmadi" AYNI SEY DEGIL.
      // Zaman asimi ya da baglanti kopmasi, emir borsaya ULASTIKTAN sonra
      // da olabilir: istemci hata gorur ama pozisyon acilmistir. Varsayimla
      // devam etmek, korumasiz bir pozisyonu gece boyu unutmak demekti.
      // Borsaya SORUYORUZ.
      this.log(`  giris emri hata verdi (${e?.message}) — borsa kontrol ediliyor`);
      const check = await this.client
        .position(this.cfg.symbol)
        .catch(() => null);

      if (!check) {
        return {
          action: 'hata',
          // Okuyamadik: pozisyon VAR SAYILIR. run.ts bunu kayda gecirip
          // tavanlara dahil eder, yoksa gorunmez bir maruziyet olurdu.
          positionOpen: 'bilinmiyor',
          detail:
            `Giris emri hata verdi VE pozisyon durumu okunamadi (${e?.message}). ` +
            `BINANCE PANELINDEN KONTROL ET.`,
        };
      }

      if (Math.abs(check.positionAmt) > 0) {
        this.log('  !! Emir aslinda ACILMIS — korumasiz pozisyon geri kapatiliyor');
        const undo = await this.closeNow(check).catch(() => 'dogrulanamadi' as const);
        if (undo === 'kapandi') {
          return {
            action: 'hata',
            detail: `Giris emri hata verdi ama pozisyon acilmisti; geri kapatildi.`,
          };
        }
        return {
          action: 'hata',
          positionOpen: 'evet',
          openQty: Math.abs(check.positionAmt),
          openEntryPrice: check.entryPrice,
          openSide: check.positionAmt > 0 ? 'LONG' : 'SHORT',
          detail:
            `!!! KRITIK: giris emri hata verdi, pozisyon ACIK ve kapatilamadi ` +
            `(${undo}). BINANCE PANELINDEN ELLE KAPAT.`,
        };
      }

      return { action: 'hata', detail: `Giris emri basarisiz: ${e?.message}` };
    }

    /**
     * GERCEK DOLUM FIYATINI BORSADAN OKU — emrin cevabindan DEGIL.
     *
     * marketEntry, /fapi/v1/order'a `newOrderRespType` gondermiyordu ve
     * Binance USD-M'de varsayilan **ACK**'tir: o cevapta `avgPrice` HER ZAMAN
     * "0" gelir. Sonra asagidaki `entry.avgPrice || mark` ifadesi sessizce
     * MARK fiyatina dusuyordu.
     *
     * Yani kaydedilen "giris fiyati" dolum degil, KARAR ANINDAKI MARK idi.
     * run.log'daki 18 girisin 18'inde de "giris doldu @ X" degeri, ayni
     * islemin plan satirindaki "@ ~mark" ile ondalik ondalik AYNI — kanit
     * kosunun kendi kaydinda duruyor.
     *
     * Bedeli dogrudan para degil, OLCUM: kayma (slippage) gorunmez oluyor.
     * Botun tum varlik sebebi olcum yapmak ve DEFAULT_CONFIG'de varsayilan
     * slippagePct=0.02 tam da olculemeyen kalem. 'GERCEKLESEN risk', R
     * katsayisi muhasebesi ve `npm run tracking` hep bu sayinin ustune kurulu.
     *
     * Depoda DOGRU desen zaten vardi — run.ts'teki kurtarma yolu miktari ve
     * giris fiyatini BORSADAN okuyor. Ayni deseni normal giris yoluna da
     * uyguluyoruz. Okuma basarisizsa emrin avgPrice'ina, o da yoksa mark'a
     * duseriz; ama artik hangi kaynagi kullandigimizi BILIYORUZ.
     */
    const dolum = await this.client
      .position(this.cfg.symbol)
      .catch(() => null);
    const borsaGirisi =
      dolum && Math.abs(dolum.positionAmt) > 0 && dolum.entryPrice > 0
        ? dolum.entryPrice
        : NaN;
    const filledPrice = Number.isFinite(borsaGirisi)
      ? borsaGirisi
      : entry.avgPrice || mark;
    const fiyatKaynagi = Number.isFinite(borsaGirisi)
      ? 'borsa'
      : entry.avgPrice
        ? 'emir'
        : 'mark(TAHMIN)';
    // Gerceklesen miktar da borsadan; kismi dolumda emrin origQty'si yaniltir.
    const filledQty =
      dolum && Math.abs(dolum.positionAmt) > 0
        ? Math.abs(dolum.positionAmt)
        : qtyNum;
    const kayma = Number.isFinite(borsaGirisi)
      ? ((filledPrice - mark) / mark) * 100 * (signal.side === 'LONG' ? 1 : -1)
      : NaN;

    this.log(
      `  giris doldu: ${filledQty} @ ${filledPrice} (${fiyatKaynagi})` +
        (Number.isFinite(kayma) ? ` | kayma %${kayma.toFixed(4)}` : ''),
    );
    if (Math.abs(filledQty - qtyNum) > 1e-9) {
      this.log(
        `  !! KISMI/FARKLI DOLUM: istenen ${qtyNum}, gerceklesen ${filledQty} — ` +
          `koruma ve risk gerceklesen miktara gore`,
      );
    }

    // Koruma emirleri. Buradan sonrasi kritik: pozisyon ACIK ve korumasiz.
    try {
      const stop = await this.client.protectiveOrder(
        this.cfg.symbol,
        exitSide,
        'STOP_MARKET',
        stopPrice,
        `s-${stamp}`,
      );
      const tp = await this.client.protectiveOrder(
        this.cfg.symbol,
        exitSide,
        'TAKE_PROFIT_MARKET',
        tpPrice,
        `t-${stamp}`,
      );

      // Risk artik GERCEK dolum fiyati ve GERCEK miktar uzerinden.
      const realizedRisk = filledQty * Math.abs(filledPrice - parseFloat(stopPrice));

      return {
        action: 'girildi',
        detail:
          plan +
          (Math.abs(realizedRisk - riskUsdt) > 0.01
            ? ` | GERCEKLESEN risk ${realizedRisk.toFixed(2)} USDT (${fiyatKaynagi})`
            : ''),
        entryPrice: filledPrice,
        quantity: filledQty,
        riskUsdt: realizedRisk,
        stopOrderId: stop.orderId,
        tpOrderId: tp.orderId,
      };
    } catch (e: any) {
      // Koruma yazilamadi. Korumasiz pozisyon tasimak, islemi hic yapmamaktan
      // cok daha kotudur — geri al.
      this.log(`  !! Koruma emri basarisiz (${e?.message}) — pozisyon kapatiliyor`);
      try {
        const pos = await this.client.position(this.cfg.symbol);
        if (Math.abs(pos.positionAmt) === 0) {
          return {
            action: 'hata',
            detail: `Koruma yazilamadi; pozisyon zaten kapali: ${e?.message}`,
          };
        }
        // KAPATMANIN SONUCU OKUNMALI. Onceki hali closeNow'u cagirip sonucunu
        // atiyor ve KOSULSUZ "pozisyon geri kapatildi" diyordu — kapatma
        // basarisiz olsa bile. Yani log "kapatildi" derken borsada KORUMASIZ
        // bir pozisyon durabiliyordu. Ayni desen reconcile() ve giris-hatasi
        // dalinda duzeltilmisti; UC CAGRI YERINDEN IKISINE uygulanmis,
        // burasi atlanmisti.
        const undo = await this.closeNow(pos);
        if (undo === 'kapandi') {
          return {
            action: 'hata',
            detail: `Koruma yazilamadi, pozisyon geri kapatildi: ${e?.message}`,
          };
        }
        return {
          action: 'hata',
          positionOpen: 'evet',
          openQty: Math.abs(pos.positionAmt),
          openEntryPrice: pos.entryPrice,
          openSide: pos.positionAmt > 0 ? 'LONG' : 'SHORT',
          detail:
            `!!! KRITIK: koruma yazilamadi VE geri kapatma dogrulanmadi ` +
            `(${undo}). Pozisyon KORUMASIZ olabilir. ` +
            `BINANCE PANELINDEN KONTROL ET. ${e?.message}`,
        };
      } catch (e2: any) {
        return {
          action: 'hata',
          // Giris emri BASARILI donmustu, yani pozisyon acildi; buradaki
          // hata onu kapatma denemesinde olustu. Var saymak tek dogru cevap.
          positionOpen: 'evet',
          openQty: filledQty,
          openEntryPrice: filledPrice,
          openSide: signal.side,
          detail:
            `!!! KRITIK: koruma yazilamadi VE pozisyon kapatilamadi. ` +
            `BINANCE PANELINDEN ELLE KAPAT. ${e2?.message}`,
        };
      }
    }
  }
}
