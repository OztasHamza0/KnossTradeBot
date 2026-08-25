import { UnauthorizedException } from '@nestjs/common';
import { TelegramController } from './telegram.controller';

/**
 * Webhook adresi herkese acik. Eskiden TELEGRAM_WEBHOOK_SECRET tanimsizsa
 * dogrulama TAMAMEN atlaniyordu — yani degiskeni unutmak endpoint'i sessizce
 * herkese acik birakiyordu. Ayni dosyadaki cron endpoint'i zaten tersini
 * yapiyordu; ikisi ayni davranmali.
 */
describe('TelegramController webhook dogrulamasi', () => {
  const processed: any[] = [];
  const service: any = {
    processUpdate: (b: any) => {
      processed.push(b);
      return Promise.resolve();
    },
  };

  const controller = (secret?: string) =>
    new TelegramController(service, {
      get: (k: string) =>
        k === 'TELEGRAM_WEBHOOK_SECRET' ? secret : undefined,
    } as any);

  beforeEach(() => {
    processed.length = 0;
  });

  it('secret tanimsizsa istegi REDDEDER', () => {
    expect(() => controller(undefined).handleWebhook({}, 'herhangi')).toThrow(
      UnauthorizedException,
    );
    expect(processed).toHaveLength(0);
  });

  it('secret yanlissa reddeder', () => {
    expect(() => controller('dogru').handleWebhook({}, 'yanlis')).toThrow(
      UnauthorizedException,
    );
    expect(processed).toHaveLength(0);
  });

  it('secret hic gonderilmemisse reddeder', () => {
    expect(() =>
      controller('dogru').handleWebhook({}, undefined as any),
    ).toThrow(UnauthorizedException);
    expect(processed).toHaveLength(0);
  });

  it('secret dogruysa isler ve hemen 200 doner', () => {
    const res = controller('dogru').handleWebhook({ update_id: 1 }, 'dogru');
    expect(res).toEqual({ ok: true });
    // Telegram, hizli 200 almadigi update'i tekrar gonderir; isleme arkada
    // devam ediyor.
    expect(processed).toEqual([{ update_id: 1 }]);
  });

  it('saglik ucu acik kalir', () => {
    const h = controller('dogru').health();
    expect(h.status).toBe('ok');
    expect(typeof h.uptime).toBe('number');
  });
});
