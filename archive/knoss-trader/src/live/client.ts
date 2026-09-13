import axios from 'axios';
import * as crypto from 'crypto';

/**
 * Binance Futures REST istemcisi (testnet / canli).
 *
 * Tarayici otomasyonu yerine resmi API kullanilmasinin sebebi tek cumlede:
 * emrin gercekten acilip acilmadigini KESIN bilmek. Tarayicida bir tiklama
 * bosa gidebilir ve bunu anlamanin guvenilir yolu yoktur; API'de her emrin
 * kimligi, durumu ve dolum fiyati doner.
 */

export interface ClientConfig {
  apiKey: string;
  apiSecret: string;
  /** true = testnet.binancefuture.com (sahte para). */
  testnet: boolean;
}

export interface SymbolFilters {
  symbol: string;
  /** Miktar adimi — buna uymayan emir REDDEDILIR. */
  stepSize: number;
  /** Fiyat adimi. */
  tickSize: number;
  minQty: number;
  /** Asgari emir buyuklugu (USDT). */
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
}

export interface PlacedOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  avgPrice: number;
  origQty: number;
}

export interface Position {
  symbol: string;
  /** Pozitif = long, negatif = short, 0 = pozisyon yok. */
  positionAmt: number;
  /** Borsanin ham metni. Kapatirken BU kullanilmali — yeniden
   *  yuvarlamak pozisyonun bir adimlik kismini acik birakiyordu. */
  positionAmtRaw: string;
  entryPrice: number;
  unrealizedProfit: number;
  leverage: number;
}

export class BinanceFuturesClient {
  private readonly base: string;

  constructor(private readonly cfg: ClientConfig) {
    this.base = cfg.testnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';
  }

  get isTestnet(): boolean {
    return this.cfg.testnet;
  }

  /**
   * Imzali istek.
   *
   * Binance query string'in HMAC-SHA256 imzasini istiyor. Imza SON parametre
   * olmali; araya baska parametre girerse imza gecersiz olur.
   */
  private async signed<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    const withTime = {
      ...params,
      timestamp: Date.now(),
      // Ag gecikmesi payi. Cok kucuk olursa gecerli emir "zaman asimi"
      // diye reddedilir.
      recvWindow: 10000,
    };

    const query = Object.entries(withTime)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');

    const signature = crypto
      .createHmac('sha256', this.cfg.apiSecret)
      .update(query)
      .digest('hex');

    const url = `${this.base}${path}?${query}&signature=${signature}`;

