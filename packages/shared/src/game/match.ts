import { ARENA, BALL, BOOST_PAD, CAR, DT, MATCH, type Team } from '../constants.js';
import { BOOST_PADS } from '../arena/boostpads.js';
import { predictBall, stepBall } from '../physics/ball.js';
import { stepCar } from '../physics/car.js';
import { collideCarBall, collideCars, tickBumpCooldowns } from '../physics/collisions.js';
import { vdist, vlen, v3, type Vec3 } from '../math/vec.js';
import {
  createBall,
  createCar,
  emptyInput,
  type CarState,
  type ControllerInput,
  type GameState,
} from './state.js';
import {
  KICKOFF_SPOTS_BLUE,
  RESPAWN_SPOTS_BLUE,
  mirrorSpawn,
  pickKickoffSpots,
  spawnQuat,
  type Spawn,
} from './kickoff.js';

export type GameEvent =
  | { type: 'ballHit'; carId: number; strength: number; pos: Vec3 }
  | { type: 'ballBounce'; speed: number; pos: Vec3 }
  | { type: 'goal'; team: Team; scorerId: number; assistId: number; speed: number; pos: Vec3 }
  | { type: 'demo'; attacker: number; victim: number; pos: Vec3 }
  | { type: 'bump'; attacker: number; victim: number }
  | { type: 'boostPickup'; carId: number; pad: number; big: boolean }
  | { type: 'jump'; carId: number }
  | { type: 'doubleJump'; carId: number }
  | { type: 'flip'; carId: number }
  | { type: 'land'; carId: number }
  | { type: 'carWallHit'; carId: number; strength: number }
  | { type: 'countdown'; value: number }
  | { type: 'kickoffReset' }
  | { type: 'overtime' }
  | { type: 'matchEnd'; winner: Team }
  | { type: 'shot'; carId: number }
  | { type: 'save'; carId: number }
  | { type: 'respawn'; carId: number };

export type InputSource = (car: CarState) => ControllerInput;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export function addCar(state: GameState, id: number, team: Team, name: string, isBot = false): CarState {
  const car = createCar(id, team, name, isBot);
  state.cars.push(car);
  state.cars.sort((a, b) => a.id - b.id);
  placeAtSpawn(car, freeRespawnSpot(state, car));
  return car;
}

export function removeCar(state: GameState, id: number): void {
  state.cars = state.cars.filter((c) => c.id !== id);
}

function placeAtSpawn(car: CarState, s: Spawn): void {
  car.pos = { ...s.pos };
  car.quat = spawnQuat(s);
  car.vel = v3();
  car.angVel = v3();
  car.onGround = true;
  car.isJumping = false;
  car.hasJumped = false;
  car.hasDoubleJumped = false;
  car.hasFlipped = false;
  car.isFlipping = false;
  car.isSupersonic = false;
  car.boostingTime = 0;
  car.lastInput = emptyInput();
}

function freeRespawnSpot(state: GameState, car: CarState): Spawn {
  const spots = RESPAWN_SPOTS_BLUE.map((s) => mirrorSpawn(s, car.team));
  for (const s of spots) {
    if (state.cars.every((c) => c === car || c.demolished || vdist(c.pos, s.pos) > 250)) return s;
  }
  return spots[car.id % spots.length];
}

/** Puts every car on its kickoff spot, resets the ball and starts the 3-2-1 countdown. */
export function resetKickoff(state: GameState): void {
  const perTeam: [CarState[], CarState[]] = [[], []];
  for (const c of state.cars) perTeam[c.team].push(c);
  const count = Math.max(perTeam[0].length, perTeam[1].length);
  const pick = pickKickoffSpots(Math.min(count, 5), state.rngSeed);
  state.rngSeed = pick.seed;
  for (const team of [0, 1] as const) {
    perTeam[team].forEach((car, i) => {
      const spotIndex = pick.spots[i] ?? (i % KICKOFF_SPOTS_BLUE.length);
      const spawn = mirrorSpawn(KICKOFF_SPOTS_BLUE[spotIndex], team);
      placeAtSpawn(car, spawn);
      car.demolished = false;
      car.respawnTimer = 0;
      car.boost = CAR.BOOST_START;
    });
  }
  state.ball = createBall();
  state.pads = state.pads.map(() => 0);
  state.phase = 'countdown';
  state.phaseTimer = MATCH.COUNTDOWN;
  state.clockRunning = false;
  state.lastTouches = [];
  state.ballGoalPrediction = 0;
}

