import { TelegramService } from './telegram.service';

const stubConfig: any = { get: () => undefined };
const stubPrisma: any = {};
const stubEngine: any = {};
const stubMarket: any = {};
const stubOutcome: any = { performanceFor: () => Promise.resolve({}) };

describe('TelegramService command routing', () => {
  let service: any;

  beforeEach(() => {
    service = new TelegramService(
      stubConfig,
      stubPrisma,
      stubEngine,
      stubMarket,
      stubOutcome,
    );
  });

  describe('isScanCommand', () => {
    it.each([
      'tara',
      'TARA',
      'hadi tara bakalım',
      'var mı?',
      'VAR MI',
      'girilir mi?',
      'scan',
    ])('treats %j as a scan request', (text) => {
      expect(service.isScanCommand(text)).toBe(true);
    });

    // The previous substring match fired a full market scan on any word
    // containing "tara".
    it.each([
      'sen hangi taraftasın',
      'bu tarafta ne var',
      'taraflı konuşuyorsun',
      'karataş nasıl',
    ])('does not treat %j as a scan request', (text) => {
      expect(service.isScanCommand(text)).toBe(false);
    });
  });

  describe('isMarketCommand', () => {
    it('matches a market query', () => {
      expect(service.isMarketCommand('piyasa nasıl')).toBe(true);
    });

    it('does not match unrelated prose', () => {
      expect(service.isMarketCommand('bugün kendimi iyi hissediyorum')).toBe(
        false,
      );
    });
  });

  describe('matchBalanceCommand', () => {
    it('parses an amount', () => {
      expect(service.matchBalanceCommand('bakiye 250')).toBe(250);
    });

    it('parses a decimal amount written with a comma', () => {
      expect(service.matchBalanceCommand('bakiye 99,5')).toBeCloseTo(99.5);
    });

    it('returns NaN for a bare query', () => {
      expect(Number.isNaN(service.matchBalanceCommand('bakiye'))).toBe(true);
    });

    it('returns null for anything that is not a balance command', () => {
      expect(
        service.matchBalanceCommand('bakiyem hakkında konuşalım'),
      ).toBeNull();
    });
  });

  describe('looksLikePersistentInstruction', () => {
    it.each([
      'bundan sonra kaldıracı 5x geçme',
      'artık altcoinlere girme',
      'her zaman 3x kullan olsun',
    ])('stores %j as a rule', (text) => {
      expect(service.looksLikePersistentInstruction(text)).toBe(true);
    });

    // Questions used to be captured as permanent rules by the bare-word patterns.
    it.each([
      "ETH'ye girme zamanı mı?",
      'asla kazanamaz mıyım?',
      'bugün ne yapmalıyım',
      'BTC nasıl gidiyor',
    ])('does not store %j as a rule', (text) => {
      expect(service.looksLikePersistentInstruction(text)).toBe(false);
    });
  });

  describe('splitMessage', () => {
    it('leaves a short message intact', () => {
      expect(service.splitMessage('kısa mesaj')).toEqual(['kısa mesaj']);
    });

    it('splits past the 4096 character cap', () => {
      const chunks: string[] = service.splitMessage('a'.repeat(9000));
      expect(chunks.length).toBe(3);
      chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(4096));
      expect(chunks.join('').length).toBe(9000);
    });

    it('prefers a line break so trade card fields stay whole', () => {
      const line = `${'x'.repeat(200)}\n`;
      const chunks: string[] = service.splitMessage(line.repeat(30));
      expect(chunks[0].endsWith('x')).toBe(true);
      chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(4096));
    });
  });

  describe('parseWatchArg', () => {
    it.each([
      ['nobet 30dk', 30],
      ['nobet 30 dk', 30],
      ['nobet 30 dakika', 30],
      ['nobet 45', 45],
      ['nobet 2 saat', 120],
      ['nobet 2saat', 120],
      ['nobet 2s', 120],
      ['nobet 4 sa', 240],
    ])('parses %j to %i minutes', (text, expected) => {
      expect(service.parseWatchArg(text)).toBe(expected);
    });

    it.each(['nobet kapat', 'nobet dur', 'nobet iptal'])(
      'treats %j as off',
      (text) => {
        expect(service.parseWatchArg(text)).toBe(0);
      },
    );

    it.each(['nobet ac', 'nobet baslat', 'nobet devam'])(
      'treats %j as on',
      (text) => {
        expect(service.parseWatchArg(text)).toBe(-1);
      },
    );

    it('returns NaN for a bare status query', () => {
      expect(Number.isNaN(service.parseWatchArg('nobet'))).toBe(true);
    });

    it.each(['nobet bilmemne', 'nobet 30 ay', 'nobet cok sik'])(
      'returns null for unparseable %j',
      (text) => {
        expect(service.parseWatchArg(text)).toBeNull();
      },
    );

    // Kullanici Turkce karakterle yazar; normalize devrede olmali.
    it('handles Turkish characters', () => {
      expect(service.parseWatchArg('nöbet 30dk')).toBe(30);
      expect(service.parseWatchArg('NÖBET 2 SAAT')).toBe(120);
    });
  });

  describe('isWatchCommand', () => {
    it.each(['nobet', 'nöbet 30dk', '/nobet kapat'])('matches %j', (text) => {
      expect(service.isWatchCommand(text)).toBe(true);
    });

    it('does not match unrelated prose', () => {
      expect(service.isWatchCommand('bu gece nöbetçi eczane hangisi')).toBe(
        false,
      );
    });
  });

  describe('formatInterval', () => {
    it.each([
      [30, '30 dakika'],
      [60, '1 saat'],
      [120, '2 saat'],
      [90, '90 dakika'],
      [1440, '24 saat'],
    ])('formats %i as %j', (mins, expected) => {
      expect(service.formatInterval(mins)).toBe(expected);
    });
  });

  // Telegram'in "/" menusu komutu slash ile gonderir; her biri dogru
  // isleyiciye dusmeli.
  describe('slash komutlari (BotFather menusu)', () => {
    it('routes /tara to the scan handler', () => {
      expect(service.isScanCommand('/tara')).toBe(true);
    });

    it('routes /piyasa to the market handler', () => {
      expect(service.isMarketCommand('/piyasa')).toBe(true);
    });

    it('routes /bakiye to the balance handler as a status query', () => {
      expect(Number.isNaN(service.matchBalanceCommand('/bakiye'))).toBe(true);
    });

    it('routes /nobet to the watch handler', () => {
      expect(service.isWatchCommand('/nobet')).toBe(true);
    });

    it('routes /kurallar to the rules handler', () => {
      expect(service.isRulesCommand('/kurallar')).toBe(true);
    });

    // Menu komutu ile birlikte arguman da yazilabilmeli
    it('accepts an argument after a slash command', () => {
      expect(service.matchBalanceCommand('/bakiye 250')).toBe(250);
      expect(service.parseWatchArg('/nobet 30dk')).toBe(30);
    });
  });

  describe('isWatchTestCommand', () => {
    it.each([
      'nobet test',
      'nöbet test',
      'NÖBET TEST',
      'nobet dene',
      '/nobet test',
    ])('matches %j', (text) => {
      expect(service.isWatchTestCommand(text)).toBe(true);
    });

    it.each(['nobet', 'nobet 30dk', 'nobet kapat', 'test'])(
      'does not match %j',
      (text) => {
        expect(service.isWatchTestCommand(text)).toBe(false);
      },
    );

    // "nobet test" arayuz katmaninda test dalina gider; aralik ayristirici
    // onu anlamaz ve null doner. handleWatch test dalini once kontrol ettigi
    // icin bu dogru davranis.
    it('is not mistaken for an interval', () => {
      expect(service.parseWatchArg('nobet test')).toBeNull();
      expect(service.isWatchCommand('nobet test')).toBe(true);
    });
  });

  describe('arastirma komutu', () => {
    it.each([
      'arastir PEPE',
      'araştır PEPE',
      'incele SOL',
      'analiz bonk',
      '/arastir bitcoin',
      'ARAŞTIR pepe',
    ])('matches %j', (text) => {
      expect(service.isResearchCommand(text)).toBe(true);
    });

    // Fiil sart: cıplak coin adi normal sohbeti kacirirdi.
    it.each(['PEPE', 'BTC nasil', 'arastir', 'incele', 'bugun ne var'])(
      'does not match %j',
      (text) => {
        expect(service.isResearchCommand(text)).toBe(false);
      },
    );

    it.each([
      ['arastir PEPE', 'PEPE'],
      ['araştır pepe', 'pepe'],
      ['incele SOL', 'SOL'],
      ['/analiz bonk', 'bonk'],
      ['araştır PEPE coinini', 'PEPE'],
      ['incele SHIB token', 'SHIB'],
      ['araştır bitcoin?', 'bitcoin'],
    ])('parses %j to %j', (text, expected) => {
      expect(service.parseResearchQuery(text)).toBe(expected);
    });

    it('returns null when no coin was named', () => {
      expect(service.parseResearchQuery('arastir')).toBeNull();
      expect(service.parseResearchQuery('merhaba')).toBeNull();
    });

    it('rejects an absurdly long query', () => {
      expect(
        service.parseResearchQuery('arastir ' + 'x'.repeat(60)),
      ).toBeNull();
    });
  });

  describe('formatResearchCard', () => {
    const base = {
      id: 'pepe',
      name: 'Pepe',
      symbol: 'PEPE',
      marketCapRank: 51,
      price: 0.00000398,
      marketCap: 1_672_700_000,
      volume24h: 613_900_000,
      change24h: -1.87,
      change7d: 52.65,
      change30d: 42.41,
      ath: 0.00002803,
      athChangePct: -85.8,
      circulatingSupply: 420_690_000_000_000,
      totalSupply: 420_690_000_000_000,
      maxSupply: null,
      categories: ['Meme'],
      description: 'meme token',
      homepage: null,
      futuresPair: '1000PEPEUSDT',
      alternatives: [],
    };

    it('shows the tradable pair when the coin is on futures', () => {
      const card = service.formatResearchCard(base);
      expect(card).toContain('1000PEPEUSDT');
      expect(card).toContain('Pepe (PEPE)');
      expect(card).toContain('#51');
    });

    it('warns clearly when the coin is not on futures', () => {
      const card = service.formatResearchCard({ ...base, futuresPair: null });
      expect(card).toContain('Binance Futures');
      expect(card).toContain('kaldıraçlı işlem açılamaz');
    });

    it('offers the alternatives when the name was ambiguous', () => {
      const card = service.formatResearchCard({
        ...base,
        alternatives: [{ id: 'apepe', symbol: 'APEPE', rank: 144 }],
      });
      expect(card).toContain('APEPE');
    });
  });

  describe('sessiz saat komutu', () => {
    it.each(['sessiz', 'sessiz 00-08', 'SESSIZ kapat', '/sessiz 23-07'])(
      'matches %j',
      (text) => {
        expect(service.isQuietCommand(text)).toBe(true);
      },
    );

    it('does not match unrelated prose', () => {
      expect(service.isQuietCommand('sessizlik altindir')).toBe(false);
    });

    it('treats a bare command as a status query', () => {
      expect(service.parseQuietArg('sessiz').kind).toBe('show');
    });

    it.each(['sessiz kapat', 'sessiz iptal', 'sessiz yok'])(
      'treats %j as off',
      (text) => {
        expect(service.parseQuietArg(text).kind).toBe('off');
      },
    );

    it.each([
      ['sessiz 00-08', 0, 8],
      ['sessiz 0-8', 0, 8],
      ['sessiz 23-07', 23, 7],
      ['sessiz 23:00-07:00', 23, 7],
      ['sessiz 1 - 9', 1, 9],
      ['sessiz 22 ile 06', 22, 6],
    ])('parses %j to %i-%i', (text, start, end) => {
      expect(service.parseQuietArg(text)).toEqual({ kind: 'set', start, end });
    });

    it.each(['sessiz 25-08', 'sessiz 00-30', 'sessiz bilmemne', 'sessiz 5'])(
      'rejects %j',
      (text) => {
        expect(service.parseQuietArg(text).kind).toBe('invalid');
      },
    );
  });

  describe('kredi komutu', () => {
    it.each(['kredi', 'KREDI', '/kredi', 'kota', 'harcama'])(
      'matches %j',
      (text) => {
        expect(service.isCreditCommand(text)).toBe(true);
      },
    );

    it.each(['kredi karti nedir', 'bakiye', 'tara'])(
      'does not match %j',
      (text) => {
        expect(service.isCreditCommand(text)).toBe(false);
      },
    );
  });

  describe('parseAmount — binlik ayraclari', () => {
    // "bakiye 1,000" -> 1 USDT kaydediliyordu ve kill switch aniden
    // devreye giriyordu.
    it.each([
      ['1,000', 1000],
      ['1.000', 1000],
      ['1,000,000', 1000000],
      ['1.000.000', 1000000],
      ['100', 100],
      ['99,5', 99.5],
      ['99.50', 99.5],
      ['1,234.56', 1234.56],
      ['1.234,56', 1234.56],
    ])('parses %j to %f', (raw, expected) => {
      expect(service.parseAmount(raw)).toBeCloseTo(expected, 4);
    });

    it('reads a thousands-separated balance from the command', () => {
      expect(service.matchBalanceCommand('bakiye 1,000')).toBeCloseTo(1000);
      expect(service.matchBalanceCommand('bakiye 2.500')).toBeCloseTo(2500);
    });
  });

  describe('isAllowed', () => {
    const withAllow = (list?: string) =>
      new TelegramService(
        {
          get: (k: string) => (k === 'ALLOWED_CHAT_IDS' ? list : undefined),
        } as any,
        stubPrisma,
        stubEngine,
        stubMarket,
      ) as any;

    it('serves everyone when no allowlist is configured', () => {
      expect(withAllow(undefined).isAllowed('12345')).toBe(true);
      expect(withAllow('').isAllowed('12345')).toBe(true);
    });

    it('serves only the listed chats', () => {
      const svc = withAllow('111, 222');
      expect(svc.isAllowed('111')).toBe(true);
      expect(svc.isAllowed('222')).toBe(true);
      expect(svc.isAllowed('333')).toBe(false);
    });
  });
});

