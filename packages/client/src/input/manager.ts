import { emptyInput, type ControllerInput } from '@rl/shared';
import { loadInputSettings, saveInputSettings, type Action, type InputSettings } from './bindings';

/** UI-level actions that are not part of the car controls. */
export interface UiState {
  ballCamPressed: boolean;
  scoreboardHeld: boolean;
  pausePressed: boolean;
  swivel: { x: number; y: number };
}

/**
 * Reads keyboard, mouse and gamepads and produces the car's ControllerInput.
 * Keyboard and gamepad are merged so either can be used at any time.
 */
export class InputManager {
  settings: InputSettings = loadInputSettings();
  private down = new Set<string>();
  private prevUi = { ballCam: false, pause: false };
  /** When set, the next key/button press is captured for rebinding instead of played. */
  captureHandler: ((code: string, kind: 'key' | 'pad') => void) | null = null;
  enabled = true;
  private prevPadButtons: boolean[] = [];

  constructor(private target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('blur', () => this.down.clear());
  }

  save() {
    saveInputSettings(this.settings);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.captureHandler) {
      e.preventDefault();
      const h = this.captureHandler;
      this.captureHandler = null;
      h(e.code, 'key');
      return;
    }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
    this.down.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
  };

  private onMouseDown = (e: MouseEvent) => {
    if (this.captureHandler) {
      e.preventDefault();
      const h = this.captureHandler;
      this.captureHandler = null;
      h(`Mouse${e.button}`, 'key');
      return;
    }
    this.down.add(`Mouse${e.button}`);
  };

  private onMouseUp = (e: MouseEvent) => {
    this.down.delete(`Mouse${e.button}`);
  };

  private key(action: Action): boolean {
    return this.settings.keys[action]?.some((k) => this.down.has(k)) ?? false;
  }

  private pads(): Gamepad[] {
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.from(list).filter((p): p is Gamepad => !!p && p.connected);
  }

  /** Polls gamepads for rebinding capture. */
  pollCapture() {
    if (!this.captureHandler) return;
    for (const pad of this.pads()) {
      pad.buttons.forEach((b, i) => {
        const was = this.prevPadButtons[i];
        if (b.pressed && !was && this.captureHandler) {
          const h = this.captureHandler;
          this.captureHandler = null;
          h(String(i), 'pad');
        }
      });
      this.prevPadButtons = pad.buttons.map((b) => b.pressed);
    }
  }

  gamepadConnected(): boolean {
    return this.pads().length > 0;
  }

  read(): { input: ControllerInput; ui: UiState } {
    const input = emptyInput();
    const ui: UiState = { ballCamPressed: false, scoreboardHeld: false, pausePressed: false, swivel: { x: 0, y: 0 } };
    if (!this.enabled) return { input, ui };
    this.pollCapture();

    const k = (a: Action) => (this.key(a) ? 1 : 0);
    // Keyboard (digital, like the real game)
    let throttle = k('throttle') - k('reverse');
    let steer = k('steerRight') - k('steerLeft');
    let pitch = k('pitchUp') - k('pitchDown');
    let yaw = k('yawRight') - k('yawLeft');
    let roll = k('airRollRight') - k('airRollLeft');
    let airRoll = this.key('airRoll');
    let jump = this.key('jump');
    let boost = this.key('boost');
    let handbrake = this.key('powerslide');
    let ballCam = this.key('ballCam');
    let scoreboard = this.key('scoreboard');
    let pause = this.key('pause');

    // Gamepads
    const dz = this.settings.deadzone;
    const axis = (v: number) => (Math.abs(v) < dz ? 0 : (v - Math.sign(v) * dz) / (1 - dz));
    for (const pad of this.pads()) {
      const btn = (a: Action) => (this.settings.pad[a] ?? []).some((i) => pad.buttons[i]?.pressed);
      const btnValue = (a: Action) => Math.max(0, ...(this.settings.pad[a] ?? []).map((i) => pad.buttons[i]?.value ?? 0));
      const lx = axis(pad.axes[0] ?? 0);
      const ly = axis(pad.axes[1] ?? 0);
      const rx = axis(pad.axes[2] ?? 0);
      const ry = axis(pad.axes[3] ?? 0);
      const t = btnValue('throttle') - btnValue('reverse');
      if (Math.abs(t) > Math.abs(throttle)) throttle = t;
      if (Math.abs(lx) > Math.abs(steer)) steer = lx;
      if (Math.abs(lx) > Math.abs(yaw)) yaw = lx;
      // Stick back (down) = nose up, like the game's default
      const p = this.settings.invertPitch ? -ly : ly;
      if (Math.abs(p) > Math.abs(pitch)) pitch = p;
      if (btn('airRollLeft')) roll = -1;
      if (btn('airRollRight')) roll = 1;
      airRoll ||= btn('airRoll');
      jump ||= btn('jump');
      boost ||= btn('boost');
      handbrake ||= btn('powerslide');
      ballCam ||= btn('ballCam');
      scoreboard ||= btn('scoreboard');
      pause ||= btn('pause');
      if (Math.abs(rx) > Math.abs(ui.swivel.x)) ui.swivel.x = rx;
      if (Math.abs(ry) > Math.abs(ui.swivel.y)) ui.swivel.y = -ry;
    }

    // Air roll: while held, yaw input becomes roll
    if (airRoll) {
      if (roll === 0) roll = yaw;
      yaw = 0;
    }

    input.throttle = throttle;
    input.steer = steer;
    input.pitch = pitch;
    input.yaw = yaw;
    input.roll = Math.max(-1, Math.min(1, roll));
    input.jump = jump;
    input.boost = boost;
    input.handbrake = handbrake;

    ui.ballCamPressed = ballCam && !this.prevUi.ballCam;
    ui.pausePressed = pause && !this.prevUi.pause;
    ui.scoreboardHeld = scoreboard;
    this.prevUi = { ballCam, pause };
    return { input, ui };
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
  }
}
