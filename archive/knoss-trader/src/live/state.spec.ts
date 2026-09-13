import * as fs from 'fs';
import * as os from 'os';
import * as pathmod from 'path';

// Testler CANLI durum dosyasina dokunmamali: onceki halinde stateFilePath()
// gercek bot-state.json'i donuyordu ve 'npm test' calistirmak, o sirada
// calisan botun pozisyon kaydini siliyordu.
process.env.BOT_STATE_FILE = pathmod.join(
  os.tmpdir(),
  `bot-state-test-${process.pid}.json`,
);
import { loadState, saveState, emptyState, utcDay, stateFilePath, totalRiskUsdt, openCount, rollDayIfNeeded } from './state';

/**
 * Kalici durum, iki gercek acigi kapatiyor:
 *  - Guvenlik sayaclari surec hafizasindaydi; bot cokup yeniden baslayinca
 *    "en fazla 20 islem" sinirini bir cokme dongusu sonsuza kadar delerdi.
 *  - Bot kendi pozisyonunu kullanicininkinden ayirt edemiyordu.
 */

const FILE = stateFilePath();
const backup = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : null;

afterAll(() => {
  if (backup !== null) fs.writeFileSync(FILE, backup);
  else if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
});

beforeEach(() => {
  if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
});

const T = Date.parse('2026-09-02T20:00:00Z');

describe('kalici durum', () => {
  it('dosya yokken temiz durum uretir', () => {
    const s = loadState(T, 1000);
    expect(s.trades).toBe(0);
    expect(Object.keys(s.positions)).toHaveLength(0);
    expect(s.dayStartEquity).toBe(1000);
    expect(s.day).toBe('2026-09-02');
  });

  it('sayaclari yeniden baslatmalar arasinda KORUR', () => {
    // Asil mesele bu: bot cokup yeniden baslayinca sayac sifirlanmamali.
    const s = emptyState(utcDay(T), 1000);
    s.trades = 17;
    s.failedAttempts = 3;
    saveState(s);

    const again = loadState(T, 999);
    expect(again.trades).toBe(17);
    expect(again.failedAttempts).toBe(3);
    // Gun basi bakiye de korunur, yoksa zarar siniri her baslatmada
    // yeni bir referanstan olculur ve fiilen devre disi kalir.
    expect(again.dayStartEquity).toBe(1000);
  });

  it('gun degisince sayaclar sifirlanir ama ACIK POZISYON kaydi kalir', () => {
    const s = emptyState('2026-09-01', 1000);
    s.trades = 20;
    s.positions['SOLUSDT'] = {
      symbol: 'SOLUSDT', side: 'LONG', qty: 1, entryPrice: 100,
      openedAt: T - 3600_000, clientOrderId: 'e-1', riskUsdt: 10,
    };
    saveState(s);

    const next = loadState(T, 900);
    expect(next.day).toBe('2026-09-02');
    expect(next.trades).toBe(0);
    // Pozisyon gun sinirini bilmez; kaydi silinirse bot kendi pozisyonunu
    // "yabanci" sanip hic baslamaz.
    expect(next.positions['SOLUSDT']?.symbol).toBe('SOLUSDT');
  });

  it('bozuk dosya BOZUK olarak isaretlenir — temiz durum SAYILMAZ', () => {
    /**
     * BU TESTIN ONCEKI HALI YANLIS DAVRANISI SABITLIYORDU.
     *
     * Adi "bozuk dosya botu durdurmaz, temiz durumla devam eder" idi ve
     * tam da bunu dogruluyordu. Ama temiz durumla devam etmek GUVENLI
     * DEGIL: emptyState(day, balance) cagrisi dayStartEquity'yi GUNCEL
     * bakiyeye set eder. Yani bot gunun ilk yarisinda %10 kaybettikten
     * sonra dosya bozulursa, zarar sinirinin referansi dusmus bakiye olur
     * ve bot TAZE bir %15 butcesi kazanir. Islem sayaci da sifirlanir.
     *
     * Bu, projedeki en pahali desenin bir ornegi: bir testin YANLIS
     * davranisi "dogru" diye sabitlemesi. Ayni sey closeNow dogrulama
     * testinde de olmustu ve bir hatanin iki tur yasamasina sebep olmustu.
     */
    fs.writeFileSync(FILE, '{ bozuk json');
    const s = loadState(T, 500);
    expect(s.bozuk).toBe(true);
  });

  it('SAGLAM dosya bozuk isaretlenmez (test bos gecmesin)', () => {
    const iyi = emptyState(utcDay(T), 1000);
    iyi.trades = 3;
    saveState(iyi);
    const s = loadState(T, 999);
    expect(s.bozuk).toBeFalsy();
    expect(s.trades).toBe(3);
  });

  it('dosya HIC YOKSA bozuk degildir — ilk calistirma normaldir', () => {
    // Ayrim onemli: "dosya yok" bilinen bir durum (ilk calistirma),
    // "dosya bozuk" bilinmeyen bir durum.
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
    const s = loadState(T, 1000);
    expect(s.bozuk).toBeFalsy();
    expect(s.trades).toBe(0);
  });
});

