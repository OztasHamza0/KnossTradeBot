import { parseAccount, roundStep } from './client';

/**
 * Hesap cevabinin ayristirilmasi, bir kez sessizce botu oldurmustu:
 * USDT satiri eksikse ozkaynak 0 donuyordu, run.ts bunu %100 ZARAR
 * okuyup "zarar siniri asildi" deyip duruyordu. Bir okuma anomalisi
 * gece kosusunu bitiriyordu.
 */

const hesap = (over: any = {}) => ({
  canTrade: true,
  assets: [
    { asset: 'BNB', walletBalance: '1', availableBalance: '1', unrealizedProfit: '0' },
    {
      asset: 'USDT',
      walletBalance: '1000',
      availableBalance: '600',
      unrealizedProfit: '25',
      ...over,
    },
  ],
});

describe('parseAccount', () => {
  it('ozkaynak = cuzdan + gerceklesmemis kar/zarar', () => {
    const r = parseAccount(hesap());
    expect(r.equityUsdt).toBe(1025);
    expect(r.balanceUsdt).toBe(600);
    expect(r.canTrade).toBe(true);
  });

  it('USDT satiri YOKSA FIRLATIR — sifir DONMEZ', () => {
    /**
     * Asil koruma bu. Sifir donmek, run.ts'e "%100 kaybettik" demektir
     * ve bot kendini durdurur. "Okuyamadim" ile "sifir" ayni sey degil.
     */
    expect(() => parseAccount({ canTrade: true, assets: [{ asset: 'BNB' }] })).toThrow(
      /USDT/,
    );
  });

  it('assets alani HIC YOKSA firlatir', () => {
    expect(() => parseAccount({ canTrade: true })).toThrow(/USDT/);
    expect(() => parseAccount(null)).toThrow(/USDT/);
  });

  it('bakiye alanlari sayiya cevrilemezse firlatir', () => {
    expect(() => parseAccount(hesap({ walletBalance: 'bozuk' }))).toThrow(/cevrilemedi/);
    expect(() => parseAccount(hesap({ availableBalance: undefined }))).toThrow(
      /cevrilemedi/,
    );
  });

  it('gerceklesmemis kar/zarar okunamazsa 0 sayilir (aleyhte varsayim)', () => {
    // Bu alan icin sifir GUVENLI: ozkaynagi cuzdana esitler, yani
    // pozisyonlarin kagit karini yok sayar.
    const r = parseAccount(hesap({ unrealizedProfit: 'bozuk' }));
    expect(r.equityUsdt).toBe(1000);
  });

  it('sifir bakiye GECERLI bir deger — firlatmaz', () => {
    // Karsi kontrol: gercekten bos bir hesap, okunamayan bir hesap
    // DEGILDIR. Ayrimi kaybetmemeliyiz.
    const r = parseAccount(
      hesap({ walletBalance: '0', availableBalance: '0', unrealizedProfit: '0' }),
    );
    expect(r.equityUsdt).toBe(0);
  });
});

describe('roundStep', () => {
  it('borsanin adimina ASAGI yuvarlar', () => {
    expect(roundStep(3.337, 0.01, 2)).toBe('3.33');
  });

  it('EPSILON: kayan nokta hatasi bir adim dusurmemeli', () => {
    // Olculmustu: duz Math.floor(value/step), BTCUSDT'de gecerli
    // miktarlarin ~%9'unu bir adim asagi dusuruyordu (0.043 -> 0.042).
    expect(roundStep(0.043, 0.001, 3)).toBe('0.043');
    expect(roundStep(0.3, 0.1, 1)).toBe('0.3');
    expect(roundStep(2.9, 0.1, 1)).toBe('2.9');
  });

  it('adim sifirsa yalnizca hassasiyete yuvarlar', () => {
    expect(roundStep(1.23456, 0, 3)).toBe('1.235');
  });
});
