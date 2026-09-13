import { Bar } from '../data/types';

export type Side = 'LONG' | 'SHORT';

/** Stratejinin urettigi giris fikri. Fiyatlar mutlak, yuzde degil. */
export interface Signal {
  side: Side;
  stopLoss: number;
  takeProfit: number;
  /** Insan okuyacak gerekce — log ve rapor icin. */
  reason: string;
}

export interface Strategy {
  name: string;
  /**
   * Sinyal uretmeden once kac kapali mum gerekiyor.
   * Motor bu sayidan once onBar cagirmaz; yoksa yarim hesaplanmis
   * gostergelerle sahte islemler uretilir.
   */
  warmup: number;
  /**
   * i. mumun KAPANISINDA cagrilir ve yalnizca bars[0..i]'yi gorur.
   * Gelecege bakma buradan sizar; motor diziyi kirpmiyor, sozlesme bu.
   */
  onBar(bars: Bar[], i: number): Signal | null;
}

export interface BacktestConfig {
  /** Baslangic bakiyesi (USDT). */
  startBalance: number;
  /** Islem basina riske atilan bakiye yuzdesi. */
  riskPct: number;
  /** Kaldirac. Boyutlandirmayi degil, likidasyon mesafesini etkiler. */
  leverage: number;
  /** Tek yon komisyon (%). Binance Futures taker = 0.05. */
  feePct: number;
  /** Emir basina kayma (%). Piyasa emri gercekte tam fiyattan dolmaz. */
  slippagePct: number;
  /** 8 saatlik fonlama orani (%). Pozitif = long oder. */
  fundingPct: number;
  /** Ayni anda birden fazla pozisyon yok; kucuk hesap gercekligi. */
  maxBarsInTrade: number;
  /**
   * Cikis kurali. Verilmezse 'sabit' — yani onceki davranis birebir korunur.
   *
   * NEDEN AYRI BIR EKSEN: 12 strateji test edildi ve hepsinde GIRIS kurali
   * degistirildi; CIKIS kurali hep ayni kaldi (sabit stop, sabit hedef,
   * hangisi once gelirse). Stop mesafesi ve R:R oraninin DEGERLERI
   * degistirildi ama MEKANIZMA hic degistirilmedi. Bu, hic bakilmamis bir
   * boyut.
   */
  exit?: ExitRule;
}

/**
 * Cikis mekanizmasi.
 *
 * DIKKAT — BU AILE BACKTEST'I KOLAYCA YALANCI YAPAR. Mum icindeki fiyat
 * YOLU bilinmez: bir mumun hem tetik seviyesine hem cikis seviyesine
 * degdigini gorursek hangisinin once oldugunu SOYLEYEMEYIZ. Iyimser
 * varsaymak, gercekte olmayan bir kar uretir.
 *
 * Motorun cozumu: TETIKLENME yalnizca KAPANMIS onceki mumlardan sayilir.
 * Yani bir mumda tetiklenip ayni mumda cikmak mumkun degil; cikis en erken
 * SONRAKI mumda olur. Bu bir gecikme uretir ve stratejiyi bir miktar kotu
 * gosterir — motorun geri kalaninda oldugu gibi, aleyhte varsayim.
 */
export type ExitRule =
  | { kind: 'sabit' }
  | {
      /**
       * Basabas: fiyat hedefe dogru `activateAtPct` kadar gidince stop
       * GIRISE cekilir. Kaybi sifirlamaz — komisyon ve kayma kalir.
       */
      kind: 'basabas';
      activateAtPct: number;
    }
  | {
      /**
       * Geri cekilme: fiyat hedefin `activateAtPct` kadarina ulastiktan
       * SONRA `exitAtPct` seviyesine geri cekilirse orada cikilir.
       * Kullanicinin tarif ettigi kural: "%60'a geldi, %50'ye donerse sat."
       */
      kind: 'geri-cekilme';
      activateAtPct: number;
      exitAtPct: number;
    };

export const DEFAULT_CONFIG: BacktestConfig = {
  startBalance: 1000,
  riskPct: 1,
  leverage: 5,
  // Taker/taker varsayiyoruz: piyasa emriyle girip piyasa emriyle cikmak
  // en kotu ama en gercekci senaryo. Maker olsaydi 0.02 olurdu.
  feePct: 0.05,
  slippagePct: 0.02,
  fundingPct: 0.01,
  maxBarsInTrade: 200,
  // Varsayilan, onceki davranisin birebir aynisi.
  exit: { kind: 'sabit' },
};

export interface Trade {
  side: Side;
  reason: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  /**
   * Sinyalin stop ve hedef seviyeleri.
   *
   * Kaydediliyor cunku olcum duzenegi bunlari geriye donuk cikarmak
   * zorunda kaliyordu: yazi-tura kontrol grubunun stratejininkiyle AYNI
   * stop/hedef yapisinda kosmasi sart, aksi halde karsilastirma beceriyi
   * degil stop geometrisini olcer.
   */
  stopLoss: number;
  takeProfit: number;
  /** Cikisi ne tetikledi. */
  exitReason: 'tp' | 'sl' | 'timeout' | 'basabas' | 'geri-cekilme';
  qty: number;
  margin: number;
  /** Komisyon ve fonlama dahil net kar/zarar (USDT). */
  pnl: number;
  fees: number;
  funding: number;
  /** Risk katsayisi: pnl / baslangicta riske atilan tutar. */
  r: number;
  balanceAfter: number;
  barsHeld: number;
}

export interface BacktestResult {
  strategy: string;
  symbol: string;
  interval: string;
  from: number;
  to: number;
  bars: number;
  trades: Trade[];
  startBalance: number;
  endBalance: number;
  /** Toplam getiri (%). */
  returnPct: number;
  wins: number;
  losses: number;
  winRatePct: number;
  /** Islem basina ortalama R — asil onemli sayi. */
  expectancyR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownPct: number;
  totalFees: number;
  totalFunding: number;
}
