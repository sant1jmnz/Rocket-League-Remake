// Rocket League physics & game constants (soccar).
// Sources: RLBot wiki ("Useful game values"), RocketSim, Samuel P. Mish's "Rocket Science" notes.
// Units: uu (1 uu = 1 cm), seconds, radians.

export const TICK_RATE = 120;
export const DT = 1 / TICK_RATE;

export const GRAVITY = -650;

// ---------------------------------------------------------------------------
// Arena (DFH Stadium / standard soccar)
// ---------------------------------------------------------------------------
export const ARENA = {
  /** Side walls at x = ±HALF_WIDTH */
  HALF_WIDTH: 4096,
  /** Back walls at y = ±HALF_LENGTH */
  HALF_LENGTH: 5120,
  HEIGHT: 2044,
  /** Corners are cut at 45°: |x| + |y| <= CORNER_PLANE */
  CORNER_PLANE: 4096 + 5120 - 1152,
  /** Radius of the curved transitions between floor/walls/ceiling */
  CURVE_RADIUS: 256,
} as const;

export const GOAL = {
  HALF_WIDTH: 892.755,
  HEIGHT: 642.775,
  DEPTH: 880,
} as const;

// ---------------------------------------------------------------------------
// Ball (RocketSim RLConst)
// ---------------------------------------------------------------------------
export const BALL = {
  RADIUS: 91.25,
  MASS: 30,
  RESTITUTION: 0.6,
  FRICTION: 0.35,
  /** Bullet linear damping: v *= (1 - DRAG)^dt */
  DRAG: 0.03,
  MAX_SPEED: 6000,
  MAX_ANG_SPEED: 6,
  /** Rest height on the floor (radius + collision margin of the arena mesh) */
  REST_Z: 93.15,
  KICKOFF_Z: 93.15,
  /** The ball counts as scored when |y| > GOAL_THRESHOLD_Y + RADIUS */
  GOAL_THRESHOLD_Y: 5124.25,
} as const;

/** Psyonix extra impulse when a car touches the ball: scale over relative speed. */
export const BALL_HIT_SCALE: readonly (readonly [number, number])[] = [
  [0, 0.65],
  [500, 0.65],
  [2300, 0.55],
  [4600, 0.3],
];
export const BALL_HIT_MAX_REL_SPEED = 4600;
export const BALL_HIT_Z_SCALE = 0.35;
export const BALL_HIT_FORWARD_SCALE = 0.65;

/** Contact materials (friction / restitution) used by the solver. */
export const MATERIAL = {
  CAR_WORLD: { friction: 0.3, restitution: 0.3 },
  CAR_BALL: { friction: 2, restitution: 0 },
  CAR_CAR: { friction: 0.09, restitution: 0.1 },
  /** Below this approach speed there is no bounce (Bullet: 0.2 m/s) */
  RESTITUTION_THRESHOLD: 10,
} as const;

// ---------------------------------------------------------------------------
// Car (Octane, values from RocketSim: CarConfig + RLConst + btVehicleRL)
// ---------------------------------------------------------------------------
type Curve = readonly (readonly [number, number])[];
const HITBOX_SIZE = { x: 120.507, y: 86.6994, z: 38.6591 };

