import { MATCH, cloneState, type GameEvent, type GameState } from '@rl/shared';

type GoalEvent = Extract<GameEvent, { type: 'goal' }>;

export interface ReplayFrame {
  prev: GameState;
  curr: GameState;
  alpha: number;
  /** car the replay camera follows (the scorer, or whoever touched the ball last) */
  focusCarId: number | null;
  /** the goal event, returned once when playback reaches the goal so the explosion replays too */
  goalEvent: GoalEvent | null;
  goal: GoalEvent;
}

/**
 * Goal replays: keeps the last few seconds of rendered states and, while the match is in its
 * 'replay' phase, plays back the moments before the goal. Playback position comes from the
 * replay phase timer, so every client shows the same moment and a skip ends it everywhere.
 */
export class ReplayDirector {
  private buffer: GameState[] = [];
  private lastGoal: { event: GoalEvent; time: number } | null = null;
  private clip: { frames: GameState[]; goal: GoalEvent; goalTime: number; fired: boolean; focus: number | null } | null = null;

  /** Call every rendered frame with the state being shown. */
  record(state: GameState) {
    if (state.phase === 'replay') return;
    const last = this.buffer.at(-1);
    if (last) {
      if (state.time < last.time - 1) this.buffer = []; // new match / restart
      else if (state.time <= last.time) return;
    }
    this.buffer.push(cloneState(state));
    const keep = state.time - (MATCH.REPLAY_LEAD + MATCH.GOAL_CELEBRATION + 1);
    while (this.buffer.length && this.buffer[0].time < keep) this.buffer.shift();
  }

  handleEvents(events: GameEvent[], state: GameState) {
    for (const e of events) if (e.type === 'goal') this.lastGoal = { event: e, time: state.time };
  }

  /** The frame to show instead of the live game, or null when no replay is playing. */
  frame(live: GameState): ReplayFrame | null {
    if (live.phase !== 'replay') {
      this.clip = null;
      return null;
    }
    if (!this.clip) {
      const g = this.lastGoal;
      if (!g) return null;
      const t0 = g.time - MATCH.REPLAY_LEAD;
      const t1 = t0 + MATCH.REPLAY;
      const frames = this.buffer.filter((f) => f.time >= t0 - 0.05 && f.time <= t1 + 0.05);
      if (frames.length < 2) return null;
      let focus: number | null = g.event.scorerId >= 0 ? g.event.scorerId : null;
      if (focus === null) {
        const before = frames.filter((f) => f.time <= g.time).at(-1);
        focus = before?.lastTouches.at(-1)?.carId ?? null;
      }
      this.clip = { frames, goal: g.event, goalTime: g.time, fired: false, focus };
    }
    const { frames } = this.clip;
    const t = frames[0].time + Math.max(0, MATCH.REPLAY - live.phaseTimer);
    let i = 0;
    while (i < frames.length - 2 && frames[i + 1].time <= t) i++;
    const a = frames[i];
    const b = frames[i + 1];
    const alpha = Math.min(1, Math.max(0, (t - a.time) / Math.max(1e-6, b.time - a.time)));
    let goalEvent: GoalEvent | null = null;
    if (!this.clip.fired && t >= this.clip.goalTime) {
      this.clip.fired = true;
      goalEvent = this.clip.goal;
    }
    return { prev: a, curr: b, alpha, focusCarId: this.clip.focus, goalEvent, goal: this.clip.goal };
  }
}
