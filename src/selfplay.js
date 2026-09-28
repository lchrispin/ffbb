import { DIFFICULTY, ASSIST, aiTactics, defaultTactics, cloneTactics } from './config.js';
import { Match } from './match.js';
import { planTeam } from './ai.js';

// Plays whole matches with the planner on both sides and no rendering, for balance checks.
// window.ffbb.simulate() wraps this.
export function simulateMatch({
  teamIds = ['aurochs', 'goers'], difficulty = ['normal', 'normal'], beats = 18, seed, tactics,
} = {}) {
  // 'assist' is the auto-planner that fills in the human side's orders, with default tactics.
  const profs = difficulty.map((d) => (d === 'assist' ? { ...ASSIST, aiStat: 1 } : DIFFICULTY[d]));
  const tacs = tactics ? tactics.map(cloneTactics) : difficulty.map((d) => (d === 'assist' ? defaultTactics() : aiTactics(d)));
  const m = new Match({
    teamIds, statScales: profs.map((p) => p.aiStat), beatsPerHalf: beats, tactics: tacs, seed, record: false,
  });
  const events = {};
  for (;;) {
    if (m.phase === 'halftime') m.startSecondHalf();
    if (m.phase === 'fulltime') break;
    const orders = [0, 1].map((t) => planTeam(m, t, m.tactics[t], profs[t]));
    const rec = m.resolveBeat(orders);
    for (const e of rec.events) events[e.type] = (events[e.type] || 0) + 1;
  }
  return { score: m.score, stats: m.stats, events, seed: m.seed };
}

// Summarises many matches: totals per match and a side-by-side split.
export function simulateMany(n = 6, opts = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    // Swap which side each club plays on every other match to expose side bias.
    const swap = opts.alternate !== false && i % 2 === 1;
    const teamIds = opts.teamIds || ['aurochs', 'goers'];
    const r = simulateMatch({ ...opts, teamIds: swap ? [...teamIds].reverse() : teamIds, seed: (opts.seed ?? 1000) + i * 7919 });
    rows.push({
      teams: swap ? [...teamIds].reverse() : teamIds,
      score: r.score,
      goals: r.score[0] + r.score[1],
      shots: r.stats[0].shots + r.stats[1].shots,
      onTarget: r.stats[0].onTarget + r.stats[1].onTarget,
      saves: r.stats[0].saves + r.stats[1].saves,
      blocks: r.stats[0].blocks + r.stats[1].blocks,
      intercepts: r.stats[0].intercepts + r.stats[1].intercepts,
      tackles: r.stats[0].tackles + r.stats[1].tackles,
      passes: r.stats[0].passes + r.stats[1].passes,
      passAtt: r.stats[0].passAtt + r.stats[1].passAtt,
      wide: r.stats[0].wide + r.stats[1].wide,
      deflects: r.stats[0].deflects + r.stats[1].deflects,
      side: r.stats.map((s) => ({ goals: s.goals, shots: s.shots, poss: Math.round(s.possession) })),
    });
  }
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  const avg = {};
  for (const k of ['goals', 'shots', 'onTarget', 'saves', 'blocks', 'deflects', 'intercepts', 'tackles', 'passes', 'passAtt', 'wide']) avg[k] = +(sum(k) / n).toFixed(2);
  const sideGoals = [0, 1].map((s) => rows.reduce((a, r) => a + r.side[s].goals, 0));
  const sideShots = [0, 1].map((s) => rows.reduce((a, r) => a + r.side[s].shots, 0));
  const sidePoss = [0, 1].map((s) => rows.reduce((a, r) => a + r.side[s].poss, 0));
  return { rows, avg, sideGoals, sideShots, sidePoss };
}
