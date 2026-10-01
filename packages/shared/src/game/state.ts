import { BALL, CAR, MATCH, type Team } from '../constants.js';
import { qidentity, v3, type Quat, type Vec3 } from '../math/vec.js';
import { BOOST_PADS } from '../arena/boostpads.js';

/** Analog/digital controller state for one tick (RLBot conventions). */
export interface ControllerInput {
  /** -1 reverse .. 1 forward */
  throttle: number;
  /** -1 left .. 1 right */
  steer: number;
  /** -1 nose down (stick forward) .. 1 nose up */
  pitch: number;
  /** -1 left .. 1 right (air) */
  yaw: number;
  /** -1 roll left .. 1 roll right */
  roll: number;
  jump: boolean;
  boost: boolean;
  handbrake: boolean;
}

export const emptyInput = (): ControllerInput => ({
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
});

export interface CarStats {
  score: number;
  goals: number;
  assists: number;
  saves: number;
  shots: number;
  demos: number;
  touches: number;
}

export interface CarState {
  id: number;
  name: string;
  team: Team;
  isBot: boolean;

  pos: Vec3;
  quat: Quat;
  vel: Vec3;
  angVel: Vec3;

  boost: number;
  onGround: boolean;
  /** ticks since the car was last on the ground (used for coyote-time jumps) */
  airTicks: number;
  wheelContacts: number;
  hasJumped: boolean;
  isJumping: boolean;
  jumpTime: number;
  hasDoubleJumped: boolean;
  hasFlipped: boolean;
  isFlipping: boolean;
  flipTime: number;
  flipDirX: number;
  flipDirY: number;
  /** time spent in the air since the first jump finished (double-jump window) */
  airTimeSinceJump: number;
  boostingTime: number;
  isSupersonic: boolean;
  supersonicTime: number;
  handbrakeAmount: number;
  bodyContact: boolean;

  demolished: boolean;
  respawnTimer: number;

  /** tick when the car last touched the ball (-1 = never) */
  lastBallTouchTick: number;
  /** per other-car bump cooldowns (by car id) */
  bumpCooldowns: Record<number, number>;

  lastInput: ControllerInput;
  stats: CarStats;
}

export interface BallState {
  pos: Vec3;
  vel: Vec3;
  angVel: Vec3;
}

export type MatchPhase = 'countdown' | 'playing' | 'goal' | 'replay' | 'ended' | 'freeplay';

export interface TouchRecord {
  carId: number;
  team: Team;
  time: number;
}

export interface GameState {
  tick: number;
  /** elapsed game-time in seconds (monotonic) */
  time: number;
  cars: CarState[];
  ball: BallState;
  /** remaining respawn time per pad (0 = available) */
  pads: number[];
  score: [number, number];
  /** seconds remaining (counts up in overtime) */
  clock: number;
  clockRunning: boolean;
  overtime: boolean;
  phase: MatchPhase;
  phaseTimer: number;
  /** waiting for the ball to hit the ground after the clock reached 0 */
  waitingForBallGround: boolean;
  lastTouches: TouchRecord[];
  /** which goal the ball was predicted to enter before the last touch (-1/1, 0 = none) */
  ballGoalPrediction: number;
  lastGoal: { team: Team; scorerId: number; assistId: number; speed: number } | null;
  /** ids of the human players that voted to skip the current goal replay */
  replaySkips: number[];
  winner: Team | -1;
  freeplay: boolean;
  unlimitedBoost: boolean;
  rngSeed: number;
}

export function createStats(): CarStats {
  return { score: 0, goals: 0, assists: 0, saves: 0, shots: 0, demos: 0, touches: 0 };
}

export function createCar(id: number, team: Team, name: string, isBot = false): CarState {
  return {
    id,
    name,
    team,
    isBot,
    pos: v3(0, 0, CAR.REST_HEIGHT),
    quat: qidentity(),
    vel: v3(),
    angVel: v3(),
    boost: CAR.BOOST_START,
    onGround: true,
    airTicks: 0,
    wheelContacts: 4,
    hasJumped: false,
    isJumping: false,
    jumpTime: 0,
    hasDoubleJumped: false,
    hasFlipped: false,
    isFlipping: false,
    flipTime: 0,
    flipDirX: 0,
    flipDirY: 0,
    airTimeSinceJump: 0,
    boostingTime: 0,
    isSupersonic: false,
    supersonicTime: 0,
    handbrakeAmount: 0,
    bodyContact: false,
    demolished: false,
    respawnTimer: 0,
    lastBallTouchTick: -1,
    bumpCooldowns: {},
    lastInput: {
      throttle: 0,
      steer: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
      jump: false,
      boost: false,
      handbrake: false,
    },
    stats: createStats(),
  };
}

export function createBall(): BallState {
  return { pos: v3(0, 0, BALL.KICKOFF_Z), vel: v3(), angVel: v3() };
}

export interface GameOptions {
  freeplay?: boolean;
  unlimitedBoost?: boolean;
  duration?: number;
  seed?: number;
}

export function createGameState(opts: GameOptions = {}): GameState {
  return {
    tick: 0,
    time: 0,
    cars: [],
    ball: createBall(),
    pads: BOOST_PADS.map(() => 0),
    score: [0, 0],
    clock: opts.duration ?? MATCH.DURATION,
    clockRunning: false,
    overtime: false,
    phase: opts.freeplay ? 'freeplay' : 'countdown',
    phaseTimer: opts.freeplay ? 0 : MATCH.COUNTDOWN,
    waitingForBallGround: false,
    lastTouches: [],
    ballGoalPrediction: 0,
    lastGoal: null,
    replaySkips: [],
    winner: -1,
    freeplay: !!opts.freeplay,
    unlimitedBoost: !!opts.unlimitedBoost,
    rngSeed: opts.seed ?? 12345,
  };
}

export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}
