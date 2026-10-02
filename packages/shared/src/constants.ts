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
// Ball
// ---------------------------------------------------------------------------
export const BALL = {
  RADIUS: 91.25,
  MASS: 30,
  RESTITUTION: 0.6,
  FRICTION: 0.35,
  DRAG: 0.0305,
  MAX_SPEED: 6000,
  MAX_ANG_SPEED: 6,
  KICKOFF_Z: 92.75,
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

// ---------------------------------------------------------------------------
// Car (Octane hitbox)
// ---------------------------------------------------------------------------
export const CAR = {
  MASS: 180,
  HITBOX_HALF: { x: 118.01 / 2, y: 84.2 / 2, z: 36.16 / 2 },
  HITBOX_OFFSET: { x: 13.88, y: 0, z: 20.75 },
  /** Height of the car origin above a flat surface when resting on its wheels */
  REST_HEIGHT: 17.01,
  /** Wheel positions in car-local space (front/back, left/right) */
  WHEELS: [
    { x: 51.25, y: 25.9, z: 0 },
    { x: 51.25, y: -25.9, z: 0 },
    { x: -33.75, y: 29.5, z: 0 },
    { x: -33.75, y: -29.5, z: 0 },
  ],
  FRONT_WHEEL_RADIUS: 12.5,
  BACK_WHEEL_RADIUS: 15,

  MAX_SPEED: 2300,
  SUPERSONIC_START: 2200,
  SUPERSONIC_MAINTAIN: 2100,
  SUPERSONIC_MAINTAIN_TIME: 1,

  BRAKE_ACCEL: 3500,
  COAST_DECEL: 525,
  /** Below this forward speed with no throttle the car fully stops */
  STOP_SPEED: 25,
  /** Throttle acceleration over forward speed */
  THROTTLE_CURVE: [
    [0, 1600],
    [1400, 160],
    [1410, 0],
  ] as readonly (readonly [number, number])[],
  AIR_THROTTLE_ACCEL: 200 / 3,

  /** Max path curvature (1/turn radius) over speed */
  STEER_CURVE: [
    [0, 0.0069],
    [500, 0.00398],
    [1000, 0.00235],
    [1500, 0.001375],
    [1750, 0.0011],
    [2500, 0.00088],
  ] as readonly (readonly [number, number])[],
  /** How fast the yaw rate reaches its target on the ground (1/s) */
  STEER_RESPONSE: 18,
  POWERSLIDE_STEER_MULT: 1.55,
  /** Lateral grip: fraction of sideways velocity removed per second */
  LATERAL_GRIP: 30,
  POWERSLIDE_GRIP: 2.2,

  BOOST_ACCEL_GROUND: 2975 / 3,
  BOOST_ACCEL_AIR: 3175 / 3,
  BOOST_USE_PER_SEC: 100 / 3,
  BOOST_MIN_TIME: 0.1,
  BOOST_START: 33,
  BOOST_MAX: 100,

  JUMP_IMPULSE: 291.667,
  JUMP_HOLD_ACCEL: 1458.333,
  JUMP_MAX_HOLD: 0.2,
  JUMP_MIN_HOLD: 0.025,
  /** Time after jumping during which the second jump / flip is available */
  DOUBLE_JUMP_WINDOW: 1.25,
  DODGE_DEADZONE: 0.5,

  FLIP_INITIAL_VEL: 500,
  FLIP_FORWARD_SPEED_SCALE: 1,
  FLIP_BACKWARD_SPEED_SCALE: 16 / 15,
  FLIP_SIDE_SPEED_SCALE: 1.9,
  FLIP_BACKWARD_X_SCALE: 16 / 15,
  FLIP_TORQUE_TIME: 0.65,
  FLIP_PITCH_RATE: 5.5,
  FLIP_ROLL_RATE: 5.5,
  FLIP_Z_DAMP_120: 0.35,
  FLIP_Z_DAMP_START: 0.15,
  FLIP_Z_DAMP_END: 0.21,

  // Air control (car-local: roll about X, pitch about Y, yaw about Z), rad/s^2
  AIR_TORQUE: { roll: 36.07956616966136, pitch: 12.1459978190807, yaw: 8.91962804287785 },
  AIR_DAMP: { roll: 4.47166302201591, pitch: 2.798194258050845, yaw: 1.886491900437232 },
  MAX_ANG_SPEED: 5.5,

  /** Extra force pulling the car onto the surface it is driving on */
  STICKY_ACCEL: 325,
  /** Grace period after leaving the ground where the car still counts as "on ground" for jumping */
  COYOTE_TIME: 0.04,

  RESTITUTION_WORLD: 0.3,
  FRICTION_WORLD: 0.3,

  DEMO_RESPAWN_TIME: 3,
  BUMP_COOLDOWN: 0.25,
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
// Boost pads
// ---------------------------------------------------------------------------
export const BOOST_PAD = {
  SMALL_AMOUNT: 12,
  BIG_AMOUNT: 100,
  SMALL_RESPAWN: 4,
  BIG_RESPAWN: 10,
  SMALL_RADIUS: 144,
  BIG_RADIUS: 208,
  SMALL_HEIGHT: 165,
  BIG_HEIGHT: 168,
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