describe('toplam risk — korelasyon korumasi', () => {
  const pos = (symbol: string, riskUsdt: number) => ({
    symbol, side: 'LONG' as const, qty: 1, entryPrice: 100,
    openedAt: T, clientOrderId: 'e-1', riskUsdt,
  });

  it('acik pozisyonlarin riskini TOPLAR', () => {
    // Asil mesele bu: 6 sembolde islem basi %1 risk "toplam %1" DEGILDIR.
    // Kripto neredeyse tek varlik gibi hareket eder; sert bir dususte
    // hepsi ayni anda stop olur. Gercek maruziyet toplamdir.
    const s = emptyState(utcDay(T), 1000);
    s.positions['SOLUSDT'] = pos('SOLUSDT', 10);
    s.positions['ETHUSDT'] = pos('ETHUSDT', 10);
    s.positions['AVAXUSDT'] = pos('AVAXUSDT', 10);
    expect(totalRiskUsdt(s)).toBe(30);
    expect(openCount(s)).toBe(3);
  });

  it('bos durumda risk ve sayim sifir', () => {
    const s = emptyState(utcDay(T), 1000);
    expect(totalRiskUsdt(s)).toBe(0);
    expect(openCount(s)).toBe(0);
  });

  it('riskUsdt eksik olan eski kayitlar sifir sayilir, cokme olmaz', () => {
    const s = emptyState(utcDay(T), 1000);
    // Eski surumden kalan, riskUsdt alani olmayan kayit.
    (s.positions as any)['SOLUSDT'] = { symbol: 'SOLUSDT', side: 'LONG', qty: 1, entryPrice: 100, openedAt: T, clientOrderId: 'e' };
    expect(totalRiskUsdt(s)).toBe(0);
    expect(openCount(s)).toBe(1);
  });

  it('sembol bazinda kayit: bir sembolun kaydi digerini etkilemez', () => {
    // Ayri surecler ayni dosyayi eziyordu; sembol bazli kayit bunu cozer.
    const s = emptyState(utcDay(T), 1000);
    s.positions['SOLUSDT'] = pos('SOLUSDT', 10);
    saveState(s);
    const back = loadState(T, 1000);
    back.positions['ETHUSDT'] = pos('ETHUSDT', 10);
    saveState(back);
    const final = loadState(T, 1000);
    expect(Object.keys(final.positions).sort()).toEqual(['ETHUSDT', 'SOLUSDT']);
  });
});

