// Default bindings copied from the real game's PC defaults (keyboard + mouse) and controller defaults.

export type Action =
  | 'throttle'
  | 'reverse'
  | 'steerLeft'
  | 'steerRight'
  | 'pitchUp'
  | 'pitchDown'
  | 'yawLeft'
  | 'yawRight'
  | 'airRoll'
  | 'airRollLeft'
  | 'airRollRight'
  | 'jump'
  | 'boost'
  | 'powerslide'
  | 'ballCam'
  | 'scoreboard'
  | 'pause'
  | 'resetBall'
  | 'chatInfo'
  | 'chatCompliments'
  | 'chatReactions'
  | 'chatApologies';

export const ACTION_LABELS: Record<Action, string> = {
  throttle: 'Acelerar',
  reverse: 'Reversa / frenar',
  steerLeft: 'Girar a la izquierda',
  steerRight: 'Girar a la derecha',
  pitchUp: 'Pitch arriba (nariz arriba)',
  pitchDown: 'Pitch abajo (nariz abajo)',
  yawLeft: 'Yaw izquierda',
  yawRight: 'Yaw derecha',
  airRoll: 'Air roll',
  airRollLeft: 'Air roll izquierda',
  airRollRight: 'Air roll derecha',
  jump: 'Saltar',
  boost: 'Boost',
  powerslide: 'Powerslide',
  ballCam: 'Ball cam',
  scoreboard: 'Marcador',
  pause: 'Menú / pausa',
  resetBall: 'Reiniciar balón (entrenamiento)',
  chatInfo: 'Quick chat: información',
  chatCompliments: 'Quick chat: felicitaciones',
  chatReactions: 'Quick chat: reacciones',
  chatApologies: 'Quick chat: disculpas',
};

/** Keyboard codes (KeyboardEvent.code) or mouse buttons as "Mouse0".."Mouse4". */
export type KeyBindings = Record<Action, string[]>;

export const DEFAULT_KEYS: KeyBindings = {
  throttle: ['KeyW'],
  reverse: ['KeyS'],
  steerLeft: ['KeyA'],
  steerRight: ['KeyD'],
  pitchUp: ['KeyS'],
  pitchDown: ['KeyW'],
  yawLeft: ['KeyA'],
  yawRight: ['KeyD'],
  airRoll: ['ShiftLeft'],
  airRollLeft: ['KeyQ'],
  airRollRight: ['KeyE'],
  jump: ['Mouse2'],
  boost: ['Mouse0'],
  powerslide: ['ShiftLeft'],
  ballCam: ['Space'],
  scoreboard: ['Tab'],
  pause: ['Escape'],
  resetBall: ['KeyR'],
  chatInfo: ['Digit1'],
  chatCompliments: ['Digit2'],
  chatReactions: ['Digit3'],
  chatApologies: ['Digit4'],
};

/**
 * Gamepad bindings use the W3C "standard" mapping button indices:
 * 0 A/✕, 1 B/○, 2 X/□, 3 Y/△, 4 LB, 5 RB, 6 LT, 7 RT, 8 View/Share, 9 Menu/Options,
 * 10 L3, 11 R3, 12-15 D-pad. Axes (sticks/triggers) are fixed.
 */
export type PadBindings = Partial<Record<Action, number[]>>;

export const DEFAULT_PAD: PadBindings = {
  throttle: [7],
  reverse: [6],
  jump: [0],
  boost: [1],
  powerslide: [2],
  airRoll: [2],
  airRollLeft: [],
  airRollRight: [],
  ballCam: [3],
  scoreboard: [8],
  pause: [9],
  resetBall: [11],
  chatInfo: [12],
  chatCompliments: [14],
  chatReactions: [15],
  chatApologies: [13],
};

export const PAD_BUTTON_NAMES = [
  'A / ✕',
  'B / ○',
  'X / □',
  'Y / △',
  'LB / L1',
  'RB / R1',
  'LT / L2',
  'RT / R2',
  'View / Share',
  'Menu / Options',
  'L3',
  'R3',
  'D-pad ↑',
  'D-pad ↓',
  'D-pad ←',
  'D-pad →',
];

export function keyLabel(code: string): string {
  if (code.startsWith('Mouse')) {
    return ['Clic izquierdo', 'Clic central', 'Clic derecho', 'Mouse 4', 'Mouse 5'][Number(code.slice(5))] ?? code;
  }
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ShiftLeft: 'Shift izq.',
    ShiftRight: 'Shift der.',
    ControlLeft: 'Ctrl izq.',
    ControlRight: 'Ctrl der.',
    AltLeft: 'Alt izq.',
    Space: 'Espacio',
    Escape: 'Esc',
    Tab: 'Tab',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
  };
  return map[code] ?? code;
}

export interface InputSettings {
  keys: KeyBindings;
  pad: PadBindings;
  deadzone: number;
  /** keyboard steering is digital in the real game; kept as is */
  invertPitch: boolean;
}

const STORAGE_KEY = 'rlr.input.v1';

export function loadInputSettings(): InputSettings {
  const defaults: InputSettings = {
    keys: structuredClone(DEFAULT_KEYS),
    pad: structuredClone(DEFAULT_PAD),
    deadzone: 0.15,
    invertPitch: false,
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const saved = JSON.parse(raw) as Partial<InputSettings>;
    return {
      keys: { ...defaults.keys, ...(saved.keys ?? {}) },
      pad: { ...defaults.pad, ...(saved.pad ?? {}) },
      deadzone: saved.deadzone ?? defaults.deadzone,
      invertPitch: saved.invertPitch ?? defaults.invertPitch,
    };
  } catch {
    return defaults;
  }
}

export function saveInputSettings(s: InputSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // storage unavailable (private mode): settings only last for this session
  }
}
