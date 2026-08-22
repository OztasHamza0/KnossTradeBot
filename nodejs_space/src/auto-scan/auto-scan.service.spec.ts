import { AutoScanService } from './auto-scan.service';

const NOW = new Date('2026-08-22T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000);

/** Prisma stub: active_chats + user_state okumalarini karsilar. */
function makePrisma(chats: string[], states: any[]) {
  return {
    active_chats: {
      findMany: () => Promise.resolve(chats.map((chat_id) => ({ chat_id }))),
    },
    user_state: { findMany: () => Promise.resolve(states) },
  } as any;
}

function makeService(chats: string[], states: any[]) {
  return new AutoScanService({} as any, {} as any, makePrisma(chats, states), {
    get: () => undefined,
  } as any);
}

describe('AutoScanService.findDueChats', () => {
  it('scans a chat that has never been scanned', async () => {
    const svc = makeService(['a'], []);
    expect(await svc.findDueChats(NOW)).toEqual(['a']);
  });

  it('applies the 60 minute default when no state row exists', async () => {
    const svc = makeService(
      ['a'],
      [{ chat_id: 'a', scan_enabled: true, last_scan_at: null }],
    );
    expect(await svc.findDueChats(NOW)).toEqual(['a']);
  });

  it('skips a chat whose interval has not elapsed', async () => {
    const svc = makeService(
      ['a'],
      [
        {
          chat_id: 'a',
          scan_enabled: true,
          scan_interval_minutes: 60,
          last_scan_at: minutesAgo(20),
        },
      ],
    );
    expect(await svc.findDueChats(NOW)).toEqual([]);
  });

  it('scans a chat whose interval has elapsed', async () => {
    const svc = makeService(
      ['a'],
      [
        {
          chat_id: 'a',
          scan_enabled: true,
          scan_interval_minutes: 60,
          last_scan_at: minutesAgo(61),
        },
      ],
    );
    expect(await svc.findDueChats(NOW)).toEqual(['a']);
  });

  // A 60-minute interval on a 5-minute tick lands at 60.0 exactly; without
  // slack it would slip to the next tick and drift to 65 every cycle.
  it('scans at exactly the interval boundary', async () => {
    const svc = makeService(
      ['a'],
      [
        {
          chat_id: 'a',
          scan_enabled: true,
          scan_interval_minutes: 60,
          last_scan_at: minutesAgo(60),
        },
      ],
    );
    expect(await svc.findDueChats(NOW)).toEqual(['a']);
  });

  it('never scans a chat with the watch turned off', async () => {
    const svc = makeService(
      ['a'],
      [
        {
          chat_id: 'a',
          scan_enabled: false,
          scan_interval_minutes: 15,
          last_scan_at: minutesAgo(600),
        },
      ],
    );
    expect(await svc.findDueChats(NOW)).toEqual([]);
  });

  it('honours a different interval per chat', async () => {
    const svc = makeService(
      ['fast', 'slow', 'off'],
      [
        {
          chat_id: 'fast',
          scan_enabled: true,
          scan_interval_minutes: 15,
          last_scan_at: minutesAgo(20),
        },
        {
          chat_id: 'slow',
          scan_enabled: true,
          scan_interval_minutes: 240,
          last_scan_at: minutesAgo(20),
        },
        {
          chat_id: 'off',
          scan_enabled: false,
          scan_interval_minutes: 5,
          last_scan_at: minutesAgo(20),
        },
      ],
    );
    expect(await svc.findDueChats(NOW)).toEqual(['fast']);
  });

  it('returns nothing when there are no active chats', async () => {
    const svc = makeService([], []);
    expect(await svc.findDueChats(NOW)).toEqual([]);
  });
});