    try {
      const resp = await axios.request<T>({
        method,
        url,
        headers: { 'X-MBX-APIKEY': this.cfg.apiKey },
        timeout: 20000,
      });
      return resp.data;
    } catch (e: any) {
      // Binance hatalari {code, msg} seklinde gelir ve gercek sebebi
      // soyler; axios'un genel mesaji ise soylemez.
      const d = e?.response?.data;
      if (d?.msg) {
        throw new Error(`Binance ${d.code}: ${d.msg}`);
      }
      throw e;
    }
  }

  private async publicGet<T>(path: string, params: Record<string, any> = {}): Promise<T> {
    const resp = await axios.get<T>(`${this.base}${path}`, {
      params,
      timeout: 20000,
    });
    return resp.data;
  }

  /**
   * Hesap ozeti.
   *
   * IKI AYRI BAKIYE DONUYOR ve karistirmak pahaliya patliyor:
   *
   *  balanceUsdt (availableBalance) = emir acmak icin kullanilabilir NAKIT.
   *    Pozisyon acilinca izole marj bundan DUSULUR. "Yeni emre param yetiyor
   *    mu" sorusunun cevabi budur.
   *
   *  equityUsdt (walletBalance + gerceklesmemis kar/zarar) = hesabin GERCEK
   *    degeri. Marj kilitlense bile degismez.
   *
   * Zarar sinirinin availableBalance ile olculmesi kritik bir hataydi:
   * pozisyon acilinca marj kilitleniyor, kullanilabilir bakiye dusuyor ve
   * bot bunu ZARAR saniyordu. Olculdu: iki es zamanli pozisyon kullanilabilir
   * bakiyeyi ~%21 dusuruyor — hic para kaybedilmeden %15'lik zarar siniri
   * tetikleniyor ve bot kendini kapatiyordu. Acik pozisyonlar borsadaki
   * stopa emanet kaliyor, zaman asimli cikis bir daha hic calismiyordu.
   */
  async ping(): Promise<{
    ok: boolean;
    balanceUsdt: number;
    equityUsdt: number;
    canTrade: boolean;
  }> {
    const acc = await this.signed<any>('GET', '/fapi/v2/account');
    return parseAccount(acc);
  }

  /**
   * Sembol filtreleri. Bunlar olmadan emir gonderilmemeli: miktar adimina
   * uymayan bir emir borsada reddedilir ve bot "emir gitti" sanip
   * korumasiz kalabilir.
   */
  async symbolFilters(symbol: string): Promise<SymbolFilters> {
    const info = await this.publicGet<any>('/fapi/v1/exchangeInfo');
    const s = (info.symbols ?? []).find((x: any) => x.symbol === symbol);
    if (!s) throw new Error(`${symbol} bu borsada listeli degil`);

    const f = (t: string) => (s.filters ?? []).find((x: any) => x.filterType === t);
    const lot = f('LOT_SIZE');
    const price = f('PRICE_FILTER');
    const notional = f('MIN_NOTIONAL');

    return {
      symbol,
      stepSize: parseFloat(lot?.stepSize ?? '0.001'),
      tickSize: parseFloat(price?.tickSize ?? '0.01'),
      minQty: parseFloat(lot?.minQty ?? '0'),
      minNotional: parseFloat(notional?.notional ?? '5'),
      quantityPrecision: s.quantityPrecision ?? 3,
      pricePrecision: s.pricePrecision ?? 2,
    };
  }

  async markPrice(symbol: string): Promise<number> {
    const d = await this.publicGet<any>('/fapi/v1/premiumIndex', { symbol });
    return parseFloat(d.markPrice);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signed('POST', '/fapi/v1/leverage', { symbol, leverage });
  }

  /** ISOLATED marj — demir kural. Zaten ayarliysa Binance hata doner, yutuluyor. */
  async setIsolated(symbol: string): Promise<void> {
    try {
      await this.signed('POST', '/fapi/v1/marginType', {
        symbol,
        marginType: 'ISOLATED',
      });
    } catch (e: any) {
      // -4046: "No need to change margin type" — zaten ISOLATED.
      if (!String(e?.message).includes('-4046')) throw e;
    }
  }

  async position(symbol: string): Promise<Position> {
    const rows = await this.signed<any[]>('GET', '/fapi/v2/positionRisk', { symbol });
    const p = rows?.[0];
    return {
      symbol,
      positionAmt: parseFloat(p?.positionAmt ?? '0'),
      positionAmtRaw: String(p?.positionAmt ?? '0'),
      entryPrice: parseFloat(p?.entryPrice ?? '0'),
      unrealizedProfit: parseFloat(p?.unRealizedProfit ?? '0'),
      leverage: parseFloat(p?.leverage ?? '1'),
    };
  }

  async openOrders(symbol: string): Promise<any[]> {
    return this.signed<any[]>('GET', '/fapi/v1/openOrders', { symbol });
  }

  async cancelAll(symbol: string): Promise<void> {
    await this.signed('DELETE', '/fapi/v1/allOpenOrders', { symbol });
  }

  /**
   * Piyasa emriyle giris.
   *
   * clientOrderId veriliyor: ag hatasi sonrasi tekrar denenirse Binance ayni
   * kimlikli ikinci emri REDDEDER. Bu, "emir gitti mi gitmedi mi" belirsizligi
   * yuzunden cift pozisyon acilmasini engelleyen tek guvenilir mekanizma.
   */
  async marketEntry(
    symbol: string,
    side: 'BUY' | 'SELL',
    quantity: string,
    clientOrderId: string,
  ): Promise<PlacedOrder> {
    const o = await this.signed<any>('POST', '/fapi/v1/order', {
      symbol,
      side,
      type: 'MARKET',
      quantity,
      newClientOrderId: clientOrderId,
      /**
       * ACK DEGIL RESULT ISTIYORUZ.
       *
       * USD-M Futures'ta /fapi/v1/order icin varsayilan cevap tipi ACK'tir ve
       * ACK govdesinde `avgPrice` HER ZAMAN "0" gelir, `status` da "NEW".
       * Bu alan gonderilmedigi icin asagidaki `parseFloat(o.avgPrice)` her
       * seferinde 0 donuyordu ve cagiran taraf sessizce MARK fiyatina
       * dusuyordu — yani gercek dolum fiyati HIC okunmamis oluyordu.
       *
       * RESULT, dolan piyasa emri icin gercek `avgPrice` ve `executedQty`
       * tasir. Executor ayrica pozisyonu borsadan da okuyor (kesin kaynak);
       * bu, o okuma basarisiz olursa dusulecek dogru yedek.
       */
      newOrderRespType: 'RESULT',
    });
    return {
      orderId: o.orderId,
      clientOrderId: o.clientOrderId,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      status: o.status,
      avgPrice: parseFloat(o.avgPrice ?? '0'),
      origQty: parseFloat(o.origQty ?? '0'),
    };
  }

  /**
   * Pozisyonu kapatir — closePosition ile, MIKTAR VERMEDEN.
   *
   * Neden ayri bir metot: kapatma icin duz marketEntry kullanmak iki ayri
   * sekilde tehlikeliydi.
   *   1. reduceOnly/closePosition olmadan, pozisyon o sirada baska bir
   *      sebeple kapanmissa (stop tetiklendi, elle kapatildi, likidasyon)
   *      emir kapatmaz — TERS YONDE YENI VE KORUMASIZ bir pozisyon acar.
   *   2. Miktari yeniden yuvarlamak, pozisyonun bir adimlik kismini acik
   *      birakabiliyordu.
   * closePosition:'true' ikisini birden cozer: miktar gerekmez, artik
   * kalmaz, ve pozisyon yoksa borsa emri reddeder — yeni pozisyon acilmaz.
   */
  async closeMarket(
    symbol: string,
    /** Borsanin dondurdugu positionAmt — YENIDEN YUVARLANMADAN verilmeli. */
    positionAmt: string,
    clientOrderId: string,
  ): Promise<void> {
    const amt = parseFloat(positionAmt);
    await this.signed('POST', '/fapi/v1/order', {
      symbol,
      side: amt > 0 ? 'SELL' : 'BUY',
      type: 'MARKET',
      // Borsanin kendi verdigi miktar, oldugu gibi. Yeniden yuvarlamak
      // pozisyonun bir adimlik kismini acik birakiyordu.
      quantity: Math.abs(amt).toString(),
      // Tek satirlik ama en onemli parametre: bu emir pozisyonu yalnizca
      // AZALTABILIR. Pozisyon o sirada kapanmis olsa bile ters pozisyon
      // acamaz — borsa emri reddeder.
      reduceOnly: 'true',
      newClientOrderId: clientOrderId,
    });
  }

  /**
   * Koruma emri — BORSADA durur, botun hafizasinda degil.
   *
   * Bu ayrim hayati: bot cokerse, PC uyursa, internet giderse pozisyon
   * korumasiz kalmamali.
   *
   * DIKKAT — 9 ARALIK 2025 BINANCE DEGISIKLIGI:
   * Kosullu emirler (STOP_MARKET, TAKE_PROFIT_MARKET, STOP, TAKE_PROFIT,
   * TRAILING_STOP_MARKET) /fapi/v1/order ucundan ALINDI ve ayri bir Algo
   * servisine tasindi. Eski uc bu tipleri artik -4120 ile reddediyor.
   * Uc farkliliklari:
   *   /fapi/v1/order  ->  /fapi/v1/algoOrder
   *   stopPrice       ->  triggerPrice
   *   (yeni)          ->  algoType: 'CONDITIONAL'
   *   newClientOrderId->  clientAlgoId
   * Bu yuzden emirler mobil/web arayuzde calisirken API'de calismiyordu:
   * Binance kendi arayuzunu tasidi, eski API cagrileri geride kaldi.
   *
   * closePosition=true: pozisyonun tamamini kapatir, miktar gerekmez ve
   * pozisyon kapandiginda Binance emri kendisi iptal eder.
   */
  async protectiveOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
    triggerPrice: string,
    clientAlgoId: string,
  ): Promise<PlacedOrder> {
    const o = await this.signed<any>('POST', '/fapi/v1/algoOrder', {
      algoType: 'CONDITIONAL',
      symbol,
      side,
      type,
      triggerPrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE',
      clientAlgoId,
    });
    return {
      orderId: o.algoId,
      clientOrderId: o.clientAlgoId,
      symbol: o.symbol,
      side: o.side,
      type: o.orderType ?? type,
      status: o.algoStatus,
      avgPrice: 0,
      origQty: 0,
    };
  }

  /**
   * Gelir kaydi — GERCEKLESEN kar/zarar, komisyon ve fonlama.
   *
   * NEDEN GEREKLI: bakiye farkina bakmak yetmez, cunku o tek bir sayidir ve
   * "strateji ne kazandi" ile "komisyon ne goturdu" sorularini ayiramaz.
   * Bu uc, her kalemi ayri satir olarak verir:
   *   REALIZED_PNL  — pozisyonun kendi kar/zarari
   *   COMMISSION    — her emirde odenen komisyon (negatif)
   *   FUNDING_FEE   — 8 saatlik fonlama (pozitif ya da negatif)
   * Backtest bu uc kalemi ayri ayri modelliyor; ayni ayrimi canlida da
   * gorebilmek, olculen ile gerceklesen arasindaki farki bulmanin tek yolu.
   */
  async income(startTime: number, limit = 1000): Promise<any[]> {
    const r = await this.signed<any>('GET', '/fapi/v1/income', {
      startTime,
      limit,
    });
    return Array.isArray(r) ? r : [];
  }

  /** Acik koruma (algo) emirleri. Normal openOrders bunlari GOSTERMEZ. */
  async openAlgoOrders(symbol: string): Promise<any[]> {
    // Not: okuma ucu 'openAlgoOrders', silme ucu 'algoOpenOrders'.
    // Binance'in kendi isimlendirmesi tutarsiz; ikisi de dogrulandi.
    const r = await this.signed<any>('GET', '/fapi/v1/openAlgoOrders', { symbol });
    return Array.isArray(r) ? r : (r?.orders ?? []);
  }

  async cancelAlgoOrder(symbol: string, algoId: number): Promise<void> {
    await this.signed('DELETE', '/fapi/v1/algoOrder', { symbol, algoId });
  }

  async cancelAllAlgo(symbol: string): Promise<void> {
    await this.signed('DELETE', '/fapi/v1/algoOpenOrders', { symbol });
  }
}