export const CAR = {
  MASS: 180,
  HITBOX_SIZE,
  HITBOX_HALF: { x: HITBOX_SIZE.x / 2, y: HITBOX_SIZE.y / 2, z: HITBOX_SIZE.z / 2 },
  HITBOX_OFFSET: { x: 13.8757, y: 0, z: 20.755 },
  /** Spawn height of the car origin on the floor */
  REST_HEIGHT: 17,
  /** Respawn height after a demolition (the car drops in) */
  RESPAWN_Z: 36,

  /** Suspension ray start points in car space (front-left, front-right, back-left, back-right) */
  WHEELS: [
    { x: 51.25, y: 25.9, z: 20.755, front: true },
    { x: 51.25, y: -25.9, z: 20.755, front: true },
    { x: -33.75, y: 29.5, z: 20.755, front: false },
    { x: -33.75, y: -29.5, z: 20.755, front: false },
  ],
  FRONT_WHEEL_RADIUS: 12.5,
  BACK_WHEEL_RADIUS: 15,
  FRONT_SUSPENSION_REST: 38.755,
  BACK_SUSPENSION_REST: 37.055,

  SUSPENSION_STIFFNESS: 500,
  SUSPENSION_DAMP_COMPRESSION: 25,
  SUSPENSION_DAMP_RELAXATION: 40,
  SUSPENSION_MAX_TRAVEL: 12,
  /** 0.05 Bullet units */
  SUSPENSION_SUBTRACTION: 2.5,
  SUSPENSION_FORCE_SCALE_FRONT: 36 - 1 / 4,
  SUSPENSION_FORCE_SCALE_BACK: 54 + 1 / 4 + 1.5 / 100,

  MAX_SPEED: 2300,
  MAX_ANG_SPEED: 5.5,
  SUPERSONIC_START: 2200,
  SUPERSONIC_MAINTAIN: 2100,
  SUPERSONIC_MAINTAIN_TIME: 1,

  /** Engine force per wheel = MASS * THROTTLE_TORQUE (4 wheels → 1600 uu/s²) */
  THROTTLE_TORQUE: 400,
  /** Brake force per wheel = MASS * BRAKE_TORQUE (→ 3500 uu/s²) */
  BRAKE_TORQUE: 14.25 + 1 / 3,
  STOPPING_FORWARD_VEL: 25,
  COASTING_BRAKE_FACTOR: 0.15,
  BRAKING_NO_THROTTLE_SPEED_THRESH: 0.01,
  THROTTLE_DEADZONE: 0.001,
  AIR_THROTTLE_ACCEL: 200 / 3,
  POWERSLIDE_RISE_RATE: 5,
  POWERSLIDE_FALL_RATE: 2,

  DRIVE_SPEED_TORQUE_FACTOR: [
    [0, 1],
    [1400, 0.1],
    [1410, 0],
  ] as Curve,
  /** Max front wheel steer angle (rad) over forward speed */
  STEER_ANGLE: [
    [0, 0.53356],
    [500, 0.3193],
    [1000, 0.18203],
    [1500, 0.1057],
    [1750, 0.08507],
    [3000, 0.03454],
  ] as Curve,
  POWERSLIDE_STEER_ANGLE: [
    [0, 0.39235],
    [2500, 0.1261],
  ] as Curve,
  NON_STICKY_FRICTION: [
    [0, 0.1],
    [0.7075, 0.5],
    [1, 1],
  ] as Curve,
  LAT_FRICTION: [
    [0, 1],
    [1, 0.2],
  ] as Curve,
  HANDBRAKE_LAT_FRICTION: [[0, 0.1]] as Curve,
  HANDBRAKE_LONG_FRICTION: [
    [0, 0.5],
    [1, 0.9],
  ] as Curve,
  ROLLING_FRICTION_SCALE: 113.73963,

  BOOST_ACCEL_GROUND: 2975 / 3,
  BOOST_ACCEL_AIR: 3175 / 3,
  BOOST_USE_PER_SEC: 100 / 3,
  BOOST_MIN_TIME: 0.1,
  BOOST_START: 100 / 3,
  BOOST_MAX: 100,

  JUMP_IMPULSE: 875 / 3,
  JUMP_ACCEL: 4375 / 3,
  JUMP_MIN_TIME: 0.025,
  JUMP_MAX_TIME: 0.2,
  JUMP_RESET_TIME_PAD: 1 / 40,
  JUMP_PRE_MIN_ACCEL_SCALE: 0.62,
  /** Time after the jump during which the second jump / flip is available */
  DOUBLE_JUMP_WINDOW: 1.25,
  DODGE_DEADZONE: 0.5,

  FLIP_Z_DAMP_120: 0.35,
  FLIP_Z_DAMP_START: 0.15,
  FLIP_Z_DAMP_END: 0.21,
  FLIP_TORQUE_TIME: 0.65,
  FLIP_PITCHLOCK_EXTRA_TIME: 0.3,
  FLIP_INITIAL_VEL: 500,
  /** Flip angular acceleration (rad/s²): roll for side flips, pitch for front/back flips */
  FLIP_TORQUE_X: 260,
  FLIP_TORQUE_Y: 224,
  FLIP_FORWARD_SPEED_SCALE: 1,
  FLIP_SIDE_SPEED_SCALE: 1.9,
  FLIP_BACKWARD_SPEED_SCALE: 2.5,
  FLIP_BACKWARD_X_SCALE: 16 / 15,

  /** Air control (pitch, yaw, roll) torques and damping, multiplied by TORQUE_SCALE → rad/s² */
  AIR_TORQUE: { pitch: 130, yaw: 95, roll: 400 },
  AIR_DAMP: { pitch: 30, yaw: 20, roll: 50 },
  TORQUE_SCALE: ((2 * Math.PI) / (1 << 16)) * 1000,

  AUTOFLIP_IMPULSE: 200,
  AUTOFLIP_TORQUE: 50,
  AUTOFLIP_TIME: 0.4,
  AUTOFLIP_NORMZ_THRESH: Math.SQRT1_2,
  AUTOFLIP_ROLL_THRESH: 2.8,
  AUTOROLL_FORCE: 100,
  AUTOROLL_TORQUE: 80,

  DEMO_RESPAWN_TIME: 3,
  BUMP_COOLDOWN: 0.25,
  /** A bump/demo needs the contact this far in front of the car origin (the bumper) */
  BUMP_MIN_FORWARD_DIST: 64.5,
} as const;

