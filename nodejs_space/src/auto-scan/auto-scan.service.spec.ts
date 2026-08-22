import { AutoScanService } from './auto-scan.service';

/**
 * Prisma stub. The due-interval predicate itself now lives in SQL (see
 * claimDueChats) and is verified against a real Postgres separately; these
 * tests cover the surrounding logic — who gets claimed, and that a chat the
 * claim did not win is never scanned.
 */
function makePrisma(chats: string[], claimWins: Record<string, boolean>) {
  return {
    active_chats: {
      findMany: () => Promise.resolve(chats.map((chat_id) => ({ chat_id }))),
    },
    user_state: { upsert: () => Promise.resolve({}) },
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
) {
  return new AutoScanService(engine, telegram, makePrisma(chats, claimWins), {
    get: () => undefined,
  } as any);
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
