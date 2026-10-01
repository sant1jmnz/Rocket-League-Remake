import './styles.css';
import { emptyInput, type ServerMessage, type Team, type TeamSize } from '@rl/shared';
import { GameRenderer } from './render/renderer';
import { InputManager } from './input/manager';
import { GameAudio } from './audio/audio';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
import { defaultServerUrl, loadSettings, saveSettings } from './ui/settings';
import { OfflineSession, type Session } from './game/session';
import { NetClient, OnlineSession } from './net/online';

const canvas = document.querySelector<HTMLCanvasElement>('#game')!;
const overlay = document.querySelector<HTMLDivElement>('#overlay')!;

const settings = loadSettings();
const renderer = new GameRenderer(canvas);
const input = new InputManager(canvas);
const audio = new GameAudio();
const hud = new Hud();
overlay.append(hud.root);

let session: Session | null = null;
let net: NetClient | null = null;
let paused = false;
let endShown = false;
let pendingRoomCode: string | null = new URLSearchParams(location.search).get('sala');

// Background "attract mode" match behind the main menu
let attract: OfflineSession | null = null;
function startAttract() {
  attract = new OfflineSession({ teamSize: 3, freeplay: false, difficulty: 'allstar', playerName: '', team: 0 });
  attract.state.cars = attract.state.cars.filter((c) => c.id !== 1);
  attract.localCarId = -1;
}

function applySettings() {
  renderer.cam.settings = settings.camera;
  renderer.cam.updateFov(window.innerWidth / window.innerHeight);
  audio.setVolume(settings.volume);
  saveSettings(settings);
}

function endSession() {
  session?.dispose();
  session = null;
  paused = false;
  endShown = false;
  menus.setInGame(false);
  hud.show(false);
  renderer.cam.reset();
  if (!attract) startAttract();
}

async function ensureNet(): Promise<NetClient> {
  if (net?.connected) return net;
  net?.close();
  net = new NetClient();
  menus.showConnecting();
  await net.connect(settings.serverUrl || defaultServerUrl());
  net.onMessage = onServerMessage;
  net.onClose = (reason) => {
    net = null;
    if (session?.kind === 'online') endSession();
    menus.showOnline(reason);
  };
  return net;
}

function onServerMessage(m: ServerMessage) {
  if (!net) return;
  switch (m.t) {
    case 'room':
      if (m.room.status === 'lobby' && session?.kind === 'online') endSession();
      if (!session) menus.showLobby(m.room, net.playerId);
      break;
    case 'start':
      attract = null;
      session = new OnlineSession(net, m.carId, m.serverTick);
      paused = false;
      endShown = false;
      menus.setInGame(true);
      menus.hide();
      hud.show(true);
      renderer.cam.reset();
      break;
    case 'left':
      if (session?.kind === 'online') endSession();
      menus.showOnline();
      break;
    case 'error':
      menus.showOnline(m.message);
      break;
  }
}

async function online(action: (n: NetClient) => void) {
  try {
    const n = await ensureNet();
    action(n);
  } catch (e) {
    menus.showOnline((e as Error).message);
  }
}

function startOffline(opts: { teamSize: TeamSize; freeplay: boolean; difficulty: 'rookie' | 'pro' | 'allstar'; team: Team }) {
  attract = null;
  session = new OfflineSession({ ...opts, playerName: settings.playerName });
  paused = false;
  endShown = false;
  menus.setInGame(true);
  menus.hide();
  hud.show(true);
  renderer.cam.reset();
}

const menus = new Menus(settings, input, {
  playOffline: (o) => startOffline({ ...o, freeplay: false }),
  playFreeplay: () => startOffline({ teamSize: 1, freeplay: true, difficulty: 'pro', team: 0 }),
  createRoom: (teamSize) => online((n) => n.send({ t: 'create', name: settings.playerName, teamSize })),
  joinRoom: (code) => online((n) => n.send({ t: 'join', name: settings.playerName, code })),
  quickMatch: (teamSize) => online((n) => n.send({ t: 'quick', name: settings.playerName, teamSize })),
  setTeam: (team) => net?.send({ t: 'team', team }),
  setTeamSize: (teamSize) => net?.send({ t: 'size', teamSize }),
  startRoom: () => net?.send({ t: 'start' }),
  leaveRoom: () => {
    net?.send({ t: 'leave' });
  },
  resume: () => {
    paused = false;
    if (session instanceof OfflineSession) session.paused = false;
    menus.hide();
  },
  quitToMenu: () => {
    if (session?.kind === 'online') net?.send({ t: 'leave' });
    endSession();
    menus.showMain();
  },
  restartOffline: () => {
    if (session instanceof OfflineSession) {
      session.restart();
      session.paused = false;
      paused = false;
      endShown = false;
      menus.hide();
    }
  },
  settingsChanged: applySettings,
});
overlay.append(menus.root);
hud.show(false);
applySettings();
startAttract();
menus.showMain();

// Invite links (?sala=CODE) join once the first frames are on screen
if (pendingRoomCode) {
  const code = pendingRoomCode;
  pendingRoomCode = null;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => void online((n) => n.send({ t: 'join', name: settings.playerName, code }))),
  );
}

const unlock = () => audio.unlock();
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);
window.addEventListener('resize', () => renderer.resize());

let last = performance.now();
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const { input: ci, ui } = input.read();

  if (session) {
    if (ui.pausePressed) {
      if (menus.visible && menus.screen !== 'end') {
        paused = false;
        if (session instanceof OfflineSession) session.paused = false;
        menus.hide();
      } else if (!menus.visible) {
        paused = true;
        if (session instanceof OfflineSession) session.paused = true;
        menus.showPause(session.kind === 'offline');
      }
    }
    if (ui.ballCamPressed && !menus.visible) renderer.cam.ballCam = !renderer.cam.ballCam;
    const controls = menus.visible ? emptyInput() : ci;
    const events = session.frame(dt, controls);
    const { prev, curr } = session.view();
    const local = curr.cars.find((c) => c.id === session!.localCarId) ?? null;
    renderer.handleEvents(events, curr, session.localCarId);
    hud.handleEvents(events, curr, session.localCarId);
    audio.handleEvents(events, session.localCarId);
    renderer.render(prev, curr, session.alpha, paused && session.kind === 'offline' ? 0 : dt, { localCarId: session.localCarId, showNames: settings.showNames }, ui.swivel);
    hud.update(dt, curr, session.localCarId, { scoreboard: ui.scoreboardHeld, ballCam: renderer.cam.ballCam, status: session.status() });
    audio.updateCar(paused ? null : local);

    if (curr.phase === 'ended' && !endShown && session.kind === 'offline') {
      endShown = true;
      const won = local && local.team === curr.winner;
      setTimeout(() => {
        if (session && curr.phase === 'ended') menus.showMatchEnd(won ? '¡Victoria!' : 'Derrota', true);
      }, 3000);
    }
  } else if (attract) {
    const events = attract.frame(dt, emptyInput());
    if (attract.state.phase === 'ended') startAttract();
    const { prev, curr } = attract.view();
    renderer.handleEvents(events, curr, null);
    renderer.render(prev, curr, attract.alpha, dt, { localCarId: null, showNames: false }, { x: 0, y: 0 });
    audio.updateCar(null);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Expose for debugging / automated tests
(window as unknown as Record<string, unknown>).__game = {
  get session() {
    return session;
  },
  get net() {
    return net;
  },
  renderer,
  menus,
};
