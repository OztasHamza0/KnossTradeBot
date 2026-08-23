import { AutoScanService } from './auto-scan.service';

/**
 * Prisma stub. The due-interval predicate itself now lives in SQL (see
 * claimDueChats) and is verified against a real Postgres separately; these
 * tests cover the surrounding logic — who gets claimed, and that a chat the
 * claim did not win is never scanned.
 */
function makePrisma(
  chats: string[],
  claimWins: Record<string, boolean>,
  /** Sessiz saat penceresi olan sohbetler; varsayilan olarak hicbiri. */
  quiet: Record<string, [number, number]> = {},
) {
  return {
    active_chats: {
      findMany: () => Promise.resolve(chats.map((chat_id) => ({ chat_id }))),
    },
    user_state: {
      upsert: () => Promise.resolve({}),
      findMany: () =>
        Promise.resolve(
          chats.map((chat_id) => ({
            chat_id,
            quiet_start: quiet[chat_id]?.[0] ?? null,
            quiet_end: quiet[chat_id]?.[1] ?? null,
          })),
        ),
    },
    // Prisma passes the template parts; the chat id is the first value.
    $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve(claimWins[values[0] as string] ? 1 : 0),
  } as any;
}

function makeService(
  chats: string[],
  claimWins: Record<string, boolean>,
  engine: any = {},
  telegram: any = {},
  quiet: Record<string, [number, number]> = {},
) {
  return new AutoScanService(
    engine,
    telegram,
    makePrisma(chats, claimWins, quiet),
    { get: () => undefined } as any,
  );
}

describe('AutoScanService.claimDueChats', () => {
  it('claims a chat whose UPDATE matched', async () => {
    const svc = makeService(['a'], { a: true });
    expect(await svc.claimDueChats()).toEqual(['a']);
  });

  it('does not claim a chat whose UPDATE matched nothing', async () => {
    const svc = makeService(['a'], { a: false });
    expect(await svc.claimDueChats()).toEqual([]);
  });

  it('claims only the chats that are due', async () => {
    const svc = makeService(['due', 'notdue', 'off'], {
      due: true,
      notdue: false,
      off: false,
    });
    expect(await svc.claimDueChats()).toEqual(['due']);
  });

  it('returns nothing when there are no active chats', async () => {
    const svc = makeService([], {});
    expect(await svc.claimDueChats()).toEqual([]);
  });
});