describe('calisan surecte gun donusu', () => {
  /**
   * Asil mesele: loadState gun donusunu dogru yapiyordu ama YALNIZCA
   * aciliste cagriliyor. Calisan surecte gun hic donmuyor, yani mantik
   * canli yolda OLU KODDU. Olculdu: bot 02 Eylul 21:50 UTC'de basladi,
   * 03 Eylul 05:30'da hala day = "2026-09-02" diyordu. Bu yuzden
   * "gunluk en fazla N islem" fiilen omur boyu tavan, "gunluk %N zarar"
   * ise surecin baslangicindan olculen bir sinir haline geliyordu.
   */
  const ERTESI = Date.parse('2026-09-03T00:00:01Z');

  it('ayni gun icinde HICBIR SEYI degistirmez', () => {
    const s = emptyState('2026-09-02', 1000);
    s.trades = 7;
    s.failedAttempts = 2;
    expect(rollDayIfNeeded(s, T, 900)).toBe(false);
    expect(s.trades).toBe(7);
    expect(s.failedAttempts).toBe(2);
    expect(s.dayStartEquity).toBe(1000);
  });

  it('gun degisince sayaclari sifirlar ve referans ozkaynagi TAZELER', () => {
    const s = emptyState('2026-09-02', 1000);
    s.trades = 40;
    s.failedAttempts = 4;
    expect(rollDayIfNeeded(s, ERTESI, 880)).toBe(true);
    expect(s.day).toBe('2026-09-03');
    expect(s.trades).toBe(0);
    expect(s.failedAttempts).toBe(0);
    // Referans tazelenmezse zarar siniri dunun bakiyesinden olculur ve
    // bot dunku zarar yuzunden bugun hic islem yapmadan durabilir.
    expect(s.dayStartEquity).toBe(880);
  });

  it('gun donerken ACIK POZISYON kaydini SILMEZ', () => {
    // Pozisyon gun sinirini bilmez. Kaydi silinirse bot kendi pozisyonunu
    // "yabanci" sanip durur ve borsada korumali ama sahipsiz pozisyon kalir.
    const s = emptyState('2026-09-02', 1000);
    s.positions['SOLUSDT'] = {
      symbol: 'SOLUSDT', side: 'LONG', qty: 1, entryPrice: 100,
      openedAt: T, clientOrderId: 'e-1', riskUsdt: 10,
    };
    rollDayIfNeeded(s, ERTESI, 950);
    expect(s.positions['SOLUSDT']?.symbol).toBe('SOLUSDT');
    expect(openCount(s)).toBe(1);
  });

  it('gun atlanirsa (bot bir gun kapali kaldiysa) yine doner', () => {
    const s = emptyState('2026-08-30', 1000);
    s.trades = 12;
    expect(rollDayIfNeeded(s, ERTESI, 1000)).toBe(true);
    expect(s.day).toBe('2026-09-03');
    expect(s.trades).toBe(0);
  });
});

describe('niyet kaydi — cokme kurtarmasi', () => {
  /**
   * Emir borsaya gidip pozisyon acildiktan SONRA ama durum kaydi
   * yazilmadan ONCE bot cokerse, pozisyon borsada var kayitta yok olur.
   * Acilistaki "botun ACMADIGI bir pozisyon var" kapisi devreye girer ve
   * bot BIR DAHA HIC BASLAMAZ — yalnizca o sembol icin degil, tum
   * sembollerin mutabakati durur.
   *
   * Niyet kaydi emirden ONCE diske yazilir ve pozisyonun BIZIM oldugunu
   * kanitlar. Tanimadigi pozisyona bot hala dokunmaz.
   */
  it('niyet kaydi diske yazilir ve geri okunur', () => {
    const s = emptyState(utcDay(T), 1000);
    s.pending = { SOLUSDT: { symbol: 'SOLUSDT', side: 'LONG', at: T } };
    saveState(s);
    const geri = loadState(T, 1000);
    expect(geri.pending?.SOLUSDT?.side).toBe('LONG');
    expect(geri.pending?.SOLUSDT?.at).toBe(T);
  });

  it('GUN DONSE BILE niyet kaydi korunur', () => {
    // Gece yarisina denk gelen bir cokme, kurtarma bilgisini
    // kaybettirmemeli.
    const s = emptyState('2026-09-01', 1000);
    s.pending = { BTCUSDT: { symbol: 'BTCUSDT', side: 'SHORT', at: T } };
    saveState(s);
    const geri = loadState(T, 900);
    expect(geri.day).toBe('2026-09-02');
    expect(geri.trades).toBe(0);
    expect(geri.pending?.BTCUSDT?.symbol).toBe('BTCUSDT');
  });

  it('temiz durumda niyet kaydi bostur', () => {
    expect(emptyState(utcDay(T), 1000).pending).toEqual({});
  });

  it('ESKI surumden kalan, pending alani olmayan dosya cokme yaratmaz', () => {
    const eski: any = emptyState(utcDay(T), 1000);
    delete eski.pending;
    fs.writeFileSync(FILE, JSON.stringify(eski));
    const geri = loadState(T, 1000);
    expect(geri.pending).toEqual({});
  });
});

