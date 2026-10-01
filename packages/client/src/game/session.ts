import {
  BotController,
  DT,
  addCar,
  cloneState,
  createGameState,
  startMatch,
  stepGame,
  type BotDifficulty,
  type ControllerInput,
  type GameEvent,
  type GameState,
  type Team,
} from '@rl/shared';

/** Common interface for offline and online games. */
export interface Session {
  readonly kind: 'offline' | 'online';
  localCarId: number | null;
  /** latest simulated state */
  state: GameState;
  /** state one tick before `state`, for interpolation */
  prev: GameState;
  /** interpolation factor between prev and state */
  alpha: number;
  /** advances real time and returns the gameplay events produced */
  frame(realDt: number, input: ControllerInput): GameEvent[];
  /** states to render (online sessions apply correction smoothing here) */
  view(): { prev: GameState; curr: GameState };
  /** optional status text (ping, room code, ...) */
  status(): string;
  dispose(): void;
}

export interface OfflineOptions {
  teamSize: 1 | 2 | 3;
  freeplay: boolean;
  difficulty: BotDifficulty;
  playerName: string;
  team: Team;
}

const BOT_NAMES = ['Bandit', 'Viper', 'Rex', 'Sundown', 'Maverick', 'Fury', 'Stinger', 'Tex', 'Gonzo', 'Marley'];

export class OfflineSession implements Session {
  readonly kind = 'offline' as const;
  localCarId = 1;
  state: GameState;
  prev: GameState;
  alpha = 0;
  paused = false;
  private acc = 0;
  private bots = new BotController();

  constructor(private opts: OfflineOptions) {
    this.state = createGameState({ freeplay: opts.freeplay, unlimitedBoost: opts.freeplay, seed: Date.now() & 0xffffff });
    addCar(this.state, 1, opts.team, opts.playerName);
    if (!opts.freeplay) {
      let id = 2;
      let nameIdx = Math.floor(Math.random() * BOT_NAMES.length);
      for (const team of [0, 1] as const) {
        const count = opts.teamSize - (team === opts.team ? 1 : 0);
        for (let i = 0; i < count; i++) {
          addCar(this.state, id, team, BOT_NAMES[nameIdx++ % BOT_NAMES.length], true);
          this.bots.add(id, opts.difficulty);
          id++;
        }
      }
    }
    startMatch(this.state);
    this.prev = cloneState(this.state);
  }

  restart() {
    startMatch(this.state);
    this.prev = cloneState(this.state);
  }

  frame(realDt: number, input: ControllerInput): GameEvent[] {
    const events: GameEvent[] = [];
    if (this.paused) return events;
    this.acc += Math.min(realDt, 0.1);
    const steps = Math.floor(this.acc / DT);
    this.acc -= steps * DT;
    for (let i = 0; i < steps; i++) {
      if (i === steps - 1) this.prev = cloneState(this.state);
      const st = this.state;
      this.bots.prepare(st);
      events.push(...stepGame(st, (car) => (car.id === this.localCarId ? input : this.bots.input(st, car))));
    }
    this.alpha = this.acc / DT;
    return events;
  }

  view() {
    return { prev: this.prev, curr: this.state };
  }

  status(): string {
    return this.opts.freeplay ? 'Entrenamiento libre' : `${this.opts.teamSize}v${this.opts.teamSize} vs bots`;
  }

  dispose() {}
}
