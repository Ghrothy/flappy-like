/**
 * Headless logic tests — no browser needed.
 *
 * Loads the game's browser scripts into a minimal fake window/document,
 * then drives Game.update() directly to assert physics, collisions, scoring
 * and the state machine.
 *
 * Run: node tests/game.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ */
/* Minimal DOM / browser stubs so the scripts can be evaluated.        */

function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    }
  };
}

function makeCtxStub() {
  const noop = () => {};
  return {
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    setTransform: noop, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop,
    fillRect: noop, clearRect: noop,
    createLinearGradient: () => ({ addColorStop: noop })
  };
}

function makeEl(id) {
  return {
    id,
    textContent: '',
    style: {},
    classList: makeClassList(),
    addEventListener() {},
    getBoundingClientRect: () => ({ width: 400, height: 700 }),
    width: 400,
    height: 700,
    closest: () => null,
    getContext: () => makeCtxStub()
  };
}

const ELEMENTS = [
  'game-canvas', 'hud', 'score', 'best', 'screen-start', 'screen-over',
  'final-score', 'final-best-label', 'over-reason', 'btn-start', 'btn-restart'
];

const els = {};
for (const id of ELEMENTS) els[id] = makeEl(id);

let rafQueue = [];
const store = new Map();

const win = {
  devicePixelRatio: 1,
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v))
  },
  addEventListener() {},
  requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
  performance: { now: () => 0 },
  setTimeout,
  Math,
  console
};
win.window = win;

const ctxObj = vm.createContext({
  window: win,
  document: {
    getElementById: (id) => els[id] || null,
    addEventListener() {},
    hidden: false
  },
  performance: win.performance,
  requestAnimationFrame: win.requestAnimationFrame,
  setTimeout,
  Math,
  console
});
ctxObj.global = ctxObj;
win.setTimeout = setTimeout;
win.console = console;

for (const file of ['js/config.js', 'js/entities.js', 'js/game.js']) {
  const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
  vm.runInContext(code, ctxObj, { filename: file });
}

// The game scripts attach everything to `window` (== the fake `win` object).
const { Game, STATE } = win;
const CONFIG = win.CONFIG;

const ui = {
  hud: els['hud'],
  scoreEl: els['score'],
  bestEl: els['best'],
  startScreen: els['screen-start'],
  overScreen: els['screen-over'],
  finalScoreEl: els['final-score'],
  finalBestEl: els['final-best-label'],
  reasonEl: els['over-reason'],
  startBtn: els['btn-start'],
  restartBtn: els['btn-restart']
};

/* ------------------------------------------------------------------ */
/* Tiny test runner                                                     */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('FAIL  ' + name + '\n      ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + a + ', want ' + b);
}

function newGame() {
  const g = new Game(els['game-canvas'], ui);
  g.resize();
  return g;
}

