// Standard soccar boost pad layout (34 pads: 6 big, 28 small), same positions as the real game.

export interface BoostPadDef {
  x: number;
  y: number;
  z: number;
  big: boolean;
}

const S = (x: number, y: number): BoostPadDef => ({ x, y, z: 70, big: false });
const B = (x: number, y: number): BoostPadDef => ({ x, y, z: 73, big: true });

export const BOOST_PADS: readonly BoostPadDef[] = [
  S(0, -4240),
  S(-1792, -4184),
  S(1792, -4184),
  B(-3072, -4096),
  B(3072, -4096),
  S(-940, -3308),
  S(940, -3308),
  S(0, -2816),
  S(-3584, -2484),
  S(3584, -2484),
  S(-1788, -2300),
  S(1788, -2300),
  S(-2048, -1036),
  S(0, -1024),
  S(2048, -1036),
  B(-3584, 0),
  S(-1024, 0),
  S(1024, 0),
  B(3584, 0),
  S(-2048, 1036),
  S(0, 1024),
  S(2048, 1036),
  S(-1788, 2300),
  S(1788, 2300),
  S(-3584, 2484),
  S(3584, 2484),
  S(0, 2816),
  S(-940, 3308),
  S(940, 3308),
  B(-3072, 4096),
  B(3072, 4096),
  S(-1792, 4184),
  S(1792, 4184),
  S(0, 4240),
];
