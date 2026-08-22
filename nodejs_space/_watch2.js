const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let prev = (await p.user_state.findFirst())?.last_scan_at?.getTime() ?? 0;
  const ticks = [];
  console.log('ardisik tik izleniyor (3 tik bekleniyor)...');
  for (let i = 0; i < 60 && ticks.length < 3; i++) {
    await sleep(20000);
    const cur = (await p.user_state.findFirst())?.last_scan_at?.getTime() ?? 0;
    if (cur > prev) {
      const gap = prev ? ((cur - prev) / 60000).toFixed(1) : '-';
      ticks.push(gap);
      console.log('tik', ticks.length, '->', new Date(cur).toISOString(), '| onceki tikten fark:', gap, 'dk');
      prev = cur;
    }
  }
  const sig = await p.sent_signals.count();
  console.log('toplam sinyal:', sig);
  await p.$disconnect();
})().catch(async (e) => { console.error('HATA:', e.message); await p.$disconnect(); process.exit(1); });
