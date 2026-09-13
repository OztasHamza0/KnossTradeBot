import * as fs from 'fs';
import * as os from 'os';
import * as pathmod from 'path';

// Testler CANLI kilidi ezmemeli: gercek bir bot kosuyorsa onun kilidini
// silmek, ikinci bir botun baslamasina izin vermek demektir.
process.env.BOT_LOCK_FILE = pathmod.join(
  os.tmpdir(),
  `bot-lock-test-${process.pid}.json`,
);
import { acquireLock, releaseLock, lockFilePath, LockInfo } from './lock';

const FILE = lockFilePath();
const temizle = () => { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); };
beforeEach(temizle);
afterAll(temizle);

const yaz = (info: Partial<LockInfo>) =>
  fs.writeFileSync(FILE, JSON.stringify({ pid: 1, at: Date.now(), argv: '', ...info }));

describe('tek kopya kilidi', () => {
  it('bos zeminde kilit alinir', () => {
    const r = acquireLock();
    expect(r.ok).toBe(true);
    expect(fs.existsSync(FILE)).toBe(true);
  });

  it('YASAYAN bir surec kilidi tutuyorsa REDDEDER', () => {
    // Asil mesele bu: ikinci bot baslayamamali. Kendi PID'imiz kesinlikle
    // yasiyor, ama acquireLock kendi PID'ini "sahip" saymaz diye baska
    // bir yasayan PID gerekiyor -- process.ppid (bizi baslatan surec).
    const canli = process.ppid && process.ppid !== process.pid ? process.ppid : process.pid;
    if (canli === process.pid) return; // ppid yoksa test anlamsiz, atla
    yaz({ pid: canli, argv: 'onceki bot' });
    const r = acquireLock();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.sahip.argv).toBe('onceki bot');
  });

  it('OLMUS bir surecin kilidi devralinir (bayat kilit botu kilitlemez)', () => {
    // Bot cokerse kilit dosyasi kalir. Yalnizca dosyanin varligina
    // bakilsaydi, bir cokme botu kalici olarak baslatilamaz yapardi.
    yaz({ pid: 999_999_999 }); // var olmayan PID
    const r = acquireLock();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bayatAlindi).toBe(true);
  });

  it('BOZUK kilit dosyasi bayat sayilir', () => {
    fs.writeFileSync(FILE, '{ bozuk');
    const r = acquireLock();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bayatAlindi).toBe(true);
  });

  it('kilit BIZIMSE birakilir', () => {
    acquireLock();
    releaseLock();
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it('kilit BASKASININSA BIRAKILMAZ', () => {
    // Bayat kilidi devralan baska bir surec varsa, bizim cikisimiz
    // ONUN kilidini silmemeli.
    yaz({ pid: 999_999_999, argv: 'baskasi' });
    releaseLock();
    expect(fs.existsSync(FILE)).toBe(true);
  });
});
