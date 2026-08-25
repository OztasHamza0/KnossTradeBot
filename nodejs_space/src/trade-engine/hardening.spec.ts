import {
  TradeEngineService,
  TradeSignal,
  ASSUMED_BALANCE_USDT,
  MAX_RISK_PCT_PER_TRADE,
} from './trade-engine.service';

/**
 * Denetim sonrasi kapatilan aciklarin regresyon testleri.
 *
 * Her blok, kodda GERCEKTEN yasanmis bir "tek tek gecerli, birlikte
 * calismaz" durumunu tarif ediyor.
 */

const engine = () =>
  new TradeEngineService(
    { get: () => undefined } as any,
    {} as any,
    {} as any,
  ) as any;

const signal = (over: Partial<TradeSignal> = {}): TradeSignal => ({
  pair: 'BTCUSDT',
  direction: 'LONG',
  leverage: '5x',
  margin: '20 USDT',
  entry: '100',
  stopLoss: '97',
  takeProfit: '106',
  potentialGain: '+3 USDT',
  confidence: 8,
  reason: 'test',
  ...over,
});

describe('validateSignal — margin artik zorunlu', () => {
  it('okunamayan margin karti dusurur', () => {
    // Eskiden sessizce atlaniyordu: tek boyutlandirma kuralini devre disi
    // birakmanin yolu margin alanini bosaltmakti.
    const r = engine().validateSignal(signal({ margin: '' }), undefined, 100);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Margin okunamadı');
  });

  it('sifir margin de gecersiz', () => {
    const r = engine().validateSignal(
      signal({ margin: '0 USDT' }),
      undefined,
      100,
    );
    expect(r.valid).toBe(false);
  });
});

describe('validateSignal — bakiye bilinmiyorken de boyutlandirma denetlenir', () => {
  it(`bakiye null iken varsayilan ${ASSUMED_BALANCE_USDT} USDT uzerinden tavan uygular`, () => {
    // Eskiden balance null olunca kill switch ILE margin tavani ayni if
    // blogunda atlaniyordu; yani bakiyesini hic yazmamis kullanici icin
    // boyutlandirma denetimi tamamen kapaliydi.
    const r = engine().validateSignal(
      signal({ margin: '80 USDT' }),
      undefined,
      null,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('aşıyor');
    expect(r.reason).toContain('varsayıldı');
  });

  it('varsayilan tavanin altindaki margini gecirir', () => {
    const r = engine().validateSignal(
      signal({ margin: '20 USDT' }),
      undefined,
      null,
    );
    expect(r.valid).toBe(true);
  });

  it('kill switch yalnizca gercekten bilinen bakiye icin calisir', () => {
    // Bilinmeyen bakiyeyi "dusuk" sayip her seyi reddetmek botu kilitlerdi.
    expect(engine().validateSignal(signal(), undefined, null).valid).toBe(true);
    expect(engine().validateSignal(signal(), undefined, 10).valid).toBe(false);
  });
});

describe('validateSignal — islem basina risk', () => {
  it(`bakiyenin %${MAX_RISK_PCT_PER_TRADE}'undan fazlasini riske atan karti reddeder`, () => {
    // margin 40, 10x, stop %8 uzakta -> 40 x 10 x 0.08 = 32 USDT = %32.
    // Yon dogru, kaldirac 10 (sinirda), margin tavanin altinda.
    const r = engine().validateSignal(
      signal({ leverage: '10x', margin: '40 USDT', stopLoss: '92' }),
      undefined,
      100,
    );
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/kaybettirir|likide|Risk\/ödül/);
  });

  it('ayni stop mesafesinde kucuk margin gecer', () => {
    const r = engine().validateSignal(
      signal({ leverage: '3x', margin: '10 USDT', stopLoss: '97' }),
      undefined,
      100,
    );
    expect(r.valid).toBe(true);
  });
});

