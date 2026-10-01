import {
  BotController,
  DT,
  addCar,
  createGameState,
  emptyInput,
  encodeSnapshot,
  removeCar,
  startMatch,
  stepGame,
  unpackInput,
  type ControllerInput,
  type GameState,
  type RoomInfo,
  type ServerMessage,
  type Team,
  type TeamSize,
} from '@rl/shared';

export interface Client {
  id: number;
  name: string;
  ping: number;
  send(msg: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
  room: Room | null;
}

interface Member {
  client: Client;
  team: Team;
  inputs: Map<number, ControllerInput>;
  lastInput: ControllerInput;
  latestInputTick: number;
}

const BOT_NAMES = ['Bandit', 'Viper', 'Rex', 'Sundown', 'Maverick', 'Fury', 'Stinger', 'Tex', 'Gonzo', 'Marley', 'Junker', 'Hound'];
const SNAPSHOT_EVERY = 4; // 120 Hz sim, 30 Hz snapshots
const BOT_ID_BASE = 30000;

/** Tunables (overridable for tests / custom servers). */
export const roomConfig = {
  matchSeconds: Number(process.env.MATCH_SECONDS ?? 300),
  postMatchSeconds: 10,
  quickStartMs: 5000,
};

export class Room {
  readonly members = new Map<number, Member>();
  status: 'lobby' | 'playing' = 'lobby';
  hostId = -1;
  state: GameState | null = null;
  private bots = new BotController();
  private botNames = new Map<number, string>();
  private nextBotId = BOT_ID_BASE;
  private timer: NodeJS.Timeout | null = null;
  private nextTickAt = 0;
  private endedAt = -1;
  private autoStartTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly code: string,
    public teamSize: TeamSize,
    readonly isPublic: boolean,
    private onEmpty: (room: Room) => void,
  ) {}

  get humanCount() {
    return this.members.size;
  }

  freeSlots(): number {
    return this.teamSize * 2 - this.members.size;
  }

  info(): RoomInfo {
    const players = [...this.members.values()].map((m) => ({
      id: m.client.id,
      name: m.client.name,
      team: m.team,
      isBot: false,
      ping: m.client.ping,
    }));
    return { code: this.code, teamSize: this.teamSize, hostId: this.hostId, players, status: this.status };
  }

  broadcast(msg: ServerMessage) {
    for (const m of this.members.values()) m.client.send(msg);
  }

  broadcastRoom() {
    this.broadcast({ t: 'room', room: this.info() });
  }

  private teamCount(team: Team) {
    let n = 0;
    for (const m of this.members.values()) if (m.team === team) n++;
    return n;
  }

  private pickTeam(): Team {
    return this.teamCount(0) <= this.teamCount(1) ? 0 : 1;
  }

  join(client: Client): boolean {
    if (this.freeSlots() <= 0) return false;
    const team = this.pickTeam();
    if (this.teamCount(team) >= this.teamSize) return false;
    this.members.set(client.id, {
      client,
      team,
      inputs: new Map(),
      lastInput: emptyInput(),
      latestInputTick: -1,
    });
    client.room = this;
    if (this.hostId < 0) this.hostId = client.id;

    if (this.status === 'playing' && this.state) this.addHumanMidGame(client.id);
    this.broadcastRoom();
    if (this.status === 'playing') this.sendStart(client.id);
    // Quick-match rooms start on their own; late joiners replace bots
    else if (this.isPublic) this.scheduleAutoStart(roomConfig.quickStartMs);
    return true;
  }

  leave(clientId: number) {
    const m = this.members.get(clientId);
    if (!m) return;
    this.members.delete(clientId);
    m.client.room = null;
    if (this.state && this.status === 'playing') {
      // Replace the leaving player with a bot, like the real game
      const car = this.state.cars.find((c) => c.id === clientId);
      if (car) {
        removeCar(this.state, clientId);
        const botId = this.nextBotId++;
        const name = this.randomBotName();
        const bot = addCar(this.state, botId, car.team, name, true);
        Object.assign(bot, { ...car, id: botId, name, isBot: true, bumpCooldowns: {} });
        this.bots.add(botId, 'pro');
        this.botNames.set(botId, name);
        this.broadcast({ t: 'names', names: this.names() });
      }
    }
    if (this.hostId === clientId) this.hostId = this.members.keys().next().value ?? -1;
    if (this.members.size === 0) {
      this.stop();
      this.onEmpty(this);
      return;
    }
    this.broadcastRoom();
  }

  setTeam(clientId: number, team: Team) {
    const m = this.members.get(clientId);
    if (!m || m.team === team || this.status !== 'lobby') return;
    if (this.teamCount(team) >= this.teamSize) return;
    m.team = team;
    this.broadcastRoom();
  }

  setTeamSize(clientId: number, size: TeamSize) {
    if (clientId !== this.hostId || this.status !== 'lobby') return;
    if (this.teamCount(0) > size || this.teamCount(1) > size) return;
    this.teamSize = size;
    this.broadcastRoom();
  }