/**
 * Miktari borsanin adimina yuvarlar. Adim disi emir reddedilir.
 *
 * EPSILON SART: duz Math.floor(value/step) kayan nokta hatasi yuzunden
 * borsanin KENDI bildirdigi gecerli miktarlari bir adim asagi dusuruyordu.
 * Olculdu: BTCUSDT (step 0.001) icin gecerli miktarlarin ~%9'u, SOLUSDT
 * (step 0.01) icin ~%11'i etkileniyordu — 0.043 -> 0.042 gibi.
 *
 * Pozisyon kapatirken bu, pozisyonun bir adimlik kismini ACIK birakip
 * ardindan tum koruma emirlerini silmek demekti: geriye stopsuz bir artik
 * kaliyordu. Ucuz paritelerde o artik asgari emir buyuklugunun altinda
 * kaldigi icin bir daha kapatilamiyor, bot her tikta hata alip duruyor ve
 * korumasiz pozisyon geride kaliyordu.
 */
/**
 * Hesap cevabini bakiye/ozkaynaga cevirir.
 *
 * NEDEN AYRI VE DISA ACIK: ping() ozel signed() uzerinden gectigi icin
 * test edilemiyordu, ve buradaki mantik bir kez sessizce botu
 * oldurmustu.
 *
 * ONCEKI HALI USDT SATIRI YOKSA SIFIR DONUYORDU:
 *   const wallet = parseFloat(usdt?.walletBalance ?? '0');
 * Cevap bozuksa ya da USDT satiri eksikse ozkaynak 0 cikiyordu. run.ts
 * bunu %100 ZARAR olarak okuyor ve "zarar siniri asildi" deyip botu
 * durduruyordu — bir okuma anomalisi yuzunden gece kosusu biter, acik
 * pozisyonlar borsadaki stoplarina emanet kalirdi.
 *
 * "Okuyamadim" ile "sifir" ayni sey degil. Artik FIRLATIYOR: run.ts'in
 * dis catch'i bunu hata sayar, geri cekilir ve tekrar dener; kalici
 * bir sorunsa MAX_ERRORS zaten devreye girer. Yani gecici bir bozuk
 * cevap botu oldurmez, kalici olan da fark edilmeden gecmez.
 */
