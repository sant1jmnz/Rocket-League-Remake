import '@fontsource/exo-2/700-italic.css';
import '@fontsource/exo-2/800-italic.css';
import '@fontsource/exo-2/900-italic.css';
import '@fontsource/titillium-web/400.css';
import '@fontsource/titillium-web/600.css';
import '@fontsource/titillium-web/700.css';
import './styles.css';
import { MATCH, emptyInput, type ServerMessage, type Team, type TeamSize } from '@rl/shared';
import { GameRenderer } from './render/renderer';
import { InputManager } from './input/manager';
import { GameAudio } from './audio/audio';
import { Hud } from './ui/hud';
import { Menus } from './ui/menus';
import { defaultServerUrl, loadSettings, saveSettings } from './ui/settings';
import { OfflineSession, type Session } from './game/session';
import { NetClient, OnlineSession } from './net/online';
import { QuickChat } from './game/quickchat';
import { ReplayDirector } from './game/replay';
import { keyLabel } from './input/bindings';

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
const quickChat = new QuickChat();
let replay = new ReplayDirector();
let replayCam: boolean | null = null; // user's ball-cam setting while a replay overrides it
let endShown = false;
let pendingRoomCode: string | null = new URLSearchParams(location.search).get('sala');

// Team color previewed in the garage (main menu background)
let previewTeam: Team = 0;

function applySettings() {
  renderer.cam.settings = settings.camera;
  renderer.cam.updateFov(window.innerWidth / window.innerHeight);
  audio.setVolume(settings.volume);
  saveSettings(settings);
}

function endSession() {
  replay = new ReplayDirector();
  stopReplayView();
  session?.dispose();
  session = null;
  paused = false;
  endShown = false;
  menus.setInGame(false);
  hud.show(false);
  renderer.cam.reset();
}

function stopReplayView() {
  if (replayCam === null) return;
  renderer.cam.ballCam = replayCam;
  replayCam = null;
  renderer.cam.reset();
  hud.setReplay(null);
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
      session = new OnlineSession(net, m.carId, m.serverTick);
      paused = false;
      endShown = false;
      menus.setInGame(true);
      menus.hide();
      hud.show(true);
      renderer.cam.reset();
      renderer.hideShowcase();
      break;
    case 'left':
      if (session?.kind === 'online') endSession();
      menus.showOnline();
      break;
    case 'error':
      menus.showOnline(m.message);
      break;
    case 'chat':
      if (session?.kind === 'online') hud.chat(m.from, m.team, m.text);
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
  session = new OfflineSession({ ...opts, playerName: settings.playerName, body: settings.carBody });
  paused = false;
  endShown = false;
  menus.setInGame(true);
  menus.hide();
  hud.show(true);
  renderer.cam.reset();
  renderer.hideShowcase();
}

const menus = new Menus(settings, input, {
  playOffline: (o) => startOffline({ ...o, freeplay: false }),
  playFreeplay: () => startOffline({ teamSize: 1, freeplay: true, difficulty: 'pro', team: 0 }),
  createRoom: (teamSize) => online((n) => n.send({ t: 'create', name: settings.playerName, teamSize, body: settings.carBody })),
  joinRoom: (code) => online((n) => n.send({ t: 'join', name: settings.playerName, code, body: settings.carBody })),
  quickMatch: (teamSize) => online((n) => n.send({ t: 'quick', name: settings.playerName, teamSize, body: settings.carBody })),
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
  previewTeam: (t) => (previewTeam = t),
});
overlay.append(menus.root);
hud.show(false);
applySettings();
menus.showMain();

// Invite links (?sala=CODE) join once the first frames are on screen
if (pendingRoomCode) {
  const code = pendingRoomCode;
  pendingRoomCode = null;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => void online((n) => n.send({ t: 'join', name: settings.playerName, code, body: settings.carBody }))),
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
    if (ui.resetPressed && !menus.visible && session instanceof OfflineSession) session.resetFreeplay();
    if (ui.chatPressed && !menus.visible) {
      const msg = quickChat.press(ui.chatPressed);
      if (msg) {
        const me = session.state.cars.find((c) => c.id === session!.localCarId);
        if (session.kind === 'online') net?.send({ t: 'chat', text: msg });
        else if (me) hud.chat(me.name, me.team, msg);
      }
    }
    quickChat.update(dt);
    const open = quickChat.open;
    hud.showChatMenu(open ? open.title : null, open?.options);
    const controls = menus.visible ? emptyInput() : ci;
    const events = session.frame(dt, controls);
    const { prev, curr } = session.view();
    const local = curr.cars.find((c) => c.id === session!.localCarId) ?? null;
    const frameDt = paused && session.kind === 'offline' ? 0 : dt;
    const bodyOf = (id: number) => session!.bodyOf(id);
    replay.handleEvents(events, curr);
    replay.record(curr);
    const rp = replay.frame(curr);
    if (rp) {
      // Goal replay: show the recorded moments with the camera on the scorer
      if (replayCam === null) {
        replayCam = renderer.cam.ballCam;
        renderer.cam.ballCam = true;
        renderer.cam.reset();
      }
      if (rp.goalEvent) {
        renderer.handleEvents([rp.goalEvent], rp.curr, rp.focusCarId);
        audio.handleEvents([rp.goalEvent], rp.focusCarId);
      }
      renderer.render(rp.prev, rp.curr, rp.alpha, frameDt, { localCarId: rp.focusCarId, showNames: true, bodyOf }, { x: 0, y: 0 });
      const scorer = rp.curr.cars.find((c) => c.id === rp.focusCarId);
      const humans = curr.cars.filter((c) => !c.isBot);
      hud.setReplay({
        scorer: scorer?.name ?? 'Gol',
        team: rp.goal.team,
        kph: Math.round(rp.goal.speed * 0.036),
        votes: curr.replaySkips.length,
        needed: humans.length,
        voted: session.localCarId !== null && curr.replaySkips.includes(session.localCarId),
        skipKey: `${keyLabel(input.settings.keys.jump?.[0] ?? 'Mouse2')} / A`,
      });
    } else {
      stopReplayView();
      renderer.handleEvents(events, curr, session.localCarId);
      renderer.render(prev, curr, session.alpha, frameDt, { localCarId: session.localCarId, showNames: settings.showNames, bodyOf }, ui.swivel);
    }
    hud.handleEvents(events, curr, session.localCarId);
    audio.handleEvents(events, session.localCarId);
    hud.update(dt, curr, session.localCarId, { scoreboard: ui.scoreboardHeld, ballCam: renderer.cam.ballCam, status: session.status() });
    audio.updateCar(paused || rp ? null : local);

    if (curr.phase === 'ended' && !endShown) {
      endShown = true;
      const shown = session;
      setTimeout(() => {
        if (session === shown && session.state.phase === 'ended') menus.showMatchEnd(session.state, session.localCarId, session.kind === 'offline');
      }, MATCH.END_DELAY * 1000);
    }
  } else {
    renderer.renderShowcase(dt, settings.carBody, previewTeam);
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