/** Resets the score/clock and starts a fresh match. */
export function startMatch(state: GameState, duration: number = MATCH.DURATION): void {
  state.score = [0, 0];
  state.clock = duration;
  state.overtime = false;
  state.waitingForBallGround = false;
  state.winner = -1;
  state.lastGoal = null;
  for (const c of state.cars) {
    c.stats = { score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0 };
  }
  if (state.freeplay) {
    state.phase = 'freeplay';
    state.ball = createBall();
    for (const c of state.cars) placeAtSpawn(c, mirrorSpawn(KICKOFF_SPOTS_BLUE[4], c.team));
  } else {
    resetKickoff(state);
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

const GOAL_LINE = ARENA.HALF_LENGTH + BALL.RADIUS;

/** Which goal (+1 orange / -1 blue / 0 none) the ball would enter within `seconds`. */
export function predictGoal(state: GameState, seconds = 3): number {
  const path = predictBall(state.ball, seconds, DT, 2);
  for (const p of path) {
    if (p.pos.y > GOAL_LINE) return 1;
    if (p.pos.y < -GOAL_LINE) return -1;
  }
  return 0;
}

/** Advances the game by one physics tick (1/120 s). Mutates `state` and returns the events. */
export function stepGame(state: GameState, getInput: InputSource): GameEvent[] {
  const events: GameEvent[] = [];
  const dt = DT;
  state.tick++;
  state.time += dt;

  // ------------------------------------------------------------ phases
  if (state.phase === 'countdown') {
    const before = Math.ceil(state.phaseTimer);
    state.phaseTimer -= dt;
    const after = Math.ceil(state.phaseTimer);
    if (after !== before) events.push({ type: 'countdown', value: Math.max(after, 0) });
    if (state.phaseTimer <= 0) state.phase = 'playing';
  } else if (state.phase === 'goal') {
    state.phaseTimer -= dt;
    if (state.phaseTimer <= 0) afterGoal(state, events);
  }

  const frozen = state.phase === 'countdown';
  const ballActive = state.phase === 'playing' || state.phase === 'freeplay' || state.phase === 'countdown';

  // -------------------------------------------------------------- cars
  for (const car of state.cars) {
    tickBumpCooldowns(car, dt);
    if (car.demolished) {
      car.respawnTimer -= dt;
      if (car.respawnTimer <= 0) {
        car.demolished = false;
        car.boost = CAR.BOOST_START;
        placeAtSpawn(car, freeRespawnSpot(state, car));
        events.push({ type: 'respawn', carId: car.id });
      }
      continue;
    }
    const ev = stepCar(car, getInput(car), dt, state.unlimitedBoost, frozen);
    if (ev.jumped) events.push({ type: 'jump', carId: car.id });
    if (ev.doubleJumped) events.push({ type: 'doubleJump', carId: car.id });
    if (ev.flipped) events.push({ type: 'flip', carId: car.id });
    if (ev.landed) events.push({ type: 'land', carId: car.id });
    if (ev.wallHit) events.push({ type: 'carWallHit', carId: car.id, strength: ev.wallHit });
  }

  // -------------------------------------------------------------- ball
  if (ballActive && state.phase !== 'countdown') {
    const impact = stepBall(state.ball, dt);
    if (impact > 250) events.push({ type: 'ballBounce', speed: impact, pos: { ...state.ball.pos } });
  }

  // ------------------------------------------------------- car vs ball
  if (ballActive && !frozen) {
    for (const car of state.cars) {
      const goalPredBefore = state.ballGoalPrediction;
      const hit = collideCarBall(car, state.ball, state.tick);
      if (!hit) continue;
      if (!hit.fresh) continue;
      events.push({ type: 'ballHit', carId: car.id, strength: hit.strength, pos: { ...state.ball.pos } });
      registerTouch(state, car, goalPredBefore, events);
    }
  }

  // -------------------------------------------------------- car vs car
  for (let i = 0; i < state.cars.length; i++) {
    for (let j = i + 1; j < state.cars.length; j++) {
      const a = state.cars[i];
      const b = state.cars[j];
      const r = collideCars(a, b);
      if (!r) continue;
      if (r.bump) events.push({ type: 'bump', ...r.bump });
      if (r.demo) {
        const victim = r.demo.victim === a.id ? a : b;
        const attacker = victim === a ? b : a;
        victim.demolished = true;
        victim.respawnTimer = CAR.DEMO_RESPAWN_TIME;
        attacker.stats.demos++;
        attacker.stats.score += MATCH.POINTS_DEMO;
        events.push({ type: 'demo', ...r.demo, pos: { ...victim.pos } });
      }
    }
  }

  // ------------------------------------------------------- boost pads
  for (let i = 0; i < BOOST_PADS.length; i++) {
    if (state.pads[i] > 0) {
      state.pads[i] = Math.max(0, state.pads[i] - dt);
      continue;
    }
    const pad = BOOST_PADS[i];
    const radius = pad.big ? BOOST_PAD.BIG_RADIUS : BOOST_PAD.SMALL_RADIUS;
    const height = pad.big ? BOOST_PAD.BIG_HEIGHT : BOOST_PAD.SMALL_HEIGHT;
    for (const car of state.cars) {
      if (car.demolished || car.boost >= CAR.BOOST_MAX) continue;
      const dx = car.pos.x - pad.x;
      const dy = car.pos.y - pad.y;
      if (dx * dx + dy * dy > radius * radius || car.pos.z > height) continue;
      car.boost = Math.min(CAR.BOOST_MAX, car.boost + (pad.big ? BOOST_PAD.BIG_AMOUNT : BOOST_PAD.SMALL_AMOUNT));
      state.pads[i] = pad.big ? BOOST_PAD.BIG_RESPAWN : BOOST_PAD.SMALL_RESPAWN;
      events.push({ type: 'boostPickup', carId: car.id, pad: i, big: pad.big });
      break;
    }
  }

  // ------------------------------------------------------------ goals
  if (state.phase === 'playing' || state.phase === 'freeplay') {
    const side = state.ball.pos.y > GOAL_LINE ? 1 : state.ball.pos.y < -GOAL_LINE ? -1 : 0;
    if (side !== 0) scoreGoal(state, side === 1 ? 0 : 1, events);
  }

  // ------------------------------------------------------------ clock
  if (state.phase === 'playing' && !state.freeplay) {
    if (state.clockRunning) {
      if (state.overtime) state.clock += dt;
      else if (state.clock > 0) {
        state.clock = Math.max(0, state.clock - dt);
        if (state.clock === 0) state.waitingForBallGround = true;
      }
    }
    if (state.waitingForBallGround && state.ball.pos.z <= BALL.RADIUS + 2) {
      state.waitingForBallGround = false;
      endOfRegulation(state, events);
    }
  }

  return events;
}

function registerTouch(state: GameState, car: CarState, goalPredBefore: number, events: GameEvent[]): void {
  car.stats.touches++;
  car.stats.score += MATCH.POINTS_TOUCH;
  state.lastTouches.push({ carId: car.id, team: car.team, time: state.time });
  if (state.lastTouches.length > 8) state.lastTouches.shift();
  if (state.phase === 'playing' && !state.clockRunning) state.clockRunning = true;
  if (state.freeplay) return;

  const attackSide = car.team === 0 ? 1 : -1;
  const pred = predictGoal(state);
  if (goalPredBefore === -attackSide && pred !== -attackSide) {
    car.stats.saves++;
    car.stats.score += MATCH.POINTS_SAVE;
    events.push({ type: 'save', carId: car.id });
  }
  if (pred === attackSide && goalPredBefore !== attackSide) {
    car.stats.shots++;
    car.stats.score += MATCH.POINTS_SHOT;
    events.push({ type: 'shot', carId: car.id });
  }
  state.ballGoalPrediction = pred;
}

function scoreGoal(state: GameState, team: Team, events: GameEvent[]): void {
  const touches = state.lastTouches;
  let scorerId = -1;
  let assistId = -1;
  for (let i = touches.length - 1; i >= 0; i--) {
    if (touches[i].team === team) {
      scorerId = touches[i].carId;
      const scorerTime = touches[i].time;
      for (let j = i - 1; j >= 0; j--) {
        if (touches[j].team !== team) break;
        if (touches[j].carId !== scorerId && scorerTime - touches[j].time <= MATCH.ASSIST_WINDOW) {
          assistId = touches[j].carId;
          break;
        }
      }
      break;
    }
  }
  const speed = vlen(state.ball.vel);
  const pos = { ...state.ball.pos };
  if (!state.freeplay) {
    state.score[team]++;
    const scorer = state.cars.find((c) => c.id === scorerId);
    if (scorer) {
      scorer.stats.goals++;
      scorer.stats.score += MATCH.POINTS_GOAL;
    }
    const assister = state.cars.find((c) => c.id === assistId);
    if (assister) {
      assister.stats.assists++;
      assister.stats.score += MATCH.POINTS_ASSIST;
    }
  }
  state.lastGoal = { team, scorerId, assistId, speed };
  state.phase = 'goal';
  state.phaseTimer = MATCH.GOAL_CELEBRATION;
  state.ball.vel = v3();
  state.ball.angVel = v3();
  events.push({ type: 'goal', team, scorerId, assistId, speed, pos });
}

function afterGoal(state: GameState, events: GameEvent[]): void {
  if (state.freeplay) {
    state.ball = createBall();
    state.phase = 'freeplay';
    return;
  }
  if (state.overtime) {
    endMatch(state, events);
    return;
  }
  if (state.clock <= 0) {
    state.waitingForBallGround = false;
    endOfRegulation(state, events);
    return;
  }
  resetKickoff(state);
  events.push({ type: 'kickoffReset' });
}

function endOfRegulation(state: GameState, events: GameEvent[]): void {
  if (state.score[0] !== state.score[1]) {
    endMatch(state, events);
    return;
  }
  state.overtime = true;
  state.clock = 0;
  resetKickoff(state);
  events.push({ type: 'overtime' }, { type: 'kickoffReset' });
}

function endMatch(state: GameState, events: GameEvent[]): void {
  state.phase = 'ended';
  state.winner = state.score[0] > state.score[1] ? 0 : 1;
  state.phaseTimer = MATCH.END_DELAY;
  events.push({ type: 'matchEnd', winner: state.winner });
}