describe('AutoScanService.runAutoScan', () => {
  it('does not call the engine when nothing was claimed', async () => {
    const analyze = jest.fn();
    const svc = makeService(
      ['a'],
      { a: false },
      { analyzeForAutoScan: analyze },
    );

    expect(await svc.runAutoScan()).toBe(0);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('scans exactly the claimed chats', async () => {
    const analyze = jest.fn().mockResolvedValue([]);
    const svc = makeService(
      ['a', 'b'],
      { a: true, b: false },
      { analyzeForAutoScan: analyze },
    );

    await svc.runAutoScan();
    expect(analyze).toHaveBeenCalledWith(['a']);
  });

  // A second tick arriving while the first pass is still running must not
  // start a concurrent pass in the same process.
  it('refuses a second concurrent run', async () => {
    // Kapiyi mock'un disinda kur: analyze henuz cagrilmamis olsa bile
    // release() guvenle calisir ve ilk gecis takilmaz.
    let release!: () => void;
    const gate = new Promise<any[]>((r) => (release = () => r([])));
    const analyze = jest.fn().mockReturnValue(gate);
    const svc = makeService(
      ['a'],
      { a: true },
      { analyzeForAutoScan: analyze },
    );

    const first = svc.runAutoScan();
    const second = await svc.runAutoScan();
    expect(second).toBe(0);

    release();
    await first;

    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it('survives an engine failure without throwing', async () => {
    const svc = makeService(
      ['a'],
      { a: true },
      { analyzeForAutoScan: () => Promise.reject(new Error('model down')) },
    );
    await expect(svc.runAutoScan()).resolves.toBe(0);
  });
});

describe('AutoScanService uyari mesaji', () => {
  function svcWithResult(result: any, sent: string[]) {
    return makeService(
      ['a'],
      { a: true },
      {
        analyzeForAutoScan: () => Promise.resolve([result]),
        parseNum: () => 0,
      },
      {
        sendMessage: (_c: string, t: string) => {
          sent.push(t);
          return Promise.resolve();
        },
        formatTradeCard: () => 'KART',
      },
    );
  }

  it('explains why no card followed the alert', async () => {
    const sent: string[] = [];
    await svcWithResult(
      {
        chatId: 'a',
        response: { text: '', signal: null },
        alert: '⚡ SERT HAREKET — KII: +20.6%',
        reason: 'Model fırsat görmedi (signal: false).',
      },
      sent,
    ).runAutoScan();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('KII');
    expect(sent[0]).toContain('İşlem kartı yok');
    expect(sent[0]).toContain('Model fırsat görmedi');
  });

  it('does not append the note when a card is coming', async () => {
    const sent: string[] = [];
    await svcWithResult(
      {
        chatId: 'a',
        response: {
          text: '',
          signal: { pair: 'BTCUSDT', direction: 'LONG', entry: '1' },
        },
        alert: '⚡ SERT HAREKET',
        reason: 'Sinyal gönderildi.',
      },
      sent,
    ).runAutoScan();

    expect(sent[0]).not.toContain('İşlem kartı yok');
    expect(sent[1]).toContain('KART');
  });

  it('sends the alert unchanged when there is no reason', async () => {
    const sent: string[] = [];
    await svcWithResult(
      {
        chatId: 'a',
        response: { text: '', signal: null },
        alert: '⚡ SERT HAREKET',
      },
      sent,
    ).runAutoScan();

    expect(sent[0]).toBe('⚡ SERT HAREKET');
  });
});

describe('AutoScanService sessiz saat', () => {
  const svc = makeService([], {});

  it('is never quiet when no window is set', () => {
    expect(svc.isQuietNow(null, null, 3)).toBe(false);
    expect(svc.isQuietNow(0, null, 3)).toBe(false);
  });

  describe('gunduz penceresi 09-17', () => {
    it.each([9, 12, 16])('is quiet at %i', (h) => {
      expect(svc.isQuietNow(9, 17, h)).toBe(true);
    });
    it.each([8, 17, 23, 0])('is not quiet at %i', (h) => {
      expect(svc.isQuietNow(9, 17, h)).toBe(false);
    });
  });

  // Gece penceresi gece yarisini asar; duz start<=h<end karsilastirmasi
  // burada yanlis sonuc verir.
  describe('gece penceresi 23-07', () => {
    it.each([23, 0, 3, 6])('is quiet at %i', (h) => {
      expect(svc.isQuietNow(23, 7, h)).toBe(true);
    });
    it.each([7, 8, 12, 22])('is not quiet at %i', (h) => {
      expect(svc.isQuietNow(23, 7, h)).toBe(false);
    });
  });

  describe('kullanicinin ayari 00-08', () => {
    it.each([0, 1, 5, 7])('is quiet at %i', (h) => {
      expect(svc.isQuietNow(0, 8, h)).toBe(true);
    });
    it.each([8, 9, 20, 23])('is not quiet at %i', (h) => {
      expect(svc.isQuietNow(0, 8, h)).toBe(false);
    });
  });

  it('treats a zero-length window as no window', () => {
    expect(svc.isQuietNow(5, 5, 5)).toBe(false);
  });

  it('reads the hour in the configured timezone', () => {
    // 2026-08-22T23:30:00Z -> Istanbul'da (UTC+3) ertesi gun 02:30
    const utcNight = new Date('2026-08-22T23:30:00Z');
    const istanbul = new AutoScanService(
      {} as any,
      {} as any,
      {} as any,
      {
        get: (k: string) =>
          k === 'BOT_TIMEZONE' ? 'Europe/Istanbul' : undefined,
      } as any,
    );
    expect(istanbul.currentHour(utcNight)).toBe(2);
  });

  it('falls back to UTC on an invalid timezone', () => {
    const bad = new AutoScanService(
      {} as any,
      {} as any,
      {} as any,
      {
        get: (k: string) =>
          k === 'BOT_TIMEZONE' ? 'Yok/Boyle_Bir_Yer' : undefined,
      } as any,
    );
    expect(bad.currentHour(new Date('2026-08-22T14:00:00Z'))).toBe(14);
  });
});

describe('AutoScanService sessiz saatte kapmaz', () => {
  it('skips a chat whose quiet window covers the whole day', async () => {
    // 0-23 penceresi saat 23 disinda her saati kapsar; testi saate bagimli
    // kilmamak icin currentHour'u sabitliyoruz.
    const svc = makeService(['a'], { a: true }, {}, {}, { a: [0, 23] }) as any;
    svc.currentHour = () => 3;
    expect(await svc.claimDueChats()).toEqual([]);
  });

  it('claims normally outside the quiet window', async () => {
    const svc = makeService(['a'], { a: true }, {}, {}, { a: [0, 8] }) as any;
    svc.currentHour = () => 14;
    expect(await svc.claimDueChats()).toEqual(['a']);
  });

  it('skips only the chats that are actually quiet', async () => {
    const svc = makeService(
      ['uyuyan', 'uyanik'],
      { uyuyan: true, uyanik: true },
      {},
      {},
      { uyuyan: [0, 8] },
    ) as any;
    svc.currentHour = () => 3;
    expect(await svc.claimDueChats()).toEqual(['uyanik']);
  });
});
