import { TelegramService } from './telegram.service';

const stubConfig: any = { get: () => undefined };
const stubPrisma: any = {};
const stubEngine: any = {};
const stubMarket: any = {};

describe('TelegramService command routing', () => {
  let service: any;

  beforeEach(() => {
    service = new TelegramService(
      stubConfig,
      stubPrisma,
      stubEngine,
      stubMarket,
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
});
