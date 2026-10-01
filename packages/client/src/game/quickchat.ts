import { QUICK_CHAT } from '@rl/shared';

/** Two-step selector like the real game: a category key, then the key whose number is the option. */
export class QuickChat {
  private category = 0;
  private timer = 0;

  /** Returns the message to send, if one was completed. */
  press(key: number): string | null {
    if (this.category === 0) {
      this.category = key;
      this.timer = 2.5;
      return null;
    }
    const msg = QUICK_CHAT[this.category - 1].options[key - 1];
    this.category = 0;
    return msg ?? null;
  }

  update(dt: number) {
    if (this.category && (this.timer -= dt) <= 0) this.category = 0;
  }

  get open(): { title: string; options: string[] } | null {
    return this.category ? QUICK_CHAT[this.category - 1] : null;
  }
}
