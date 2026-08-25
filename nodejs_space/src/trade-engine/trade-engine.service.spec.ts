import { TradeEngineService, TradeSignal } from './trade-engine.service';
import { MarketOverview } from '../market-data/market-data.service';

const stubConfig: any = { get: () => undefined };
const stubPrisma: any = {};
const stubMarket: any = {};

const baseSignal = (over: Partial<TradeSignal> = {}): TradeSignal => ({
  pair: 'BTCUSDT',
  direction: 'LONG',
  leverage: '5x',
  margin: '20 USDT',
  entry: '67450',
  stopLoss: '66200',
  takeProfit: '69500',
  potentialGain: '+15 USDT',
  confidence: 8,
  reason: 'test',
  ...over,
});

/**
 * Fikstur fiyatlari gercekci olmali: giris/piyasa sapma kontrolu eklendikten
 * sonra "fiyat 1, giris 67450" diyen bir fikstur hakli olarak reddediliyor.
 */
const PRICES: Record<string, number> = {
  BTCUSDT: 67450,
  ETHUSDT: 3200,
  SOLUSDT: 150,
  '1000PEPEUSDT': 0.000004,
};

const binanceMarket = (pairs: string[]): MarketOverview => ({
  btc: null,
  eth: null,
  sol: null,
  top50: pairs.map((pair) => ({
    symbol: pair.replace('USDT', ''),
    pair,
    name: pair,
    current_price: PRICES[pair] ?? 1,
    price_change_percentage_24h: 0,
    price_change_percentage_1h: 0,
    total_volume: 1,
    onFutures: true,
  })),
  fearGreed: null,
  fetchedAt: 0,
  source: 'binance',
  tradablePairs: pairs,
  warnings: [],
});

