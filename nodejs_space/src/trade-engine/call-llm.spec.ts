import axios from 'axios';
import { TradeEngineService } from './trade-engine.service';

jest.mock('axios');
const mockedPost = axios.post as jest.Mock;

const engineWith = (env: Record<string, string> = {}) =>
  new TradeEngineService(
    { get: (k: string) => env[k] } as any,
    {} as any,
    {} as any,
  ) as any;

const reply = (content: string, finish_reason = 'stop') => ({
  data: { choices: [{ message: { content }, finish_reason }] },
});

describe('callLLM', () => {
  beforeEach(() => mockedPost.mockReset());

  it('normal cevabi dondurur', async () => {
    mockedPost.mockResolvedValue(reply('merhaba'));
    const out = await engineWith({ LLM_API_KEY: 'k' }).callLLM([]);
    expect(out).toBe('merhaba');
  });

  it('token tavanina takilan cevabi hata olarak bildirir', async () => {
    // Eskiden finish_reason yalnizca icerik BOSSA okunuyordu. Yarim gelen
    // JSON sessizce "format hatasi" diye damgalaniyor, gercek sebep
    // (token tavani) hicbir yerde gorunmuyordu.
    mockedPost.mockResolvedValue(
      reply('{"signal": true, "pair": "BTC', 'length'),
    );
    await expect(engineWith({ LLM_API_KEY: 'k' }).callLLM([])).rejects.toThrow(
      /token tavanina takildi/,
    );
  });

  it('max_tokens finish_reason varyantini da yakalar', async () => {
    mockedPost.mockResolvedValue(reply('yarim', 'max_tokens'));
    await expect(engineWith({ LLM_API_KEY: 'k' }).callLLM([])).rejects.toThrow(
      /yarida kesildi/,
    );
  });

  it('bos cevabi ayri bir hata olarak bildirir', async () => {
    mockedPost.mockResolvedValue(reply('', 'stop'));
    await expect(engineWith({ LLM_API_KEY: 'k' }).callLLM([])).rejects.toThrow(
      /bos cevap/,
    );
  });

  it('anahtar yoksa hic istek atmaz', async () => {
    await expect(engineWith({}).callLLM([])).rejects.toThrow(/tanimli degil/);
    expect(mockedPost).not.toHaveBeenCalled();
  });

  describe('temperature', () => {
    it('ayarlanmamissa gonderilmez', async () => {
      // Bilerek opt-in: dusunme modu acikken saglayici temperature=1
      // disini reddediyor, sabit bir deger gondermek cagriyi dusururdu.
      mockedPost.mockResolvedValue(reply('ok'));
      await engineWith({ LLM_API_KEY: 'k' }).callLLM([]);
      expect(mockedPost.mock.calls[0][1]).not.toHaveProperty('temperature');
    });

    it('ayarlandiysa gonderilir', async () => {
      mockedPost.mockResolvedValue(reply('ok'));
      await engineWith({ LLM_API_KEY: 'k', LLM_TEMPERATURE: '0.2' }).callLLM(
        [],
      );
      expect(mockedPost.mock.calls[0][1].temperature).toBe(0.2);
    });

    it('sacma bir deger gonderilmez', async () => {
      mockedPost.mockResolvedValue(reply('ok'));
      await engineWith({ LLM_API_KEY: 'k', LLM_TEMPERATURE: 'abc' }).callLLM(
        [],
      );
      expect(mockedPost.mock.calls[0][1]).not.toHaveProperty('temperature');
    });
  });
});
