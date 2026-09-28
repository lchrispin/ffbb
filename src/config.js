// Tunables and roster data. Distances are in metres, times in seconds.

export const SPHERE_R = 30;          // radius of the sphere pool
export const PLAYER_MARGIN = 1.1;    // how close to the wall a swimmer's centre may get
export const BALL_R = 0.34;

// Goals sit just inside the wall on the x axis. Team 0 defends -x, team 1 defends +x.
export const GOAL_INSET = 1.6;
export const GOAL_RING_R = 3.6;
export const GOAL_X = SPHERE_R - GOAL_INSET;

// Pace. Everything runs at about half the speed of an arcade sports game, so a pass
// or shot can be watched in flight and there's time to read the play.
export const SWIM_BASE = 2.3;        // top speed is SWIM_BASE + SP * SWIM_PER_SP
export const SWIM_PER_SP = 0.18;
export const PASS_SPEED = 10.5;
export const SHOT_SPEED = 12;
export const PASS_DECAY = 0.6;       // pass power lost per metre
export const LAUNCH_SPEED = 12;      // kickoff launch from the floor
export const CATCH_DIST = 1.35;
export const PICKUP_DIST = 1.25;
export const TACKLE_RANGE = 2.0;
export const TACKLE_COOLDOWN = 2.0;
export const AI_TEMPO = 1.4;         // scales how often the AI makes decisions

// Encounters: a defender whose radius touches the human's carrier opens the command
// wheel in slow motion. Cooldowns are in game seconds; the wheel timer is real time.
export const ENCOUNTER = { base: 2.5, perAT: 0.08, repeatCd: 6, globalCd: 3.5, commandCd: 0.6, wheelTime: 3 };
export const SLOW = { wheel: 0.15, shot: 0.4, aiShot: 0.45, aiTackle: 0.35, overview: 0.3 };
export const VENOM = { dps: 4, time: 9, cost: 8 };      // Venom Tackle: HP per second, seconds, HP it costs the user
export const HOLD = { time: 3, reach: 1.8 };            // Hold: seconds, extra block reach

// Shot power vs keeper grip. A shot starts at SH * SHOT_MULT + SHOT_BASE, loses
// SHOT_DECAY per metre travelled and more to every defender who gets a touch.
// The keeper holds it if their grip (CA * GRIP_MULT * random in GRIP_SPREAD) is higher.
export const SHOT_MULT = 8;
export const SHOT_BASE = 20;
export const SHOT_DECAY = 1.5;
export const SPECIAL_MULT = 1.5;
export const GRIP_MULT = 9;
export const GRIP_SPREAD = [0.85, 1.35];

export const DIFFICULTY = {
  easy:   { label: 'Rookie',  aiStat: 0.82, react: 0.45, aggression: 0.55 },
  normal: { label: 'League',  aiStat: 1.0,  react: 0.28, aggression: 0.8 },
  hard:   { label: 'Champion', aiStat: 1.15, react: 0.14, aggression: 1.0 },
};

export const MATCH_LENGTHS = [
  { id: 'short', label: '2 × 2 min', half: 120 },
  { id: 'std', label: '2 × 3 min', half: 180 },
  { id: 'long', label: '2 × 5 min', half: 300 },
];

// Formation presets, written from the point of view of a team attacking +x.
// x: along the pitch, y: up, z: across (left is +z). `push` and `drop` shift the
// shape up or back with possession; `pressers` overrides how many chase the carrier.
const GK_SPOT = [-SPHERE_R + 3.4, 0, 0];
export const FORMATIONS = {
  balanced: {
    id: 'balanced', label: 'Balanced', blurb: 'Two up, two back, midfield free',
    spots: { GK: GK_SPOT, LD: [-15, 3, 8], RD: [-15, -3, -8], MF: [-3, 0, 0], LF: [9, 4, 9], RF: [9, -4, -9] },
    push: 8, drop: 5, pressers: null,
  },
  attack: {
    id: 'attack', label: 'Attack', blurb: 'High line, two press the carrier',
    spots: { GK: GK_SPOT, LD: [-9, 3, 9], RD: [-9, -3, -9], MF: [3, 0, 0], LF: [13, 4, 8], RF: [13, -4, -8] },
    push: 9, drop: 3, pressers: 2,
  },
  wall: {
    id: 'wall', label: 'Wall', blurb: 'Deep block in front of the keeper',
    spots: { GK: GK_SPOT, LD: [-19, 2, 6], RD: [-19, -2, -6], MF: [-11, 0, 0], LF: [2, 4, 9], RF: [2, -4, -9] },
    push: 6, drop: 6, pressers: 1,
  },
};

// Which opponent each defender picks up when the other side has the ball.
export const DEFAULT_MARKS = { LD: 'RF', RD: 'LF', MF: 'MF' };

export const ROLES = ['LF', 'RF', 'MF', 'LD', 'RD', 'GK'];

// Stats follow the eight Blitzball attributes from the original game:
// HP (stamina pool), SP speed, EN endurance, AT attack (tackling),
// PA pass, BL block, SH shot, CA catch. Scale is roughly 1-20.
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
  },
};

// Mirrors a formation-space vector for the team attacking -x.
export function sideSign(team) {
  return team === 0 ? 1 : -1;
}