describe('TradeEngineService', () => {
  let service: TradeEngineService;

  beforeEach(() => {
    service = new TradeEngineService(stubConfig, stubPrisma, stubMarket);
  });

  describe('validateSignal — stop-loss direction', () => {
    it('accepts a correctly ordered LONG', () => {
      expect(service.validateSignal(baseSignal()).valid).toBe(true);
    });

    it('accepts a correctly ordered SHORT', () => {
      const signal = baseSignal({
        direction: 'SHORT',
        entry: '67450',
        stopLoss: '68800',
        takeProfit: '65000',
      });
      expect(service.validateSignal(signal).valid).toBe(true);
    });

    it('rejects a LONG whose stop-loss sits above entry', () => {
      const signal = baseSignal({ stopLoss: '68000' });
      const result = service.validateSignal(signal);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('LONG');
    });

    it('rejects a LONG whose take-profit sits below entry', () => {
      expect(
        service.validateSignal(baseSignal({ takeProfit: '66000' })).valid,
      ).toBe(false);
    });

    it('rejects a SHORT whose stop-loss sits below entry', () => {
      const signal = baseSignal({
        direction: 'SHORT',
        stopLoss: '66000',
        takeProfit: '65000',
      });
      expect(service.validateSignal(signal).valid).toBe(false);
    });
  });

  describe('validateSignal — hard rules', () => {
    it('rejects a missing stop-loss', () => {
      expect(service.validateSignal(baseSignal({ stopLoss: '' })).valid).toBe(
        false,
      );
    });

    it('rejects a missing take-profit', () => {
      expect(service.validateSignal(baseSignal({ takeProfit: '' })).valid).toBe(
        false,
      );
    });

    it('rejects leverage above 10x', () => {
      const result = service.validateSignal(baseSignal({ leverage: '20x' }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('20');
    });

    it('accepts leverage at the 10x boundary', () => {
      expect(
        service.validateSignal(baseSignal({ leverage: '10x' })).valid,
      ).toBe(true);
    });

    it('rejects a direction that is neither LONG nor SHORT', () => {
      expect(
        service.validateSignal(baseSignal({ direction: 'MAYBE' })).valid,
      ).toBe(false);
    });

    it('rejects margin above 50% of balance', () => {
      const result = service.validateSignal(
        baseSignal({ margin: '60 USDT' }),
        undefined,
        100,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Margin');
    });

    it('accepts margin at exactly 50% of balance', () => {
      expect(
        service.validateSignal(
          baseSignal({ margin: '50 USDT' }),
          undefined,
          100,
        ).valid,
      ).toBe(true);
    });

    it('rejects every signal when balance is below the kill switch', () => {
      expect(service.validateSignal(baseSignal(), undefined, 40).valid).toBe(
        false,
      );
    });

    it('rejects a pair absent from the Binance Futures list', () => {
      const market = binanceMarket(['ETHUSDT', 'SOLUSDT']);
      const result = service.validateSignal(
        baseSignal({ pair: 'BTCUSDT' }),
        market,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('BTCUSDT');
    });

    it('accepts a pair present in the Binance Futures list', () => {
      const market = binanceMarket(['BTCUSDT', 'ETHUSDT']);
      expect(service.validateSignal(baseSignal(), market).valid).toBe(true);
    });

    // Arastirma modu top 50 disindaki coinlere de bakabiliyor; kabul olcutu
    // hacim sirasi degil, Binance Futures'ta listeleniyor olmak.
    it('accepts a tradable pair that is outside the top 50 by volume', () => {
      const market = binanceMarket(['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT']);
      market.top50 = market.top50.slice(0, 2); // 1000PEPE hacim listesinde yok
      const signal = baseSignal({
        pair: '1000PEPEUSDT',
        entry: '0.0000040',
        stopLoss: '0.0000036',
        takeProfit: '0.0000048',
      });
      expect(service.validateSignal(signal, market).valid).toBe(true);
    });
  });

  describe('parseNum', () => {
    it.each([
      ['67,450.5', 67450.5],
      ['$67450', 67450],
      ['20 USDT', 20],
      ['0.00001234', 0.00001234],
    ])('parses %s', (input, expected) => {
      expect(service.parseNum(input)).toBeCloseTo(expected, 10);
    });
  });

  describe('parseResponse', () => {
    it('extracts a fenced JSON signal and strips it from the text', () => {
      const raw =
        'Fırsat var!\n```json\n{"signal": true, "pair": "BTCUSDT", "direction": "LONG"}\n```';
      const parsed = service.parseResponse(raw);
      expect(parsed.signal?.pair).toBe('BTCUSDT');
      expect(parsed.text).toBe('Fırsat var!');
    });

    it('extracts a bare JSON object when the model omits the fence', () => {
      const raw =
        'Bak şuna: {"signal": true, "pair": "ETHUSDT", "direction": "SHORT"}';
      expect(service.parseResponse(raw).signal?.pair).toBe('ETHUSDT');
    });

    it('returns no signal for {"signal": false}', () => {
      const parsed = service.parseResponse('```json\n{"signal": false}\n```');
      expect(parsed.signal).toBeNull();
      expect(parsed.text.length).toBeGreaterThan(0);
    });

    it('treats plain prose as chat, not a signal', () => {
      const parsed = service.parseResponse('Selam, bugün piyasa sakin.');
      expect(parsed.signal).toBeNull();
      expect(parsed.text).toBe('Selam, bugün piyasa sakin.');
    });

    it('uppercases pair and direction so downstream comparisons hold', () => {
      const parsed = service.parseResponse(
        '```json\n{"signal": true, "pair": "btcusdt", "direction": "long"}\n```',
      );
      expect(parsed.signal?.pair).toBe('BTCUSDT');
      expect(parsed.signal?.direction).toBe('LONG');
    });
  });
});

describe('TradeEngineService saglayici ayarlari', () => {
  const engineWith = (env: Record<string, string>) =>
    new TradeEngineService(
      { get: (k: string) => env[k] } as any,
      {} as any,
      {} as any,
    ) as any;

  it('defaults to Abacus and fable-5', () => {
    const e = engineWith({});
    expect(e.apiUrl).toContain('apps.abacus.ai');
    expect(e.model).toBe('claude-fable-5');
    expect(e.maxTokens).toBe(4000);
    expect(e.promptCoinCount).toBe(50);
  });

  // Ayni istek govdesi baska saglayicilarda da gecerli; kota biterse
  // sadece ortam degiskenleri degisir.
  it('switches provider from env alone', () => {
    const e = engineWith({
      LLM_API_URL: 'https://api.groq.com/openai/v1/chat/completions',
      LLM_API_KEY: 'gsk_test',
      LLM_MODEL: 'llama-3.3-70b-versatile',
    });
    expect(e.apiUrl).toContain('groq.com');
    expect(e.apiKey).toBe('gsk_test');
    expect(e.model).toBe('llama-3.3-70b-versatile');
  });

  it('still accepts the original ABACUSAI_API_KEY name', () => {
    expect(engineWith({ ABACUSAI_API_KEY: 's2_eski' }).apiKey).toBe('s2_eski');
  });

  it('prefers LLM_API_KEY over the legacy name', () => {
    expect(
      engineWith({ LLM_API_KEY: 'yeni', ABACUSAI_API_KEY: 'eski' }).apiKey,
    ).toBe('yeni');
  });

  it('clamps the coin count to a sane range', () => {
    expect(engineWith({ PROMPT_COIN_COUNT: '200' }).promptCoinCount).toBe(50);
    expect(engineWith({ PROMPT_COIN_COUNT: '1' }).promptCoinCount).toBe(5);
    expect(engineWith({ PROMPT_COIN_COUNT: '20' }).promptCoinCount).toBe(20);
  });
});

describe('TradeEngineService.parseReview', () => {
  const engine = new TradeEngineService(
    { get: () => undefined } as any,
    {} as any,
    {} as any,
  ) as any;

  const original = baseSignal();

  // parseReview'in regex'i ```(?:json)?\s*{...}\s*``` ariyor ve \s bosluğu
  // da esliyor, o yuzden test verisi tek satirda durabiliyor.
  const fenced = (json: string) => '```json ' + json + ' ```';

  it('approves and keeps the card unchanged', () => {
    const r = engine.parseReview(
      fenced('{"verdict":"approve","comment":"Saglam kurulum."}'),
      original,
    );
    expect(r.verdict).toBe('approve');
    expect(r.signal.entry).toBe(original.entry);
    expect(r.comment).toContain('Saglam');
  });

  it('rejects and drops the card', () => {
    const r = engine.parseReview(
      fenced(
        '{"verdict":"reject","comment":"Hareket zaten olmus, kovalamaca."}',
      ),
      original,
    );
    expect(r.verdict).toBe('reject');
    expect(r.signal).toBeNull();
    expect(r.comment).toContain('kovalamaca');
  });

  it('carries revised numbers through', () => {
    const r = engine.parseReview(
      fenced(
        '{"verdict":"revise","comment":"Stop cok sikiydi.","stopLoss":"65000","leverage":"2x"}',
      ),
      original,
    );
    expect(r.verdict).toBe('revise');
    expect(r.signal.stopLoss).toBe('65000');
    expect(r.signal.leverage).toBe('2x');
    // Dokunulmayan alanlar orijinalinden gelir
    expect(r.signal.pair).toBe(original.pair);
    expect(r.signal.takeProfit).toBe(original.takeProfit);
  });

  // Denetci bir kalite kapisi, guvenlik kapisi degil: cevabi okunamazsa
  // karti yutmak yerine geciriyoruz, cunku validateSignal zaten arkada.
  it('approves unchanged when the reply has no JSON', () => {
    const r = engine.parseReview('bilmem ne dedi', original);
    expect(r.verdict).toBe('approve');
    expect(r.signal).toEqual(original);
  });

  it('approves unchanged on malformed JSON', () => {
    const r = engine.parseReview(fenced('{bozuk'), original);
    expect(r.verdict).toBe('approve');
    expect(r.signal).toEqual(original);
  });

  it('treats an unknown verdict as approve', () => {
    const r = engine.parseReview('{"verdict":"belki","comment":"x"}', original);
    expect(r.verdict).toBe('approve');
  });

  it('reads a bare JSON object without a fence', () => {
    const r = engine.parseReview(
      'Sonuc: {"verdict":"reject","comment":"riskli"}',
      original,
    );
    expect(r.verdict).toBe('reject');
  });
});

describe('TradeEngineService.reviewSignal kisa devre', () => {
  it('skips the review when no separate watch model is configured', async () => {
    const engine = new TradeEngineService(
      {
        get: (k: string) => (k === 'LLM_MODEL' ? 'ayni-model' : undefined),
      } as any,
      {} as any,
      {} as any,
    ) as any;

    // Ikinci cagri yapilirsa test patlar
    engine.callLLM = () => Promise.reject(new Error('cagrilmamaliydi'));

    const r = await engine.reviewSignal(
      baseSignal(),
      binanceMarket(['BTCUSDT']),
      [],
      100,
    );
    expect(r.verdict).toBe('approve');
    expect(r.signal).not.toBeNull();
  });

  it('lets the card through when the reviewer call fails', async () => {
    const engine = new TradeEngineService(
      {
        get: (k: string) =>
          k === 'LLM_MODEL'
            ? 'karar-modeli'
            : k === 'LLM_MODEL_WATCH'
              ? 'ucuz-model'
              : undefined,
      } as any,
      {} as any,
      // Analiz alinamasa bile denetim yurumelidir.
      { getCoinAnalysis: () => Promise.resolve(null) } as any,
    ) as any;

    engine.callLLM = () => Promise.reject(new Error('saglayici coktu'));

    const r = await engine.reviewSignal(
      baseSignal(),
      binanceMarket(['BTCUSDT']),
      [],
      100,
    );
    expect(r.verdict).toBe('approve');
    expect(r.comment).toContain('İkinci değerlendirme yapılamadı');
  });
});

describe('TradeEngineService format hatasi ayrimi', () => {
  const engine = new TradeEngineService(
    { get: () => undefined } as any,
    {} as any,
    {} as any,
  ) as any;

  const fenced = (json: string) => '```json ' + json + ' ```';

  // Zayif bir tarama modeli JSON uretemeyince kod bunu "firsat yok"
  // saniyordu; bozuk tarayici ile sakin piyasa ayirt edilemiyordu.
  it('marks a reply with no JSON as a format failure', () => {
    const r = engine.parseResponse('Bugun piyasa sakin gorunuyor.');
    expect(r.signal).toBeNull();
    expect(r.hadJson).toBe(false);
  });

  it('marks malformed JSON as a format failure', () => {
    const r = engine.parseResponse(fenced('{bozuk json'));
    expect(r.signal).toBeNull();
    expect(r.hadJson).toBe(false);
  });

  it('marks an explicit no-signal as a valid answer', () => {
    const r = engine.parseResponse(fenced('{"signal": false}'));
    expect(r.signal).toBeNull();
    expect(r.hadJson).toBe(true);
  });

  it('marks a real signal as a valid answer', () => {
    const r = engine.parseResponse(
      fenced('{"signal": true, "pair": "BTCUSDT", "direction": "LONG"}'),
    );
    expect(r.signal).not.toBeNull();
    expect(r.hadJson).toBe(true);
  });
});

describe('TradeEngineService.describeLLMError', () => {
  const engine = new TradeEngineService(
    { get: () => undefined } as any,
    {} as any,
    {} as any,
  ) as any;

  const err = (status: number, message?: string) => ({
    response: { status, data: message ? { error: { message } } : undefined },
    message: 'Request failed',
  });

  // Uretimde yasandi: OpenRouter 402 dondu, kullanici "ulasamadim" gordu ve
  // sebebi ancak elle test edince ortaya cikti.
  it('explains a 402 as insufficient credit and quotes the provider', () => {
    const m = engine.describeLLMError(
      err(402, 'You requested up to 4000 tokens, but can only afford 1589'),
    );
    expect(m).toContain('Kredi yetersiz');
    expect(m).toContain('can only afford 1589');
    expect(m).toContain('LLM_MAX_TOKENS');
  });

  it('names the key variable on 401', () => {
    expect(engine.describeLLMError(err(401))).toContain('LLM_API_KEY');
  });

  it('names the model variable on 404', () => {
    expect(engine.describeLLMError(err(404))).toContain('LLM_MODEL');
  });

  it('reports a quota problem on 429', () => {
    expect(engine.describeLLMError(err(429))).toContain('Kota');
  });

  it('reports a timeout', () => {
    expect(engine.describeLLMError({ code: 'ECONNABORTED' })).toContain(
      'zamanında cevap vermedi',
    );
  });

  // Taninmayan bir durum kodu bile saglayicinin kendi cumlesini gostermeli.
  it('quotes the provider for an unrecognised status', () => {
    const m = engine.describeLLMError(err(503, 'upstream model overloaded'));
    expect(m).toContain('503');
    expect(m).toContain('upstream model overloaded');
  });

  it('falls back to a generic line when there is nothing to quote', () => {
    expect(engine.describeLLMError({ message: 'socket hang up' })).toContain(
      'ulaşamadım',
    );
  });
});