describe('saveState — ATOMIK yazma', () => {
  /**
   * Dogrudan durum dosyasinin uzerine yazarken surec yazmanin ORTASINDA
   * olurse geriye YARIM bir JSON kalir.
   *
   * Bu ihtiyac BUGUN ARTTI: bozuk dosya artik botu BASLATMIYOR (temiz
   * durumla devam etmek gunluk zarar sinirinin referansini sifirliyordu).
   * Dogru bir duzeltmeydi, ama yarim yazmanin bedelini "biraz guvenlik
   * kaybi"ndan "bot hic acilmaz"a cikardi — yani o duzeltme bunu ZORUNLU
   * kildi.
   */

  it('CANLI dosyaya asla dogrudan yazmaz — ve yarim yazma onu bozmaz', () => {
    /**
     * Asil garanti bu, ve testi casus KULLANMADAN kuruyoruz: gecici dosya
     * yolunun yerine bir KLASOR koyuyoruz. Artik o yola yazmak imkansiz.
     *
     * Ayrim burada: saveState dogrudan FILE'a yazsaydi, .tmp yolundaki
     * klasor onu HIC ETKILEMEZDI ve yeni kayit gecerdi. Gecmiyorsa,
     * yazmanin gercekten gecici dosyadan gectigini biliyoruz.
     *
     * Ve ayni test ikinci garantiyi de olcuyor: basarisiz bir yazma,
     * elimizdeki kaydi KAYBETTIRMIYOR. Onceki halinde yarim yazma
     * dosyayi bozardi — ve bozuk dosya artik botu hic baslatmiyor.
     */
    const iyi = emptyState(utcDay(T), 1000);
    iyi.trades = 7;
    saveState(iyi);

    const gecici = FILE + '.tmp';
    fs.mkdirSync(gecici); // o yola artik dosya yazilamaz
    try {
      const yeniKayit = emptyState(utcDay(T), 1);
      yeniKayit.trades = 999;
      saveState(yeniKayit); // patlamamali
    } finally {
      fs.rmSync(gecici, { recursive: true, force: true });
    }

    const geri = loadState(T, 1000);
    expect(geri.bozuk).toBeFalsy();
    // 999 gecseydi, yazma FILE'a DOGRUDAN gidiyor demekti.
    expect(geri.trades).toBe(7);
    expect(geri.dayStartEquity).toBe(1000);
  });

  it('gidis-donus hala calisiyor (karsi kontrol)', () => {
    const s = emptyState(utcDay(T), 1234);
    s.trades = 3;
    s.positions['SOLUSDT'] = {
      symbol: 'SOLUSDT', side: 'LONG', qty: 1, entryPrice: 100,
      openedAt: T, clientOrderId: 'e-1', riskUsdt: 10,
    };
    saveState(s);
    const geri = loadState(T, 999);
    expect(geri.trades).toBe(3);
    expect(geri.dayStartEquity).toBe(1234);
    expect(geri.positions['SOLUSDT']?.qty).toBe(1);
  });
});

describe('lastBar — ayni mumda ikinci girisi engeller', () => {
  /**
   * Bu kayit "ayni mumda iki kez islem acma" korumasi. Surec
   * hafizasinda tutuldugu surece her yeniden baslatma onu sifirliyor
   * ve bot en son kapanmis mumu "hic gorulmemis" sayiyordu.
   *
   * Bayat mum kapisi cogunu kapatiyor ama pencere tamamen kapanmiyor:
   * mum kapanir, bot girer, stop calisir, bot olur ve UC DAKIKA ICINDE
   * yeniden baslarsa — pozisyon artik kapali oldugu icin reconcile() de
   * engellemez — ayni mumda ikinci kez girilir.
   */
  it('yeniden baslatmalar arasinda KORUNUR', () => {
    const s = emptyState(utcDay(T), 1000);
    s.lastBar = { SOLUSDT: 1788400000000, BTCUSDT: 1788396400000 };
    saveState(s);
    const geri = loadState(T, 1000);
    expect(geri.lastBar?.SOLUSDT).toBe(1788400000000);
    expect(geri.lastBar?.BTCUSDT).toBe(1788396400000);
  });

  it('GUN DONSE BILE korunur — mum kimligi gunden bagimsiz', () => {
    const s = emptyState('2026-09-01', 1000);
    s.lastBar = { SOLUSDT: 1788400000000 };
    saveState(s);
    const geri = loadState(T, 900);
    expect(geri.day).toBe('2026-09-02');
    expect(geri.trades).toBe(0);
    expect(geri.lastBar?.SOLUSDT).toBe(1788400000000);
  });

  it('temiz durumda bostur', () => {
    expect(emptyState(utcDay(T), 1000).lastBar).toEqual({});
  });

  it('ESKI surumden kalan, lastBar alani olmayan dosya cokme yaratmaz', () => {
    const eski: any = emptyState(utcDay(T), 1000);
    delete eski.lastBar;
    fs.writeFileSync(FILE, JSON.stringify(eski));
    expect(loadState(T, 1000).lastBar).toEqual({});
  });
});