describe('parseReview — verdict harfe duyarli olmamali', () => {
  const fenced = (json: string) => '```json ' + json + ' ```';

  it('"REJECT" onaya donusmez', () => {
    // Tam esitlik (p.verdict === "reject") reddi sessizce ONAYA cevirmenin
    // en kolay yoluydu.
    const r = engine().parseReview(
      fenced('{"verdict":"REJECT","comment":"cok riskli"}'),
      signal(),
    );
    expect(r.verdict).toBe('reject');
    expect(r.signal).toBeNull();
  });

  it('"Reject " (bosluklu, buyuk harfli) de reddir', () => {
    const r = engine().parseReview(
      fenced('{"verdict":"Reject ","comment":"hayir"}'),
      signal(),
    );
    expect(r.verdict).toBe('reject');
  });

  it('Turkce verdict de anlasilir', () => {
    expect(
      engine().parseReview(fenced('{"verdict":"reddet"}'), signal()).verdict,
    ).toBe('reject');
    expect(
      engine().parseReview(fenced('{"verdict":"REVIZE"}'), signal()).verdict,
    ).toBe('revise');
    expect(
      engine().parseReview(fenced('{"verdict":"Onayla"}'), signal()).verdict,
    ).toBe('approve');
  });

  it('taninmayan verdict + ret dili = ret', () => {
    const r = engine().parseReview(
      fenced('{"verdict":"hmm","comment":"Bu işlemi REDDEDİYORUM"}'),
      signal(),
    );
    expect(r.verdict).toBe('reject');
  });

  it('taninmayan verdict + notr metin = onay (denetci guvenlik kapisi degil)', () => {
    const r = engine().parseReview(
      fenced('{"verdict":"hmm","comment":"idare eder"}'),
      signal(),
    );
    expect(r.verdict).toBe('approve');
    expect(r.signal).not.toBeNull();
  });

  it('buyuk harfli Turkce ret, JSON hic yokken de yakalanir', () => {
    // normalizeTr duzeltilmeden once "REDDEDİYORUM" birlesik nokta yuzunden
    // regexe takilmiyor ve kart ONAY olarak geciyordu.
    const r = engine().parseReview(
      'Bu İŞLEMİ REDDEDİYORUM, çok riskli.',
      signal(),
    );
    expect(r.verdict).toBe('reject');
  });
});

describe('exposureBlock — toplam maruziyet', () => {
  const withOpen = (rows: any[]) =>
    new TradeEngineService(
      { get: () => undefined } as any,
      { sent_signals: { findMany: async () => rows } } as any,
      {} as any,
    );

  it('acik kart yokken engellemez', async () => {
    const r = await withOpen([]).exposureBlock('1', signal(), 100);
    expect(r).toBeNull();
  });

  it('acik kartlarla birlikte tavani asinca engeller', async () => {
    // 40 bagli + 20 yeni = 60 > 50 (bakiye 100'un %50'si)
    const r = await withOpen([
      { margin_usdt: 40, pair: 'ETHUSDT' },
    ]).exposureBlock('1', signal({ margin: '20 USDT' }), 100);
    expect(r).toContain('ETHUSDT');
    expect(r).toContain('aşar');
  });

  it('tavanin altinda kalinca gecer', async () => {
    const r = await withOpen([
      { margin_usdt: 20, pair: 'ETHUSDT' },
    ]).exposureBlock('1', signal({ margin: '20 USDT' }), 100);
    expect(r).toBeNull();
  });

  it('bakiye bilinmiyorsa varsayilan bakiye uzerinden olcer', async () => {
    const r = await withOpen([
      { margin_usdt: 45, pair: 'ETHUSDT' },
    ]).exposureBlock('1', signal({ margin: '20 USDT' }), null);
    expect(r).toContain('aşar');
  });

  it('margin kaydi olmayan eski kayitlari 0 sayar', async () => {
    const r = await withOpen([
      { margin_usdt: null, pair: 'ETHUSDT' },
    ]).exposureBlock('1', signal({ margin: '20 USDT' }), 100);
    expect(r).toBeNull();
  });
});

describe('reviewSignal — varsayilan kurulumda da calisir', () => {
  const withEnv = (env: Record<string, string>) => {
    const e = new TradeEngineService(
      { get: (k: string) => env[k] } as any,
      {} as any,
      { getCoinAnalysis: () => Promise.resolve(null) } as any,
    ) as any;
    return e;
  };

  const market: any = {
    top50: [],
    tradablePairs: [],
    fearGreed: null,
    btc: null,
  };

  it('ayri nobet modeli tanimli olmasa bile denetim kosar', async () => {
    // Regresyon: eskiden watchModel === model oldugunda denetim tamamen
    // atlaniyordu ve render.yaml LLM_MODEL_WATCH tanimlamadigi icin bu
    // "standart deploy" demekti — ilan edilen katman hic calismiyordu.
    let called = false;
    const e = withEnv({ LLM_MODEL: 'ayni' });
    e.callLLM = () => {
      called = true;
      return Promise.resolve(
        '```json {"verdict":"reject","comment":"olmaz"} ```',
      );
    };

    const r = await e.reviewSignal(signal(), market, [], 100);
    expect(called).toBe(true);
    expect(r.verdict).toBe('reject');
  });

  it('denetci cagrisi patlarsa kart ilk haliyle gecer', async () => {
    // Denetci bir KALITE kapisi, guvenlik kapisi degil — validateSignal
    // arkada duruyor. Saglayici arizasinda her sinyali yutmak daha kotu.
    const e = withEnv({ LLM_MODEL: 'ayni' });
    e.callLLM = () => Promise.reject(new Error('saglayici coktu'));

    const r = await e.reviewSignal(signal(), market, [], 100);
    expect(r.verdict).toBe('approve');
    expect(r.signal).not.toBeNull();
    expect(r.comment).toContain('yapılamadı');
  });
});
