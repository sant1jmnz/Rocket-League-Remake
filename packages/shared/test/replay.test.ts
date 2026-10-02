import { describe, expect, it } from 'vitest';
import {
  DT,
  MATCH,
  addCar,
  createGameState,
  decodeSnapshot,
  emptyInput,
  encodeSnapshot,
  matchMvp,
  startMatch,
  stepGame,
  type ControllerInput,
  type GameState,
} from '../src/index.js';

/** A 1v1 with the ball about to cross the orange goal line. */
function aboutToScore(): GameState {
  const s = createGameState({ seed: 7 });
  addCar(s, 1, 0, 'humano');
  addCar(s, 2, 1, 'bot', true);
  startMatch(s);
  s.phase = 'playing';
  s.ball.pos = { x: 0, y: 5150, z: 200 };
  s.ball.vel = { x: 0, y: 2000, z: 0 };
  return s;
}

function stepUntil(s: GameState, input: (t: number) => ControllerInput, done: () => boolean, max = 4000): number {
  for (let t = 0; t < max; t++) {
    if (done()) return t;
    stepGame(s, () => input(t));
  }
  throw new Error('condition never met');
}

describe('goal replay', () => {
  it('follows the celebration, freezes the world and then resets to kickoff', () => {
    const s = aboutToScore();
    stepUntil(s, () => emptyInput(), () => s.phase === 'goal');
    expect(s.score).toEqual([1, 0]);
    const ticks = stepUntil(s, () => emptyInput(), () => s.phase === 'replay');
    expect(ticks * DT).toBeCloseTo(MATCH.GOAL_CELEBRATION, 1);
    // nothing moves while it plays, even with the throttle down
    const carPos = { ...s.cars[0].pos };
    const gas = { ...emptyInput(), throttle: 1, boost: true };
    for (let i = 0; i < 120; i++) stepGame(s, () => gas);
    expect(s.cars[0].pos).toEqual(carPos);
    const replayTicks = 120 + stepUntil(s, () => gas, () => s.phase !== 'replay');
    expect(replayTicks * DT).toBeCloseTo(MATCH.REPLAY, 1);
    expect(s.phase).toBe('countdown');
  });

  it('is skipped once every human presses jump; holding it from before does not count', () => {
    const s = aboutToScore();
    const held = { ...emptyInput(), jump: true };
    stepUntil(s, () => held, () => s.phase === 'replay');
    for (let i = 0; i < 60; i++) stepGame(s, () => held);
    expect(s.phase).toBe('replay');
    expect(s.replaySkips).toEqual([]);
    // release, then press again
    stepGame(s, () => emptyInput());
    const events = stepGame(s, () => held);
    expect(events.some((e) => e.type === 'replaySkipVote')).toBe(true);
    expect(s.phase).toBe('countdown');
  });

  it('keeps the skip votes in snapshots', () => {
    const s = aboutToScore();
    addCar(s, 3, 0, 'otro');
    stepUntil(s, () => emptyInput(), () => s.phase === 'replay');
    stepGame(s, (c) => ({ ...emptyInput(), jump: c.id === 1 }));
    expect(s.phase).toBe('replay');
    expect(s.replaySkips).toEqual([1]);
    const d = decodeSnapshot(encodeSnapshot(s, 0), {});
    expect(d.state.phase).toBe('replay');
    expect(d.state.replaySkips).toEqual([1]);
  });
});

describe('match MVP', () => {
  it('is the top scorer of the winning team', () => {
    const s = createGameState();
    addCar(s, 1, 0, 'a');
    addCar(s, 2, 0, 'b');
    addCar(s, 3, 1, 'c');
    expect(matchMvp(s)).toBeNull();
    s.cars[0].stats.score = 120;
    s.cars[1].stats.score = 300;
    s.cars[2].stats.score = 900; // best overall, but lost
    s.winner = 0;
    expect(matchMvp(s)).toBe(2);
  });
});

describe('goal explosion', () => {
  it('pushes nearby cars away from the ball and leaves distant ones alone', () => {
    const s = aboutToScore();
    const near = s.cars[0];
    const far = s.cars[1];
    near.pos = { x: 0, y: 4400, z: 17.01 };
    near.vel = { x: 0, y: 0, z: 0 };
    far.pos = { x: 0, y: -2000, z: 17.01 };
    far.vel = { x: 0, y: 0, z: 0 };
    stepUntil(s, () => emptyInput(), () => s.phase === 'goal');
    expect(near.vel.y).toBeLessThan(-500); // blown back out of the goal
    expect(near.vel.z).toBeGreaterThan(0);
    expect(Math.hypot(far.vel.x, far.vel.y, far.vel.z)).toBeLessThan(1);
  });
});
