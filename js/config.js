/**
 * Central tuning values. Distances are in logical pixels at 60 FPS reference.
 */
window.CONFIG = {
  world: {
    width: 360,          // logical world width used for gameplay math
    height: 640,         // logical world height
    groundHeight: 88
  },

  physics: {
    gravity: 1500,       // px / s^2
    flapImpulse: -470,   // px / s applied on flap
    maxFallSpeed: 900,
    tiltUp: -0.45,       // radians, nose-up when flapping
    tiltDown: 1.35,      // radians, nose-down when falling
    tiltLerp: 9
  },

  player: {
    x: 110,
    radius: 15,
    hitRadius: 12        // slightly forgiving collision radius
  },

  obstacles: {
    gap: 175,            // vertical opening
    width: 62,
    speed: 165,          // px / s, increases over time
    speedMax: 300,
    speedRamp: 3.2,      // px/s added per point scored
    spawnInterval: 1.45, // seconds between gates
    minGapTop: 60,       // keep gap away from the very top
    marginTop: 56,
    marginBottom: 56
  },

  colors: {
    skyTop: '#1b2a4a',
    skyBottom: '#4a7fb5',
    hillFar: '#2c4a6b',
    hillNear: '#22385a',
    cloud: 'rgba(255,255,255,0.22)',
    pipe: '#5fbf7d',
    pipeDark: '#3d8f5a',
    pipeLight: '#8fe0a5',
    pipeCap: '#57ac74',
    ground: '#c8a06a',
    groundDark: '#a37b4c',
    groundGrass: '#6fbf5f',
    body: '#ffd166',
    bodyDark: '#e0a12f',
    wing: '#fff3d0',
    eye: '#22293b',
    feather: '#fff3d0',
    sparkle: '#ffffff'
  },

  effects: {
    flapParticles: 6,
    scoreParticles: 12,
    shakePixels: 9,
    shakeDuration: 0.35
  },

  storage: {
    bestKey: 'pipsPeril.best'
  }
};