  private randomBotName(): string {
    const used = new Set(this.botNames.values());
    return BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${this.nextBotId}`;
  }

  private names(): Record<number, string> {
    const names: Record<number, string> = {};
    for (const m of this.members.values()) names[m.client.id] = m.client.name;
    for (const [id, n] of this.botNames) names[id] = n;
    return names;
  }

  start(byClient?: number) {
    if (byClient !== undefined && byClient !== this.hostId) return;
    if (this.status === 'playing') return;
    const state = createGameState({ seed: Math.floor(Math.random() * 1e9) });
    this.bots = new BotController();
    this.botNames.clear();
    for (const m of this.members.values()) {
      addCar(state, m.client.id, m.team, m.client.name);
      m.inputs.clear();
      m.lastInput = emptyInput();
      m.latestInputTick = -1;
    }
    for (const team of [0, 1] as const) {
      for (let i = this.teamCount(team); i < this.teamSize; i++) {
        const id = this.nextBotId++;
        const name = this.randomBotName();
        addCar(state, id, team, name, true);
        this.bots.add(id, 'pro');
        this.botNames.set(id, name);
      }
    }
    startMatch(state, roomConfig.matchSeconds);
    this.state = state;
    this.status = 'playing';
    this.endedAt = -1;
    this.broadcastRoom();
    for (const id of this.members.keys()) this.sendStart(id);
    this.nextTickAt = performance.now();
    this.loop();
  }

  private addHumanMidGame(clientId: number) {
    const state = this.state!;
    const m = this.members.get(clientId)!;
    // Take over a bot on the player's team
    const bot = state.cars.find((c) => c.isBot && c.team === m.team);
    if (bot) {
      removeCar(state, bot.id);
      this.bots.remove(bot.id);
      this.botNames.delete(bot.id);
      const car = addCar(state, clientId, m.team, m.client.name);
      Object.assign(car, { ...bot, id: clientId, name: m.client.name, isBot: false, bumpCooldowns: {} });
    } else {
      addCar(state, clientId, m.team, m.client.name);
    }
    this.broadcast({ t: 'names', names: this.names() });
  }

  private sendStart(clientId: number) {
    const m = this.members.get(clientId);
    if (!m || !this.state) return;
    m.client.send({ t: 'start', carId: clientId, serverTick: this.state.tick, names: this.names() });
  }

  receiveInputs(clientId: number, inputs: unknown) {
    const m = this.members.get(clientId);
    if (!m || !this.state || !Array.isArray(inputs)) return;
    const now = this.state.tick;
    for (const raw of inputs.slice(0, 32)) {
      if (!Array.isArray(raw)) continue;
      const { tick, input } = unpackInput(raw as number[]);
      if (tick <= now || tick > now + 240) continue;
      m.inputs.set(tick, input);
      if (tick > m.latestInputTick) m.latestInputTick = tick;
    }
  }

  private loop = () => {
    if (this.status !== 'playing') return;
    const now = performance.now();
    let n = 0;
    while (now >= this.nextTickAt && n < 12) {
      this.tick();
      this.nextTickAt += DT * 1000;
      n++;
      if (this.status !== 'playing') return;
    }
    if (now - this.nextTickAt > 250) this.nextTickAt = now;
    this.timer = setTimeout(this.loop, Math.max(0, this.nextTickAt - performance.now()));
  };

  private tick() {
    const state = this.state!;
    const tick = state.tick + 1;
    this.bots.prepare(state);
    stepGame(state, (car) => {
      const m = this.members.get(car.id);
      if (m) {
        const inp = m.inputs.get(tick);
        if (inp) {
          m.lastInput = inp;
          m.inputs.delete(tick);
        }
        return m.lastInput;
      }
      return this.bots.input(state, car);
    });
    // Drop stale inputs
    for (const m of this.members.values()) for (const t of m.inputs.keys()) if (t <= tick) m.inputs.delete(t);

    if (state.tick % SNAPSHOT_EVERY === 0) {
      for (const m of this.members.values()) {
        const lead = m.latestInputTick < 0 ? 0 : m.latestInputTick - state.tick;
        m.client.sendBinary(encodeSnapshot(state, lead));
      }
    }

    if (state.phase === 'ended') {
      if (this.endedAt < 0) this.endedAt = state.time;
      if (state.time - this.endedAt > roomConfig.postMatchSeconds) this.backToLobby();
    }
  }

  private backToLobby() {
    this.stop();
    this.status = 'lobby';
    this.state = null;
    this.broadcastRoom();
    if (this.isPublic) this.scheduleAutoStart(8000);
  }

  private scheduleAutoStart(ms: number) {
    if (this.autoStartTimer) return;
    this.autoStartTimer = setTimeout(() => {
      this.autoStartTimer = null;
      if (this.status === 'lobby' && this.members.size > 0) this.start();
    }, ms);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.autoStartTimer) clearTimeout(this.autoStartTimer);
    this.timer = null;
    this.autoStartTimer = null;
  }
}