export function parseAccount(acc: any): {
  ok: boolean;
  balanceUsdt: number;
  equityUsdt: number;
  canTrade: boolean;
} {
  const usdt = (acc?.assets ?? []).find((a: any) => a?.asset === 'USDT');
  if (!usdt) {
    throw new Error(
      'Hesap cevabinda USDT varligi yok — bakiye OKUNAMADI. ' +
        'Sifir varsaymak zarar sinirini tetikler.',
    );
  }
  const wallet = parseFloat(usdt.walletBalance);
  const available = parseFloat(usdt.availableBalance);
  if (!Number.isFinite(wallet) || !Number.isFinite(available)) {
    throw new Error(
      `Bakiye alanlari sayiya cevrilemedi (walletBalance=${usdt.walletBalance}, ` +
        `availableBalance=${usdt.availableBalance}).`,
    );
  }
  // Gerceklesmemis kar/zarar okunamazsa 0 saymak GUVENLI: ozkaynagi
  // cuzdan bakiyesine esitler, yani pozisyonlarin kagit karini yok
  // sayar. Aleyhte varsayim.
  const upnl = parseFloat(usdt.unrealizedProfit);
  return {
    ok: true,
    balanceUsdt: available,
    equityUsdt: wallet + (Number.isFinite(upnl) ? upnl : 0),
    canTrade: Boolean(acc?.canTrade),
  };
}

export function roundStep(value: number, step: number, precision: number): string {
  if (step <= 0) return value.toFixed(precision);
  const rounded = Math.floor(value / step + 1e-9) * step;
  return rounded.toFixed(precision);
}