/**
 * Turkce buyuk 'İ' regresyonu.
 *
 * normalize() once toLowerCase cagirdigi icin 'İ' -> 'i' + U+0307 oluyordu ve
 * komut regexleri sessizce eslesmiyordu. Telefon klavyeleri cumle basini
 * otomatik buyuttugu icin bu yol gunluk kullanimda surekli tetikleniyordu:
 * "BAKİYE 100" bakiye kaydetmiyor, serbest sohbete dusup LLM cagrisi
 * yakiyordu — ve bakiye null kaldigi icin boyutlandirma denetimi de
 * devre disi kaliyordu.
 */
describe('TelegramService buyuk harfli Turkce komutlar', () => {
  const service: any = new TelegramService(
    stubConfig,
    stubPrisma,
    stubEngine,
    stubMarket,
    stubOutcome,
  );

  it('BAKİYE 100 bir bakiye komutudur', () => {
    expect(service.matchBalanceCommand('BAKİYE 100')).toBe(100);
    expect(service.matchBalanceCommand('Bakiye 100')).toBe(100);
    expect(service.matchBalanceCommand('bakiye 100')).toBe(100);
  });

  it('BAKİYE (argumansiz) durum sorgusudur', () => {
    expect(Number.isNaN(service.matchBalanceCommand('BAKİYE'))).toBe(true);
  });

  it('PİYASA bir piyasa komutudur', () => {
    expect(service.isMarketCommand('PİYASA')).toBe(true);
  });

  it('İNCELE ve ARAŞTIR buyuk harfle de arastirma komutudur', () => {
    expect(service.isResearchCommand('İNCELE SOL')).toBe(true);
    expect(service.isResearchCommand('ARAŞTIR PEPE')).toBe(true);
  });

  it('SESSİZ bir sessiz saat komutudur', () => {
    expect(service.isQuietCommand('SESSİZ 00-08')).toBe(true);
    expect(service.parseQuietArg('SESSİZ 00-08')).toEqual({
      kind: 'set',
      start: 0,
      end: 8,
    });
  });

  it('NÖBET ve TARA zaten calisiyordu, bozulmadi', () => {
    expect(service.isWatchCommand('NÖBET 30DK')).toBe(true);
    expect(service.parseWatchArg('NÖBET 30DK')).toBe(30);
    expect(service.isScanCommand('TARA')).toBe(true);
  });

  it('normal cumleler hala komut sanilmiyor', () => {
    expect(service.isScanCommand('KİM TARAFINDAN')).toBe(false);
    expect(service.isCreditCommand('KREDİ KARTI NEDİR')).toBe(false);
  });
});
