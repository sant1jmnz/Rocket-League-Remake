import { TEAM_NAMES, type BotDifficulty, type RoomInfo, type Team, type TeamSize } from '@rl/shared';
import { ACTION_LABELS, DEFAULT_KEYS, DEFAULT_PAD, PAD_BUTTON_NAMES, keyLabel, type Action } from '../input/bindings';
import type { InputManager } from '../input/manager';
import { DEFAULT_CAMERA } from '../camera/camera';
import type { AppSettings } from './settings';

export interface MenuCallbacks {
  playOffline(opts: { teamSize: TeamSize; difficulty: BotDifficulty; team: Team }): void;
  playFreeplay(): void;
  createRoom(teamSize: TeamSize): void;
  joinRoom(code: string): void;
  quickMatch(teamSize: TeamSize): void;
  setTeam(team: Team): void;
  setTeamSize(size: TeamSize): void;
  startRoom(): void;
  leaveRoom(): void;
  resume(): void;
  quitToMenu(): void;
  restartOffline(): void;
  settingsChanged(): void;
}

const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class Menus {
  readonly root = h('<div class="menus"></div>');
  private current = '';
  private inGame = false;
  private backTarget: () => void = () => this.showMain();

  constructor(
    private settings: AppSettings,
    private input: InputManager,
    private cb: MenuCallbacks,
  ) {}

  get visible() {
    return this.root.childElementCount > 0;
  }

  get screen() {
    return this.current;
  }

  hide() {
    this.root.replaceChildren();
    this.current = '';
  }

  setInGame(v: boolean) {
    this.inGame = v;
  }

  private mount(name: string, node: HTMLElement) {
    this.current = name;
    this.root.replaceChildren(node);
  }

  private panel(title: string, body: string, back = true): HTMLElement {
    const node = h(`<div class="panel">
      <div class="panel-title">${title}</div>
      <div class="panel-body">${body}</div>
      ${back ? '<button class="btn ghost back">← Volver</button>' : ''}
    </div>`);
    node.querySelector('.back')?.addEventListener('click', () => this.backTarget());
    return node;
  }

  showMain() {
    this.backTarget = () => this.showMain();
    const node = h(`<div class="main-menu">
      <div class="logo"><span class="l1">ROCKET</span><span class="l2">REMAKE</span><div class="logo-sub">Fútbol con autos · física 1:1</div></div>
      <div class="menu-list">
        <button class="btn big" data-a="online">Jugar online</button>
        <button class="btn big" data-a="offline">Jugar contra bots</button>
        <button class="btn big" data-a="freeplay">Entrenamiento libre</button>
        <button class="btn" data-a="controls">Controles</button>
        <button class="btn" data-a="settings">Ajustes</button>
      </div>
      <div class="name-row"><label>Nombre</label><input class="name" maxlength="16" value="${esc(this.settings.playerName)}" /></div>
      <div class="name-row"><label>Auto</label><div class="seg body">${(['octane', 'fennec'] as const)
        .map((b) => `<button class="seg-btn ${this.settings.carBody === b ? 'on' : ''}" data-body="${b}">${b === 'octane' ? 'Octane' : 'Fennec'}</button>`)
        .join('')}</div></div>
      <div class="footer">Proyecto de fans sin fines de lucro. Sin afiliación con Psyonix ni Epic Games.</div>
    </div>`);
    this.wireSeg(node, '.body', 'body', (v) => {
      this.settings.carBody = v === 'fennec' ? 'fennec' : 'octane';
      this.cb.settingsChanged();
    });
    const name = node.querySelector<HTMLInputElement>('.name')!;
    name.addEventListener('change', () => {
      this.settings.playerName = name.value.trim().slice(0, 16) || this.settings.playerName;
      this.cb.settingsChanged();
    });
    node.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.a;
        if (a === 'online') this.showOnline();
        if (a === 'offline') this.showOffline();
        if (a === 'freeplay') this.cb.playFreeplay();
        if (a === 'controls') this.showControls();
        if (a === 'settings') this.showSettings();
      }),
    );
    this.mount('main', node);
  }

  private sizeButtons(selected: TeamSize, cls = 'size') {
    return `<div class="seg ${cls}">${[1, 2, 3].map((n) => `<button class="seg-btn ${n === selected ? 'on' : ''}" data-size="${n}">${n}v${n}</button>`).join('')}</div>`;
  }

  private wireSeg(node: HTMLElement, sel: string, attr: string, onChange: (v: string) => void) {
    const seg = node.querySelector(sel)!;
    seg.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.classList.remove('on'));
        b.classList.add('on');
        onChange(b.dataset[attr]!);
      }),
    );
  }

  showOffline() {
    let size: TeamSize = 1;
    let difficulty: BotDifficulty = 'pro';
    let team: Team = 0;
    const node = this.panel(
      'Jugar contra bots',
      `<div class="row"><label>Modo</label>${this.sizeButtons(1)}</div>
       <div class="row"><label>Dificultad</label><div class="seg diff">
         <button class="seg-btn" data-d="rookie">Novato</button><button class="seg-btn on" data-d="pro">Pro</button><button class="seg-btn" data-d="allstar">All-Star</button></div></div>
       <div class="row"><label>Equipo</label><div class="seg team">
         <button class="seg-btn on t0" data-t="0">Azul</button><button class="seg-btn t1" data-t="1">Naranja</button></div></div>
       <button class="btn big go">Jugar</button>`,
    );
    this.wireSeg(node, '.size', 'size', (v) => (size = Number(v) as TeamSize));
    this.wireSeg(node, '.diff', 'd', (v) => (difficulty = v as BotDifficulty));
    this.wireSeg(node, '.team', 't', (v) => (team = Number(v) as Team));
    node.querySelector('.go')!.addEventListener('click', () => this.cb.playOffline({ teamSize: size, difficulty, team }));
    this.mount('offline', node);
  }

  showOnline(error = '') {
    let size: TeamSize = 3;
    const node = this.panel(
      'Jugar online',
      `${error ? `<div class="error">${esc(error)}</div>` : ''}
       <div class="row"><label>Modo</label>${this.sizeButtons(3)}</div>
       <div class="row buttons"><button class="btn big quick">Partida rápida</button><button class="btn big create">Crear sala privada</button></div>
       <div class="divider">o únete con un código</div>
       <div class="row"><input class="code" maxlength="5" placeholder="CÓDIGO" /><button class="btn join">Unirse</button></div>
       <div class="hint">Comparte el código de la sala con tus amigos. Los lugares vacíos se llenan con bots.</div>`,
    );
    this.wireSeg(node, '.size', 'size', (v) => (size = Number(v) as TeamSize));
    node.querySelector('.quick')!.addEventListener('click', () => this.cb.quickMatch(size));
    node.querySelector('.create')!.addEventListener('click', () => this.cb.createRoom(size));
    const code = node.querySelector<HTMLInputElement>('.code')!;
    code.addEventListener('input', () => (code.value = code.value.toUpperCase().replace(/[^A-Z0-9]/g, '')));
    const join = () => code.value.length >= 4 && this.cb.joinRoom(code.value);
    node.querySelector('.join')!.addEventListener('click', join);
    code.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    this.mount('online', node);
  }

  showConnecting(text = 'Conectando…') {
    this.mount('connecting', this.panel(text, '<div class="spinner"></div>', true));
    this.backTarget = () => {
      this.cb.leaveRoom();
      this.showOnline();
    };
  }

  showLobby(room: RoomInfo, myId: number) {
    this.backTarget = () => {
      this.cb.leaveRoom();
      this.showOnline();
    };
    const isHost = room.hostId === myId;
    const col = (team: Team) => {
      const players = room.players.filter((p) => p.team === team && !p.isBot);
      const slots = [];
      for (let i = 0; i < room.teamSize; i++) {
        const p = players[i];
        slots.push(
          p
            ? `<div class="slot ${p.id === myId ? 'me' : ''}">${esc(p.name)}${p.id === room.hostId ? ' <small>ANFITRIÓN</small>' : ''}<span class="ping">${p.ping} ms</span></div>`
            : `<div class="slot empty">Bot</div>`,
        );
      }
      return `<div class="lobby-team t${team}"><div class="lobby-head">${TEAM_NAMES[team]}</div>${slots.join('')}
        <button class="btn join-team" data-team="${team}">Unirse a ${TEAM_NAMES[team]}</button></div>`;
    };
    const node = this.panel(
      `Sala <span class="room-code">${room.code}</span>`,
      `<div class="row"><label>Modo</label>${isHost ? this.sizeButtons(room.teamSize) : `<b>${room.teamSize}v${room.teamSize}</b>`}</div>
       <div class="lobby">${col(0)}${col(1)}</div>
       ${isHost ? '<button class="btn big start">Comenzar partida</button>' : '<div class="hint">Esperando a que el anfitrión comience la partida…</div>'}
       <div class="hint">Código para invitar: <b>${room.code}</b> <button class="btn tiny copy">Copiar enlace</button></div>`,
    );
    if (isHost) {
      this.wireSeg(node, '.size', 'size', (v) => this.cb.setTeamSize(Number(v) as TeamSize));
      node.querySelector('.start')!.addEventListener('click', () => this.cb.startRoom());
    }
    node.querySelectorAll<HTMLButtonElement>('.join-team').forEach((b) =>
      b.addEventListener('click', () => this.cb.setTeam(Number(b.dataset.team) as Team)),
    );
    node.querySelector('.copy')!.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}?sala=${room.code}`;
      void navigator.clipboard?.writeText(url);
    });
    this.mount('lobby', node);
  }

  showPause(offline: boolean) {
    this.backTarget = () => this.cb.resume();
    const node = this.panel(
      'Pausa',
      `<div class="menu-list">
        <button class="btn big" data-a="resume">Continuar</button>
        ${offline ? '<button class="btn" data-a="restart">Reiniciar partida</button>' : ''}
        <button class="btn" data-a="controls">Controles</button>
        <button class="btn" data-a="settings">Ajustes</button>
        <button class="btn danger" data-a="quit">Salir al menú</button>
      </div>`,
      false,
    );
    node.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.a;
        if (a === 'resume') this.cb.resume();
        if (a === 'restart') this.cb.restartOffline();
        if (a === 'quit') this.cb.quitToMenu();
        if (a === 'controls') {
          this.showControls();
          this.backTarget = () => this.showPause(offline);
        }
        if (a === 'settings') {
          this.showSettings();
          this.backTarget = () => this.showPause(offline);
        }
      }),
    );
    this.mount('pause', node);
  }

  showMatchEnd(text: string, offline: boolean) {
    const node = this.panel(
      text,
      `<div class="menu-list">
        ${offline ? '<button class="btn big" data-a="restart">Jugar otra vez</button>' : '<div class="hint">Volviendo a la sala…</div>'}
        <button class="btn" data-a="quit">Salir al menú</button>
      </div>`,
      false,
    );
    node.querySelector('[data-a=restart]')?.addEventListener('click', () => this.cb.restartOffline());
    node.querySelector('[data-a=quit]')!.addEventListener('click', () => this.cb.quitToMenu());
    this.mount('end', node);
  }

  showControls() {
    if (!this.inGame) this.backTarget = () => this.showMain();
    const actions = Object.keys(ACTION_LABELS) as Action[];
    const s = this.input.settings;
    const rows = actions
      .map((a) => {
        const keys = (s.keys[a] ?? []).map(keyLabel).join(' / ') || '—';
        const pad = s.pad[a] !== undefined ? (s.pad[a]!.map((i) => PAD_BUTTON_NAMES[i] ?? `Botón ${i}`).join(' / ') || '—') : fixedPad(a);
        return `<tr><td>${ACTION_LABELS[a]}</td>
          <td><button class="bind" data-kind="key" data-a="${a}">${keys}</button></td>
          <td>${s.pad[a] !== undefined ? `<button class="bind" data-kind="pad" data-a="${a}">${pad}</button>` : `<span class="fixed">${pad}</span>`}</td></tr>`;
      })
      .join('');
    const node = this.panel(
      'Controles',
      `<div class="hint">Haz clic en una asignación y presiona la nueva tecla, botón del mouse o botón del mando. <b>Supr</b> la deja vacía.</div>
       <div class="controls-wrap"><table class="controls"><thead><tr><th>Acción</th><th>Teclado / mouse</th><th>Mando</th></tr></thead><tbody>${rows}</tbody></table></div>
       <div class="row"><label>Zona muerta del mando</label><input type="range" class="dz" min="0" max="0.5" step="0.01" value="${s.deadzone}"/><span class="dzv">${s.deadzone.toFixed(2)}</span></div>
       <div class="row"><label>Invertir pitch (mando)</label><input type="checkbox" class="inv" ${s.invertPitch ? 'checked' : ''}/></div>
       <button class="btn reset">Restablecer valores por defecto</button>`,
    );
    node.querySelectorAll<HTMLButtonElement>('.bind').forEach((b) =>
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        b.textContent = 'Presiona…';
        b.classList.add('waiting');
        const action = b.dataset.a as Action;
        const kind = b.dataset.kind as 'key' | 'pad';
        // Delay so this click itself is not captured
        setTimeout(() => {
          this.input.captureHandler = (code, k) => {
            if (code === 'Delete' && k === 'key') {
              if (kind === 'key') s.keys[action] = [];
              else s.pad[action] = [];
            } else if (kind === 'key' && k === 'key') {
              if (code !== 'Escape' || action === 'pause') s.keys[action] = [code];
            } else if (kind === 'pad' && k === 'pad') {
              s.pad[action] = [Number(code)];
            }
            this.input.save();
            this.showControls();
          };
        }, 50);
      }),
    );
    const dz = node.querySelector<HTMLInputElement>('.dz')!;
    dz.addEventListener('input', () => {
      s.deadzone = Number(dz.value);
      node.querySelector('.dzv')!.textContent = s.deadzone.toFixed(2);
      this.input.save();
    });
    node.querySelector<HTMLInputElement>('.inv')!.addEventListener('change', (e) => {
      s.invertPitch = (e.target as HTMLInputElement).checked;
      this.input.save();
    });
    node.querySelector('.reset')!.addEventListener('click', () => {
      s.keys = structuredClone(DEFAULT_KEYS);
      s.pad = structuredClone(DEFAULT_PAD);
      s.deadzone = 0.15;
      this.input.save();
      this.showControls();
    });
    this.mount('controls', node);
  }

  showSettings() {
    if (!this.inGame) this.backTarget = () => this.showMain();
    const c = this.settings.camera;
    const slider = (key: keyof typeof c, label: string, min: number, max: number, step: number) =>
      `<div class="row"><label>${label}</label><input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${c[key]}"/><span class="v">${c[key]}</span></div>`;
    const node = this.panel(
      'Ajustes',
      `<div class="section">Cámara (valores por defecto del juego real)</div>
       ${slider('fov', 'Campo de visión', 60, 110, 1)}
       ${slider('distance', 'Distancia', 100, 400, 10)}
       ${slider('height', 'Altura', 40, 200, 10)}
       ${slider('angle', 'Ángulo', -15, 0, 1)}
       ${slider('stiffness', 'Rigidez', 0, 1, 0.05)}
       ${slider('swivelSpeed', 'Velocidad de giro', 1, 10, 0.5)}
       ${slider('transitionSpeed', 'Velocidad de transición', 1, 2, 0.1)}
       <div class="row"><label>Sacudida de cámara</label><input type="checkbox" class="shake" ${c.shake ? 'checked' : ''}/></div>
       <button class="btn tiny cam-reset">Cámara por defecto</button>
       <div class="section">General</div>
       <div class="row"><label>Volumen</label><input type="range" class="vol" min="0" max="1" step="0.05" value="${this.settings.volume}"/></div>
       <div class="row"><label>Nombres sobre los autos</label><input type="checkbox" class="names" ${this.settings.showNames ? 'checked' : ''}/></div>
       <div class="row"><label>Servidor</label><input class="server" placeholder="(mismo servidor que la página)" value="${esc(this.settings.serverUrl)}"/></div>`,
    );
    node.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((inp) =>
      inp.addEventListener('input', () => {
        const k = inp.dataset.k as keyof typeof c;
        (c as unknown as Record<string, number>)[k] = Number(inp.value);
        inp.nextElementSibling!.textContent = inp.value;
        this.cb.settingsChanged();
      }),
    );
    node.querySelector('.cam-reset')!.addEventListener('click', () => {
      this.settings.camera = { ...DEFAULT_CAMERA };
      this.cb.settingsChanged();
      this.showSettings();
    });
    node.querySelector<HTMLInputElement>('.shake')!.addEventListener('change', (e) => {
      c.shake = (e.target as HTMLInputElement).checked;
      this.cb.settingsChanged();
    });
    node.querySelector<HTMLInputElement>('.vol')!.addEventListener('input', (e) => {
      this.settings.volume = Number((e.target as HTMLInputElement).value);
      this.cb.settingsChanged();
    });
    node.querySelector<HTMLInputElement>('.names')!.addEventListener('change', (e) => {
      this.settings.showNames = (e.target as HTMLInputElement).checked;
      this.cb.settingsChanged();
    });
    node.querySelector<HTMLInputElement>('.server')!.addEventListener('change', (e) => {
      this.settings.serverUrl = (e.target as HTMLInputElement).value.trim();
      this.cb.settingsChanged();
    });
    this.mount('settings', node);
  }
}

function fixedPad(a: Action): string {
  const map: Partial<Record<Action, string>> = {
    steerLeft: 'Stick izq. ←',
    steerRight: 'Stick izq. →',
    pitchUp: 'Stick izq. ↓',
    pitchDown: 'Stick izq. ↑',
    yawLeft: 'Stick izq. ←',
    yawRight: 'Stick izq. →',
  };
  return map[a] ?? '—';
}
