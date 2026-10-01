import type { CarBody } from '@rl/shared';
import { DEFAULT_CAMERA, type CameraSettings } from '../camera/camera';

export interface AppSettings {
  playerName: string;
  carBody: CarBody;
  camera: CameraSettings;
  volume: number;
  showNames: boolean;
  serverUrl: string;
}

const KEY = 'rlr.settings.v1';

export function defaultServerUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export function loadSettings(): AppSettings {
  const d: AppSettings = {
    playerName: `Jugador${Math.floor(Math.random() * 900 + 100)}`,
    carBody: 'octane',
    camera: { ...DEFAULT_CAMERA },
    volume: 0.6,
    showNames: true,
    serverUrl: '',
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<AppSettings>;
    return { ...d, ...s, camera: { ...d.camera, ...(s.camera ?? {}) } };
  } catch {
    return d;
  }
}

export function saveSettings(s: AppSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore (storage unavailable)
  }
}
