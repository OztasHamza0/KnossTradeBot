import { normalizeTr } from './turkish';

/**
 * Bu dosyanin varlik sebebi tek bir hata: 'İ'.toLowerCase() JavaScript'te
 * 'i' vermez, 'i' + U+0307 verir. Eski normalize once toLowerCase cagirip
 * sonra 'İ' aradigi icin hicbir sey bulamiyor, geriye gorunmez bir birlesik
 * karakter kaliyordu ve butun komut regexleri sessizce eslesmiyordu.
 *
 * Telefon klavyeleri cumle basini otomatik buyuttugu icin bu, gunluk
 * kullanimda surekli tetiklenen bir yoldu.
 */
describe('normalizeTr', () => {
  it('noktali buyuk I birlesik karakter birakmaz', () => {
    const out = normalizeTr('BAKİYE');
    expect(out).toBe('bakiye');
    // Asil regresyon: birlesik ustteki nokta (U+0307) kalmamali.
    expect(out).not.toContain('̇');
    expect([...out].length).toBe(6);
  });

  it('noktasiz buyuk I da i olur', () => {
    expect(normalizeTr('ILIK')).toBe('ilik');
    expect(normalizeTr('IŞIK')).toBe('isik');
  });

  it('zaten ayrisik gelmis metni de toparlar', () => {
    // Baska bir kaynak metni i + U+0307 olarak vermis olabilir.
    expect(normalizeTr('baki̇ye')).toBe('bakiye');
  });

  it('butun Turkce harfleri ASCII karsiligina indirger', () => {
    expect(normalizeTr('ÇĞİÖŞÜ çğıöşü')).toBe('cgiosu cgiosu');
  });

  it('bas ve sondaki bosluklari atar', () => {
    expect(normalizeTr('  TARA  ')).toBe('tara');
  });

  describe('komut regexleri buyuk harfle de eslesir', () => {
    const cases: [string, RegExp][] = [
      ['BAKİYE 100', /^(?:\/)?bakiye(?:m)?\s*([\d.,]+)?\s*(?:usdt)?$/],
      ['PİYASA', /\b(piyasa|market|fiyat|fiyatlar|piyasa durumu)\b/],
      ['İNCELE SOL', /^(?:\/)?(arastir|incele|analiz|arastirma)\s+\S+/],
      ['SESSİZ 00-08', /^(?:\/)?sessiz\b/],
      ['NÖBET 30DK', /^(?:\/)?nobet\b/],
      ['ARAŞTIR PEPE', /^(?:\/)?(arastir|incele|analiz|arastirma)\s+\S+/],
    ];

    it.each(cases)('%s', (text, pattern) => {
      expect(pattern.test(normalizeTr(text))).toBe(true);
    });
  });

  it('kelime siniri korumasi bozulmaz', () => {
    // "taraf" bir tarama komutu degildir; eski bir hata buydu.
    expect(/\b(tara|tarama|scan)\b/.test(normalizeTr('kim TARAFINDAN'))).toBe(
      false,
    );
  });
});
