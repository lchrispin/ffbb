// Tunables and roster data. Distances are in metres, times in seconds.

export const SPHERE_R = 30;          // radius of the sphere pool
export const PLAYER_MARGIN = 1.1;    // how close to the wall a swimmer's centre may get
export const BALL_R = 0.34;

// Goals sit just inside the wall on the x axis. Team 0 defends -x, team 1 defends +x.
export const GOAL_INSET = 1.6;
export const GOAL_RING_R = 3.6;
export const GOAL_X = SPHERE_R - GOAL_INSET;

// ---------- turn structure ----------
// Every beat resolves BEAT seconds of simulated time in TICK steps.
export const BEAT = 2.0;
export const TICK = 1 / 30;
export const KICKOFF_LAUNCH = 0.3;   // seconds into the kickoff beat when the ball leaves the floor
export const LEG_CAP = 0.7;          // share of the beat a dribble may take before an "after the dribble" release

// ---------- movement ----------
// Swim speed is SPEED_BASE + SP * SPEED_SP metres per second; reach is that times BEAT.
export const SPEED_BASE = 3.6;
export const SPEED_SP = 0.3;
export const SPRINT_MULT = 1.35;
export const CARRY_MULT = 0.85;
export const MARKED_MULT = 0.8;      // a carrier with a defender on them swims slower
export const TIRED_AT = 0.4;         // below this share of HP reach and duel stats start to drop

// Stamina per second: sprinting and carrying drain it, holding position restores it.
export const HP_SPRINT = 9;
export const HP_CARRY = 0.5;         // per metre-per-second of carrying speed
export const HP_REST = 2.5;
export const HP_HOLD = [3, 0.35];    // base + EN * k while holding

// ---------- ball ----------
export const PASS_SPEED = 21;
export const SHOT_SPEED = 24;
export const CATCH_DIST = 1.4;
export const PICKUP_DIST = 1.3;
export const REFLEX_DIST = 4;        // anyone this close to a loose ball goes for it, whatever their order
export const TACKLE_RANGE = 2.0;
export const TACKLE_BASE = 0.32;      // tackle chance with AT equal to EN; each point of difference is 5%

// Zones of control: every swimmer has an encounter radius from BL, larger when bracing.
export const ZOC_BASE = 1.1;
export const ZOC_BL = 0.06;
export const BRACE_MULT = 1.6;
export const BRACE_CUT = 1.4;         // a braced defender also cuts harder
// Defenders this far outside a ball's line lunge across it while it is in flight.
export const LUNGE_REACH = 1.6;
export const LUNGE_REACT = 0.1;

// Pass power is PA * PASS_MULT + PASS_BASE and fades PASS_DECAY per metre.
// Each defender whose zone it crosses cuts BL * PASS_CUT * random(CUT_SPREAD).
export const PASS_MULT = 6;
export const PASS_BASE = 10;
export const PASS_DECAY = 0.6;
export const PASS_CUT = 4;
export const CUT_SPREAD = [0.6, 1.3];

// Shot power vs keeper grip. A shot starts at SH * SHOT_MULT + SHOT_BASE, loses
// SHOT_DECAY per metre and more to every defender whose zone it crosses (BL * SHOT_CUT).
// The keeper holds it if their grip (CA * GRIP_MULT * random in GRIP_SPREAD, less when
// stretched) is higher.
export const SHOT_MULT = 6;
export const SHOT_BASE = 40;
export const SHOT_DECAY = 0.8;
export const SHOT_CUT = 4.5;
export const SPECIAL_MULT = 1.5;
export const GRIP_MULT = 8.3;
export const GRIP_SPREAD = [0.6, 1.5];
// Keeper reach: catch radius from CA, a dive after a short reaction, and a grip
// penalty the further they had to stretch.
export const KEEPER_CATCH = [1.2, 0.05];
export const KEEPER_DIVE = 1.2;
export const KEEPER_REACT = 0.15;
export const STRETCH = [0.35, 3.5];  // up to 35% grip lost over a 3.5 m dive
export const FINGERTIP = 0.8;       // grip share left for a shot the keeper can't reach in time
// Aim wobble radius on the goal plane: (WOBBLE[0] - SH * WOBBLE[1]) * (WOBBLE[2] + dist / WOBBLE[3]).
export const WOBBLE = [2.4, 0.1, 0.35, 22];

// Jecht Shot meter gains.
export const OVERDRIVE = { pass: 0.03, tackle: 0.08, block: 0.08, save: 0.08 };