/** Bump velocity given to the victim by attacker speed (uu/s) */
export const BUMP_VEL_GROUND: readonly (readonly [number, number])[] = [
  [0, 5 / 6],
  [1400, 1100],
  [2200, 1530],
];
export const BUMP_VEL_AIR: readonly (readonly [number, number])[] = [
  [0, 5 / 6],
  [1400, 1390],
  [2200, 1945],
];
export const BUMP_UPWARD_VEL: readonly (readonly [number, number])[] = [
  [0, 2 / 6],
  [1400, 278],
  [2200, 417],
];

// ---------------------------------------------------------------------------
// Boost pads (RocketSim RLConst::BoostPads)
// ---------------------------------------------------------------------------
export const BOOST_PAD = {
  SMALL_AMOUNT: 12,
  BIG_AMOUNT: 100,
  SMALL_RESPAWN: 4,
  BIG_RESPAWN: 10,
  /** Pickup cylinder around the car origin */
  SMALL_RADIUS: 144,
  BIG_RADIUS: 208,
  CYL_HEIGHT: 95,
  /** While a car stays on a pad it keeps "locking" it with this box (vs the car's bounds) */
  SMALL_BOX: 120,
  BIG_BOX: 160,
  BOX_HEIGHT: 64,
} as const;

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------
export const MATCH = {
  DURATION: 300,
  COUNTDOWN: 3,
  GOAL_CELEBRATION: 3,
  /** Goal explosion: cars within this radius of the ball are pushed away */
  GOAL_EXPLOSION_RADIUS: 1800,
  GOAL_EXPLOSION_IMPULSE: 2600,
  /** Goal replay after the celebration (skippable when every player presses jump) */
  REPLAY: 5.5,
  /** The replay starts this long before the goal (the rest shows the explosion) */
  REPLAY_LEAD: 4.5,
  /** Time after the final buzzer before showing results */
  END_DELAY: 3,
  /** Points (scoreboard) */
  POINTS_GOAL: 100,
  POINTS_ASSIST: 50,
  POINTS_SAVE: 50,
  POINTS_SHOT: 20,
  POINTS_DEMO: 25,
  POINTS_TOUCH: 2,
  ASSIST_WINDOW: 5,
} as const;

export type Team = 0 | 1; // 0 = blue (defends -Y), 1 = orange (defends +Y)
export const TEAM_NAMES = ['Azul', 'Naranja'] as const;