/** Advance the game by `seconds` at the fixed timestep. */
function advance(g, seconds) {
  const step = 1 / 60;
  for (let t = 0; t < seconds; t += step) g.update(step);
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */

console.log('\nPip\'s Peril — logic tests\n');

// --- config sanity ---
test('config has sane physics values', () => {
  assert(CONFIG.physics.gravity > 0, 'gravity must be positive');
  assert(CONFIG.physics.flapImpulse < 0, 'flap must push upward');
  assert(CONFIG.obstacles.gap > CONFIG.player.radius * 4, 'gap must be passable');
  assert(CONFIG.obstacles.marginTop + CONFIG.obstacles.gap +
    CONFIG.obstacles.marginBottom < CONFIG.world.height, 'gap must fit on screen');
});

// --- state machine ---
test('new game starts in READY state', () => {
  const g = newGame();
  assertEq(g.state, STATE.READY);
  assertEq(g.score, 0);
});

test('flap() from READY starts the run', () => {
  const g = newGame();
  g.flap();
  assertEq(g.state, STATE.PLAYING);
});

test('flap() gives upward impulse, then gravity wins', () => {
  const g = newGame();
  g.start();
  g.flap();
  const vy0 = g.player.vy;
  assert(vy0 < 0, 'vy should be negative right after flap');
  advance(g, 0.1);
  assert(g.player.vy > vy0, 'gravity should have slowed the rise');
  assert(g.player.vy < 0, 'should still be rising at 0.1s');
  advance(g, 0.6);
  assert(g.player.vy > 0, 'player should be falling after ~0.7s');
});

/**
 * Flies the player to the centre of the next gate using the same control
 * logic as the autopilot test. Returns true if the player survived `seconds`.
 */
function autopilot(g, seconds, hooks) {
  const step = 1 / 60;
  const groundY = g.world.height - CONFIG.world.groundHeight;
  let cooldown = 0;
  for (let t = 0; t < seconds; t += step) {
    if (g.state !== STATE.PLAYING) return false;
    const next = g.obstacles.find((ob) => ob.right > g.player.x - 10);
    let target = g.world.height * 0.4;
    if (next) target = (next.gapTop + next.gapBottom) / 2;
    target = Math.max(120, Math.min(groundY - 90, target));
    cooldown -= step;
    if (cooldown <= 0 && g.player.y > target && g.player.vy > -120) {
      g.flap();
      cooldown = 0.22; // flap impulse lasts ~0.3s; don't stack them
    }
    g.update(step);
    if (hooks) hooks();
  }
  return true;
}

// --- ground / ceiling collisions ---
test('falling without input hits the ground and ends the run', () => {
  const g = newGame();
  g.start();
  advance(g, 3);
  assertEq(g.state, STATE.OVER);
  assert(/ground/i.test(g.reason || ''), 'reason should mention the ground, got: ' + g.reason);
});

test('not flapping eventually hits the ceiling after a long climb', () => {
  const g = newGame();
  g.start();
  g.player.vy = -3000; // launched hard upward
  advance(g, 0.6);
  assertEq(g.state, STATE.OVER);
  assert(/ceiling/i.test(g.reason || ''), 'reason should mention the ceiling, got: ' + g.reason);
  assert(g.player.y >= 0, 'player should be clamped inside the screen');
});

// --- obstacle spawning ---
test('gates spawn over time and are passable vertically', () => {
  const g = newGame();
  g.start();
  assert(autopilot(g, 4), 'autopilot should still be alive, died: ' + g.reason);
  assert(g.obstacles.length > 0, 'expected at least one gate');
  const groundY = g.world.height - CONFIG.world.groundHeight;
  for (const ob of g.obstacles) {
    assert(ob.gapTop >= 40, 'gap too close to ceiling: ' + ob.gapTop);
    assert(ob.gapBottom <= groundY - 20, 'gap too close to ground: ' + ob.gapBottom);
    assertEq(ob.gapBottom - ob.gapTop, CONFIG.obstacles.gap);
  }
});

test('gates scroll right to left and get culled when off-screen', () => {
  const g = newGame();
  g.start();
  advance(g, 0.2);
  const first = g.obstacles[0];
  const x0 = first ? first.x : null;
  advance(g, 0.5);
  if (x0 !== null && g.obstacles.indexOf(first) !== -1) {
    assert(first.x < x0, 'gate should move left');
  }
  advance(g, 20);
  assert(g.obstacles.every((ob) => ob.right >= -8), 'off-screen gates should be culled');
});

// --- scoring ---
test('passing a gate increments the score exactly once per gate', () => {
  const g = newGame();
  g.start();
  // Place a single gate just behind the player, already scored-eligible.
  g.obstacles.length = 0;
  const Ob = win.Entities.Obstacle;
  // Gate sits fully behind the player so its right edge is past the hitbox.
  g.obstacles.push(new Ob(g.world, g.player.x - 60 - CONFIG.obstacles.width, g.player.y - 40));
  g.player.vy = 0;
  g.player.y = g.obstacles[0].gapTop + CONFIG.obstacles.gap / 2;
  g.update(1 / 60);
  assertEq(g.score, 1, 'gate should score once');
  g.update(1 / 60);
  g.update(1 / 60);
  assertEq(g.score, 1, 'same gate must not score twice');
});

let scoredAt = [];
let prevScore = 0;

test('an autopilot player survives 25s and scores repeatedly', () => {
  const g = newGame();
  g.start();
  const alive = autopilot(g, 25, () => {
    if (g.score !== prevScore) { scoredAt.push(g.score); prevScore = g.score; }
  });
  assert(alive, 'autopilot died mid-run: ' + g.reason + ' (score ' + g.score + ')');
  assert(g.score >= 3, 'autopilot should score several points, got ' + g.score);
  assert(g.score <= 25, 'one point per gate, max ~16 in 25s, got ' + g.score);
  assertEq(scoredAt.length, g.score, 'score should tick up one point at a time');
});

// --- restart / best score ---
test('restart resets score and state', () => {
  const g = newGame();
  g.start();
  g.score = 7;
  g.start();
  assertEq(g.score, 0);
  assertEq(g.state, STATE.PLAYING);
  assertEq(g.obstacles.length, 0);
});

test('best score is saved and persisted to localStorage', () => {
  const g = newGame();
  g.start();
  g.score = 12;
  g.gameOver('test');
  assertEq(g.best, 12);
  assertEq(store.get(CONFIG.storage.bestKey), '12');
  const g2 = newGame();
  assertEq(g2.best, 12, 'best should reload from storage');
  g2.isNewBest = false;
  g2._syncUI();
  assertEq(ui.finalBestEl.textContent, 'Best 12');
});

test('UI shows the final score on game over', () => {
  const g = newGame();
  g.start();
  g.score = 3;
  g.gameOver('You hit a gate.');
  assertEq(ui.finalScoreEl.textContent, '3');
  assert(!ui.overScreen.classList.contains('hidden'), 'game-over screen should be visible');
  assert(ui.startScreen.classList.contains('hidden'), 'start screen should be hidden');
  assertEq(ui.reasonEl.textContent, 'You hit a gate.');
});

test('HUD hidden on start screen, visible while playing', () => {
  const g = newGame();
  g._syncUI();
  assert(ui.hud.classList.contains('hidden'), 'HUD hidden on start screen');
  assert(!ui.startScreen.classList.contains('hidden'), 'start screen visible initially');
  g.start();
  assert(!ui.hud.classList.contains('hidden'), 'HUD visible while playing');
  assert(ui.startScreen.classList.contains('hidden'), 'start screen hidden while playing');
});

// --- resize / responsive ---
test('resize fits world between min and max width', () => {
  const g = newGame();
  for (const [w, h] of [[320, 480], [480, 700], [900, 500]]) {
    els['game-canvas'].getBoundingClientRect = () => ({ width: w, height: h });
    g.resize();
    assert(g.world.width >= 300 && g.world.width <= 620,
      'world width ' + g.world.width + ' out of range for ' + w + 'x' + h);
    assertEq(g.world.height, CONFIG.world.height, 'world height should stay fixed');
  }
});

// --- rendering smoke test ---
test('render runs without throwing and draws content', () => {
  const g = newGame();
  g.start();
  advance(g, 2);
  g.render();
  g.gameOver('render smoke');
  g.render();
  g.render();
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
process.exit(failures.length ? 1 : 0);
