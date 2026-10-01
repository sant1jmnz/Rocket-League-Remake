import { TEAM_NAMES, vlen, type GameEvent, type GameState } from '@rl/shared';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

export function formatClock(seconds: number, overtime: boolean): string {
  const s = overtime ? Math.floor(seconds) : Math.ceil(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${overtime ? '+' : ''}${m}:${r.toString().padStart(2, '0')}`;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** In-game overlay: scoreboard, clock, boost meter, banners, kill feed and Tab scoreboard. */
export class Hud {
  readonly root = el('div', 'hud');
  private scoreBlue = el('div', 'score blue');
  private scoreOrange = el('div', 'score orange');
  private clock = el('div', 'clock');
  private boostValue = el('div', 'boost-value');
  private boostRing: SVGCircleElement;
  private boostWrap = el('div', 'boost');
  private center = el('div', 'center-msg');
  private sub = el('div', 'center-sub');
  private feed = el('div', 'feed');
  private board = el('div', 'board hidden');
  private ballCamTag = el('div', 'ballcam-tag');
  private statusTag = el('div', 'status-tag');
  private speedTag = el('div', 'speed-tag');
  private replayTag = el('div', 'replay-tag hidden');
  private replaySkip = el('div', 'replay-skip hidden');
  private messageTimer = 0;
  private lastPhase = '';

  constructor() {
    const top = el('div', 'topbar');
    const blue = el('div', 'team-box blue', '<span class="tname">AZUL</span>');
    const orange = el('div', 'team-box orange', '<span class="tname">NARANJA</span>');
    blue.append(this.scoreBlue);
    orange.prepend(this.scoreOrange);
    top.append(blue, this.clock, orange);
    // 270° segmented gauge like the real boost meter (fills clockwise from the bottom-left)
    this.boostWrap.innerHTML = `<svg viewBox="0 0 200 200">
      <defs><linearGradient id="bgrad" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#ff7a00"/><stop offset="1" stop-color="#ffe14a"/></linearGradient></defs>
      <circle class="disc" cx="100" cy="100" r="92"/>
      <circle class="track" cx="100" cy="100" r="78"/>
      <circle class="fill" cx="100" cy="100" r="78"/>
      <circle class="gaps" cx="100" cy="100" r="78"/>
    </svg>`;
    this.boostRing = this.boostWrap.querySelector('circle.fill')!;
    this.boostWrap.append(this.boostValue);
    this.root.append(top, this.center, this.sub, this.feed, this.board, this.boostWrap, this.ballCamTag, this.statusTag, this.speedTag, this.chatMenu, this.replayTag, this.replaySkip);
  }

  show(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  private banner(text: string, sub = '', seconds = 2.5, cls = '') {
    this.center.textContent = text;
    this.center.className = `center-msg show ${cls}`;
    this.sub.textContent = sub;
    this.sub.className = `center-sub ${sub ? 'show' : ''}`;
    this.messageTimer = seconds;
  }

  private chatMenu = el('div', 'chat-menu hidden');

  /** Goal replay overlay (null hides it). `skipKey` names the jump binding. */
  setReplay(info: { scorer: string; team: 0 | 1; kph: number; votes: number; needed: number; voted: boolean; skipKey: string } | null) {
    this.root.classList.toggle('replaying', !!info);
    if (!info) {
      this.replayTag.className = 'replay-tag hidden';
      this.replaySkip.className = 'replay-skip hidden';
      return;
    }
    this.replayTag.className = `replay-tag t${info.team}`;
    const html = `<div class="rt-title">REPETICIÓN</div><div class="rt-sub">${escapeHtml(info.scorer)} · ${info.kph} km/h</div>`;
    if (this.replayTag.innerHTML !== html) this.replayTag.innerHTML = html;
    this.replaySkip.className = `replay-skip${info.voted ? ' voted' : ''}`;
    const skip = info.voted
      ? `Esperando a los demás · ${info.votes}/${info.needed}`
      : `<b>${escapeHtml(info.skipKey)}</b> para omitir${info.needed > 1 ? ` · ${info.votes}/${info.needed}` : ''}`;
    if (this.replaySkip.innerHTML !== skip) this.replaySkip.innerHTML = skip;
  }

  /** Quick chat: shows the options of a category (or hides with null). */
  showChatMenu(title: string | null, options: string[] = []) {
    if (!title) {
      this.chatMenu.className = 'chat-menu hidden';
      return;
    }
    this.chatMenu.className = 'chat-menu';
    this.chatMenu.innerHTML = `<div class="chat-title">${escapeHtml(title)}</div>${options.map((o, i) => `<div><b>${i + 1}</b> ${escapeHtml(o)}</div>`).join('')}`;
  }

  chat(from: string, team: 0 | 1, text: string) {
    this.pushFeed(`<span class="t${team}">${escapeHtml(from)}</span>: ${escapeHtml(text)}`);
  }

  private pushFeed(html: string) {
    const item = el('div', 'feed-item', html);
    this.feed.prepend(item);
    setTimeout(() => item.classList.add('fade'), 3500);
    setTimeout(() => item.remove(), 4200);
    while (this.feed.children.length > 5) this.feed.lastElementChild?.remove();
  }

  handleEvents(events: GameEvent[], state: GameState, localCarId: number | null) {
    const name = (id: number) => {
      const c = state.cars.find((x) => x.id === id);
      return c ? `<span class="t${c.team}">${escapeHtml(c.name)}</span>` : '?';
    };
    for (const e of events) {
      switch (e.type) {
        case 'countdown':
          this.banner(e.value > 0 ? String(e.value) : '¡YA!', '', e.value > 0 ? 1.1 : 0.8, 'countdown');
          break;
        case 'goal': {
          const kph = Math.round(e.speed * 0.036);
          const scorer = state.cars.find((c) => c.id === e.scorerId);
          const assist = state.cars.find((c) => c.id === e.assistId);
          const lastTouch = state.lastTouches.at(-1);
          const ownGoal = !scorer && lastTouch && lastTouch.team !== e.team ? state.cars.find((c) => c.id === lastTouch.carId) : undefined;
          const who = scorer
            ? `${scorer.name}${assist ? ` (asistencia: ${assist.name})` : ''}`
            : ownGoal
              ? `Autogol de ${ownGoal.name}`
              : '';
          this.banner('¡GOL!', `${who ? `${who} · ` : ''}${kph} km/h`, 3, `goal t${e.team}`);
          if (!state.freeplay) {
            this.pushFeed(`⚽ ${scorer ? name(scorer.id) : ownGoal ? `Autogol de ${name(ownGoal.id)}` : 'Gol'} · ${TEAM_NAMES[e.team]}`);
          }
          break;
        }
        case 'demo':
          this.pushFeed(`💥 ${name(e.attacker)} demolió a ${name(e.victim)}`);
          if (e.victim === localCarId) this.banner('DEMOLIDO', '', 1.5, 'demo');
          break;
        case 'save':
          this.pushFeed(`🧤 ¡Atajada de ${name(e.carId)}!`);
          if (e.carId === localCarId) this.banner('¡ATAJADA!', '', 1.2, 'small');
          break;
        case 'shot':
          if (e.carId === localCarId) this.pushFeed(`🎯 Tiro al arco`);
          break;
        case 'overtime':
          this.banner('TIEMPO EXTRA', 'Gol de oro', 2.5);
          break;
        case 'matchEnd': {
          const local = state.cars.find((c) => c.id === localCarId);
          const won = local ? local.team === e.winner : false;
          this.banner(local ? (won ? '¡VICTORIA!' : 'DERROTA') : `Gana ${TEAM_NAMES[e.winner]}`, `${state.score[0]} - ${state.score[1]}`, 6, won ? 'win' : 'lose');
          break;
        }
      }
    }
  }

  update(dt: number, state: GameState, localCarId: number | null, ui: { scoreboard: boolean; ballCam: boolean; status: string }) {
    this.scoreBlue.textContent = String(state.score[0]);
    this.scoreOrange.textContent = String(state.score[1]);
    this.clock.textContent = state.freeplay ? 'LIBRE' : formatClock(state.clock, state.overtime);
    this.clock.classList.toggle('overtime', state.overtime);
    this.scoreBlue.style.visibility = this.scoreOrange.style.visibility = state.freeplay ? 'hidden' : '';

    const car = state.cars.find((c) => c.id === localCarId);
    this.boostWrap.style.display = car ? '' : 'none';
    if (car) {
      const b = state.unlimitedBoost ? 100 : car.boost;
      this.boostValue.textContent = state.unlimitedBoost ? '∞' : String(Math.floor(b));
      const arc = 2 * Math.PI * 78 * 0.75;
      this.boostRing.style.strokeDasharray = `${(arc * b) / 100} 1000`;
      this.boostWrap.classList.toggle('t1', car.team === 1);
      this.speedTag.textContent = `${Math.round(vlen(car.vel) * 0.036)} km/h${car.isSupersonic ? ' · SUPERSÓNICO' : ''}`;
      if (car.demolished) {
        this.sub.textContent = `Reapareciendo en ${Math.ceil(car.respawnTimer)}…`;
        this.sub.className = 'center-sub show';
      }
    } else {
      this.speedTag.textContent = '';
    }
    this.ballCamTag.textContent = ui.ballCam ? 'BALL CAM' : 'CAR CAM';
    this.statusTag.textContent = ui.status;

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) {
        this.center.className = 'center-msg';
        if (!car?.demolished) this.sub.className = 'center-sub';
      }
    }
    if (state.phase !== this.lastPhase) {
      this.lastPhase = state.phase;
    }

    this.board.classList.toggle('hidden', !ui.scoreboard); // results get their own screen when the match ends
    if (!this.board.classList.contains('hidden')) this.renderBoard(state, localCarId);
  }

  private renderBoard(state: GameState, localCarId: number | null) {
    const rows = (team: 0 | 1) =>
      state.cars
        .filter((c) => c.team === team)
        .sort((a, b) => b.stats.score - a.stats.score)
        .map(
          (c) =>
            `<tr class="${c.id === localCarId ? 'me' : ''}"><td>${escapeHtml(c.name)}${c.isBot ? ' <small>BOT</small>' : ''}</td><td>${c.stats.score}</td><td>${c.stats.goals}</td><td>${c.stats.assists}</td><td>${c.stats.saves}</td><td>${c.stats.shots}</td><td>${c.stats.demos}</td></tr>`,
        )
        .join('');
    const table = (team: 0 | 1) =>
      `<div class="board-team t${team}"><div class="board-head"><span>${TEAM_NAMES[team]}</span><span>${state.score[team]}</span></div>
      <table><thead><tr><th>Jugador</th><th>Puntos</th><th>Goles</th><th>Asist.</th><th>Atajadas</th><th>Tiros</th><th>Demos</th></tr></thead><tbody>${rows(team)}</tbody></table></div>`;
    const html = table(0) + table(1);
    if (this.board.innerHTML !== html) this.board.innerHTML = html;
  }
}