// Planner quality and stat scale per opponent difficulty. awareness is how well it
// reads defenders who could move into a lane; noise blurs its choices.
export const DIFFICULTY = {
  easy:   { label: 'Rookie',   aiStat: 0.9,  awareness: 0.3, noise: 0.12, smartPress: false },
  normal: { label: 'League',   aiStat: 1.0,  awareness: 0.7, noise: 0.05, smartPress: false },
  hard:   { label: 'Champion', aiStat: 1.06, awareness: 1.0, noise: 0.01, smartPress: true },
};
// The auto-planner that fills in the human side's orders.
export const ASSIST = { awareness: 1.0, noise: 0, smartPress: true };

export const MATCH_LENGTHS = [
  { id: 'short', label: 'Short · 2×12', beats: 12 },
  { id: 'std', label: 'Standard · 2×18', beats: 18 },
  { id: 'long', label: 'Long · 2×24', beats: 24 },
];

export const CHANGES_PER_HALF = 3;
export const SUBS_PER_MATCH = 2;

// Formation slots, in roster order.
export const SLOTS = ['LF', 'RF', 'MF', 'LD', 'RD', 'GK'];
export const SLOT_NAMES = { LF: 'Left forward', RF: 'Right forward', MF: 'Midfield', LD: 'Left defence', RD: 'Right defence', GK: 'Keeper' };

// Formation spots, written from the point of view of a team attacking +x.
// x: along the pitch, y: up, z: across (left is +z).
export const FORMATIONS = {
  balanced: {
    label: 'Balanced 1-2-1-2',
    base: { LF: [9, 4, 9], RF: [9, -4, -9], MF: [-3, 0, 0], LD: [-15, 3, 8], RD: [-15, -3, -8], GK: [-26.6, 0, 0] },
  },
  wall: {
    label: 'Wall',
    base: { LF: [2, 5, 8], RF: [2, -5, -8], MF: [-15, 0, 0], LD: [-17, 6, 7], RD: [-17, -6, -7], GK: [-26.6, 0, 0] },
  },
  diamond: {
    label: 'Diamond',
    base: { LF: [6, 7, 7], RF: [6, -7, -7], MF: [13, 0, 0], LD: [-9, 0, 0], RD: [-18, 0, 0], GK: [-26.6, 0, 0] },
  },
  overload: {
    label: 'Overload',
    base: { LF: [12, 5, 7], RF: [12, -5, -7], MF: [6, 0, 0], LD: [-2, 2, 10], RD: [-14, -2, -4], GK: [-26.6, 0, 0] },
  },
};

// Per-player roles the planner understands.
export const ROLES = {
  support: { label: 'Support', desc: 'Takes up the formation spot and finds space' },
  target:  { label: 'Target', desc: 'Stays high and central, holds the ball up (+2 EN on the ball)' },
  runner:  { label: 'Runner', desc: 'Makes forward runs beyond the last defender' },
  anchor:  { label: 'Anchor', desc: 'Sits in the lane in front of our goal and braces' },
  sweeper: { label: 'Sweeper', desc: 'Covers behind the defence and mops up loose balls' },
  keeper:  { label: 'Keeper', desc: 'Guards the ring' },
};

// Pressing intensity: how many go at the carrier and from how far.
export const PRESS = [
  { label: 'Low', count: 1, range: 8 },
  { label: 'Medium', count: 1, range: 13 },
  { label: 'High', count: 2, range: 17 },
  { label: 'Swarm', count: 3, range: 24 },
];

export const SHOOTING = {
  safe: { label: 'Good odds', weight: 1.25, min: 0.12 },
  balanced: { label: 'Balanced', weight: 1.65, min: 0.03 },
  speculative: { label: 'Speculative', weight: 2.1, min: 0.02 },
};

// Default team instructions. Marks map our slot to the opponent slot it picks up.
export function defaultTactics(formation = 'balanced') {
  return {
    formation,
    base: copyBase(FORMATIONS[formation].base),
    press: 1,
    depth: 0.5,
    width: 0.5,
    tempo: 0.5,
    shooting: 'balanced',
    roles: { LF: 'runner', RF: 'target', MF: 'support', LD: 'support', RD: 'support', GK: 'keeper' },
    marks: { LF: 'none', RF: 'none', MF: 'MF', LD: 'RF', RD: 'LF', GK: 'none' },
  };
}

export function copyBase(base) {
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = [...v];
  return out;
}

export function cloneTactics(t) {
  return { ...t, base: copyBase(t.base), roles: { ...t.roles }, marks: { ...t.marks } };
}

