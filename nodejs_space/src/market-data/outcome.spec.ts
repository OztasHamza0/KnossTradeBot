import { judgeOutcome, rMultiple, summarize } from './outcome';
import { Candle } from './indicators';

const c = (high: number, low: number, close = (high + low) / 2): Candle => ({
  high,
  low,
  close,
});

describe('judgeOutcome — LONG', () => {
  // entry 100, stop 95, hedef 110
  const stop = 95;
  const target = 110;

  it('stays open while price sits between stop and target', () => {
    const v = judgeOutcome('LONG', stop, target, [c(105, 98), c(107, 101)]);
    expect(v.status).toBe('open');
  });

  it('reports a target hit', () => {
    const v = judgeOutcome('LONG', stop, target, [c(105, 98), c(112, 106)]);
    expect(v.status).toBe('tp');
    expect(v.price).toBe(target);
  });

  it('reports a stop hit', () => {
    const v = judgeOutcome('LONG', stop, target, [c(105, 98), c(102, 94)]);
    expect(v.status).toBe('sl');
    expect(v.price).toBe(stop);
  });

  // Anlik fiyata bakmak yetmezdi: fiyat once stopa dokunup sonra hedefe
  // gitmis olabilir ve o islem zararla kapanmistir.
  it('takes the stop when it came first, even if the target came later', () => {
    const v = judgeOutcome('LONG', stop, target, [
      c(102, 94), // once stop
      c(115, 108), // sonra hedef
    ]);
    expect(v.status).toBe('sl');
  });

  it('takes the target when it came first', () => {
    const v = judgeOutcome('LONG', stop, target, [
      c(115, 108), // once hedef
      c(102, 94), // sonra stop
    ]);
    expect(v.status).toBe('tp');
  });

  // Ayni mumda ikisi de gorulduyse sira bilinemez. Kendi performansini
  // oldugundan iyi gostermek, yanlis bir stratejiyi surdurmenin en kolay yolu.
  it('assumes the stop when one candle spans both and says so', () => {
    const v = judgeOutcome('LONG', stop, target, [c(115, 90)]);
    expect(v.status).toBe('sl');
    expect(v.note).toContain('Karamsar varsayım');
  });
});

describe('judgeOutcome — SHORT', () => {
  // entry 100, stop 105, hedef 90
  const stop = 105;
  const target = 90;

  it('reports a target hit when price falls to it', () => {
    const v = judgeOutcome('SHORT', stop, target, [c(102, 98), c(99, 88)]);
    expect(v.status).toBe('tp');
  });

  it('reports a stop hit when price rises to it', () => {
    const v = judgeOutcome('SHORT', stop, target, [c(102, 98), c(107, 101)]);
    expect(v.status).toBe('sl');
  });

  it('stays open in between', () => {
    expect(judgeOutcome('SHORT', stop, target, [c(102, 96)]).status).toBe(
      'open',
    );
  });

  it('assumes the stop when one candle spans both', () => {
    expect(judgeOutcome('SHORT', stop, target, [c(110, 85)]).status).toBe('sl');
  });
});

describe('rMultiple', () => {
  it('is -1 on a stop', () => {
    expect(rMultiple(100, 95, 110, 'sl')).toBe(-1);
  });

  it('is the reward-to-risk ratio on a target', () => {
    expect(rMultiple(100, 95, 110, 'tp')).toBeCloseTo(2);
  });

  it('is null while the trade is open', () => {
    expect(rMultiple(100, 95, 110, 'open')).toBeNull();
  });

  it('is null when risk is zero', () => {
    expect(rMultiple(100, 100, 110, 'tp')).toBeNull();
  });

  it('works for a short', () => {
    expect(rMultiple(100, 104, 92, 'tp')).toBeCloseTo(2);
  });
});

describe('summarize', () => {
  it('counts each status', () => {
    const s = summarize([
      { status: 'tp', rMultiple: 2 },
      { status: 'sl', rMultiple: -1 },
      { status: 'tp', rMultiple: 1.5 },
      { status: 'open', rMultiple: null },
      { status: 'expired', rMultiple: null },
    ]);
    expect(s.total).toBe(5);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.open).toBe(1);
    expect(s.expired).toBe(1);
  });

  it('computes the win rate over closed trades only', () => {
    const s = summarize([
      { status: 'tp', rMultiple: 2 },
      { status: 'sl', rMultiple: -1 },
      { status: 'open', rMultiple: null },
    ]);
    expect(s.winRatePct).toBeCloseTo(50);
  });

  // Isabet orani tek basina yaniltici: yuksek isabetle de para kaybedilebilir.
  it('shows a losing strategy despite a high hit rate', () => {
    const s = summarize([
      { status: 'tp', rMultiple: 0.2 },
      { status: 'tp', rMultiple: 0.2 },
      { status: 'tp', rMultiple: 0.2 },
      { status: 'sl', rMultiple: -1 },
    ]);
    expect(s.winRatePct).toBeCloseTo(75);
    expect(s.totalR).toBeCloseTo(-0.4);
  });

  it('shows a winning strategy despite a low hit rate', () => {
    const s = summarize([
      { status: 'sl', rMultiple: -1 },
      { status: 'sl', rMultiple: -1 },
      { status: 'tp', rMultiple: 4 },
    ]);
    expect(s.winRatePct).toBeCloseTo(33.3, 0);
    expect(s.totalR).toBeCloseTo(2);
  });

  it('reports no win rate when nothing has closed', () => {
    const s = summarize([{ status: 'open', rMultiple: null }]);
    expect(s.winRatePct).toBeNull();
    expect(s.avgR).toBeNull();
  });
});
