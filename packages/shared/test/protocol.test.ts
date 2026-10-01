import { describe, expect, it } from 'vitest';
import {
  addCar,
  botInput,
  createBotContext,
  createBotMemory,
  createGameState,
  decodeSnapshot,
  encodeSnapshot,
  packInput,
  startMatch,
  stepGame,
  unpackInput,
  type GameState,
} from '../src/index.js';

function botMatch(): { s: GameState; step: (s: GameState) => void } {
  const s = createGameState({ seed: 99 });
  const mems = new Map<number, ReturnType<typeof createBotMemory>>();
  for (let i = 1; i <= 6; i++) {
    addCar(s, i, i <= 3 ? 0 : 1, `bot${i}`, true);
    mems.set(i, createBotMemory('allstar'));
  }
  startMatch(s);
  // Inputs depend only on the state, so both copies get identical inputs
  const step = (st: GameState) => {
    const ctx = createBotContext(st);
    const inputs = new Map(st.cars.map((c) => [c.id, botInput(st, c, structuredClone(mems.get(c.id)!), ctx)]));
    stepGame(st, (c) => inputs.get(c.id)!);
  };
  return { s, step };
}

describe('snapshot codec', () => {
  it('round-trips the full state exactly', () => {
    const { s, step } = botMatch();
    for (let i = 0; i < 900; i++) step(s);
    const names = Object.fromEntries(s.cars.map((c) => [c.id, c.name]));
    const decoded = decodeSnapshot(encodeSnapshot(s, 3), names);
    expect(decoded.inputLead).toBe(3);
    expect(decoded.state).toEqual(s);
  });

  it('re-simulating from a decoded snapshot matches the original', () => {
    const { s, step } = botMatch();
    for (let i = 0; i < 600; i++) step(s);
    const names = Object.fromEntries(s.cars.map((c) => [c.id, c.name]));
    const copy = decodeSnapshot(encodeSnapshot(s, 0), names).state;
    for (let i = 0; i < 300; i++) {
      step(s);
      step(copy);
    }
    expect(copy).toEqual(s);
  });

  it('packs inputs', () => {
    const p = packInput(42, { throttle: 0.5, steer: -1, pitch: 0.25, yaw: 0, roll: 1, jump: true, boost: false, handbrake: true });
    const u = unpackInput(p);
    expect(u.tick).toBe(42);
    expect(u.input).toEqual({ throttle: 0.5, steer: -1, pitch: 0.25, yaw: 0, roll: 1, jump: true, boost: false, handbrake: true });
  });
});

describe('bots', () => {
  it('a 3v3 bot match plays out, scores and ends', () => {
    const { s, step } = botMatch();
    s.clock = 60;
    let ticks = 0;
    while (s.phase !== 'ended' && ticks < 120 * 400) {
      step(s);
      ticks++;
    }
    const touches = s.cars.reduce((a, c) => a + c.stats.touches, 0);
    expect(touches).toBeGreaterThan(10);
    expect(s.phase === 'ended' || s.overtime).toBe(true);
  });
});