// The opponent's own tactics by difficulty.
export function aiTactics(difficulty) {
  if (difficulty === 'easy') {
    const t = defaultTactics('balanced');
    t.press = 0; t.shooting = 'speculative'; t.tempo = 0.4;
    t.roles = { LF: 'support', RF: 'support', MF: 'support', LD: 'support', RD: 'support', GK: 'keeper' };
    return t;
  }
  if (difficulty === 'hard') {
    const t = defaultTactics('diamond');
    t.press = 2; t.shooting = 'safe'; t.tempo = 0.65; t.depth = 0.55;
    t.roles = { LF: 'runner', RF: 'runner', MF: 'target', LD: 'anchor', RD: 'sweeper', GK: 'keeper' };
    t.marks = { LF: 'none', RF: 'none', MF: 'none', LD: 'MF', RD: 'none', GK: 'none' };
    return t;
  }
  return defaultTactics('balanced');
}

// Stats follow the eight Blitzball attributes from the original game:
// HP (stamina pool), SP speed, EN endurance, AT attack (tackling),
// PA pass, BL block, SH shot, CA catch. Scale is roughly 1-20.
// Botta is from the original Aurochs squad; the other bench players are invented.
export const TEAMS = {
  aurochs: {
    id: 'aurochs',
    name: 'Besaid Aurochs',
    short: 'AUR',
    color: 0xf3c42f,
    trim: 0x1c5fc7,
    skin: 0xe0ac7e,
    players: [
      { role: 'LF', name: 'Wakka',  num: 3,  HP: 110, SP: 10, EN: 8,  AT: 7,  PA: 9,  BL: 6,  SH: 11, CA: 5 },
      { role: 'RF', name: 'Datto',  num: 7,  HP: 95,  SP: 9,  EN: 6,  AT: 5,  PA: 7,  BL: 5,  SH: 8,  CA: 4 },
      { role: 'MF', name: 'Tidus',  num: 10, HP: 120, SP: 13, EN: 7,  AT: 6,  PA: 10, BL: 6,  SH: 13, CA: 5 },
      { role: 'LD', name: 'Letty',  num: 4,  HP: 100, SP: 8,  EN: 9,  AT: 9,  PA: 6,  BL: 9,  SH: 4,  CA: 5 },
      { role: 'RD', name: 'Jassu',  num: 5,  HP: 100, SP: 9,  EN: 8,  AT: 8,  PA: 6,  BL: 8,  SH: 4,  CA: 5 },
      { role: 'GK', name: 'Keepa',  num: 1,  HP: 140, SP: 6,  EN: 12, AT: 5,  PA: 7,  BL: 7,  SH: 3,  CA: 13 },
    ],
    bench: [
      { role: 'SUB', name: 'Botta',  num: 6,  HP: 95,  SP: 8,  EN: 7,  AT: 7,  PA: 6,  BL: 7,  SH: 6,  CA: 4 },
      { role: 'SUB', name: 'Lukka',  num: 12, HP: 100, SP: 11, EN: 6,  AT: 6,  PA: 8,  BL: 5,  SH: 9,  CA: 4 },
    ],
  },
  goers: {
    id: 'goers',
    name: 'Luca Goers',
    short: 'GOE',
    color: 0xd8413a,
    trim: 0xf2efe6,
    skin: 0xc8946a,
    players: [
      { role: 'LF', name: 'Bickson',  num: 9,  HP: 115, SP: 11, EN: 9,  AT: 9,  PA: 8,  BL: 6,  SH: 12, CA: 5 },
      { role: 'RF', name: 'Abus',     num: 11, HP: 110, SP: 10, EN: 8,  AT: 8,  PA: 8,  BL: 6,  SH: 10, CA: 5 },
      { role: 'MF', name: 'Doram',    num: 8,  HP: 110, SP: 10, EN: 8,  AT: 8,  PA: 11, BL: 7,  SH: 9,  CA: 6 },
      { role: 'LD', name: 'Balgerda', num: 6,  HP: 110, SP: 9,  EN: 10, AT: 10, PA: 6,  BL: 10, SH: 5,  CA: 6 },
      { role: 'RD', name: 'Graav',    num: 2,  HP: 110, SP: 9,  EN: 10, AT: 10, PA: 6,  BL: 9,  SH: 5,  CA: 6 },
      { role: 'GK', name: 'Raudy',    num: 1,  HP: 150, SP: 6,  EN: 13, AT: 6,  PA: 7,  BL: 8,  SH: 3,  CA: 14 },
    ],
    bench: [
      { role: 'SUB', name: 'Vorell',  num: 14, HP: 105, SP: 10, EN: 9,  AT: 9,  PA: 7,  BL: 8,  SH: 7,  CA: 5 },
      { role: 'SUB', name: 'Mezzo',   num: 17, HP: 100, SP: 12, EN: 7,  AT: 7,  PA: 9,  BL: 5,  SH: 10, CA: 5 },
    ],
  },
};

// Mirrors a formation-space vector for the team attacking -x.
export function sideSign(team) {
  return team === 0 ? 1 : -1;
}
