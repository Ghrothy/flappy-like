/**
 * Playability sweep: runs the autopilot over many deterministic seeds and
 * reports how often a randomly generated gate turns out to be unreachable.
 * Run: node tests/playability.js [runs]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const RUNS = Number(process.argv[2] || 200);

// Reuse the DOM stubs from the logic test harness.
function makeClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c),
    toggle: (c, f) => { const on = f === undefined ? !set.has(c) : !!f; if (on) set.add(c); else set.delete(c); return on; }
  };
}
const noop = () => {};
const ctxStub = () => ({
  save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, setTransform: noop,
  beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, ellipse: noop,
  fill: noop, stroke: noop, fillRect: noop, clearRect: noop,
  createLinearGradient: () => ({ addColorStop: noop })
});
const el = (id) => ({
  id, textContent: '', style: {}, classList: makeClassList(), addEventListener: noop,
  getBoundingClientRect: () => ({ width: 400, height: 700 }), width: 400, height: 700,
  closest: () => null, getContext: ctxStub
});
const ids = ['game-canvas', 'hud', 'score', 'best', 'screen-start', 'screen-over',
  'final-score', 'final-best-label', 'over-reason', 'btn-start', 'btn-restart'];
const els = {}; ids.forEach((i) => (els[i] = el(i)));

const store = new Map();
const win = {
  devicePixelRatio: 1, Math, console, setTimeout,
  localStorage: { getItem: (k) => (store.get(k) ?? null), setItem: (k, v) => store.set(k, String(v)) },
  addEventListener: noop, requestAnimationFrame: () => 0, performance: { now: () => 0 }
};
win.window = win;
const sandbox = {
  window: win, document: { getElementById: (i) => els[i] || null, addEventListener: noop, hidden: false },
  performance: win.performance, requestAnimationFrame: win.requestAnimationFrame,
  setTimeout, Math, console
};
const ctxObj = vm.createContext(sandbox);
for (const f of ['js/config.js', 'js/entities.js', 'js/game.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctxObj, { filename: f });
}

const { Game, STATE } = win;
const CONFIG = win.CONFIG;
const ui = {
  hud: els['hud'], scoreEl: els['score'], bestEl: els['best'],
  startScreen: els['screen-start'], overScreen: els['screen-over'],
  finalScoreEl: els['final-score'], finalBestEl: els['final-best-label'],
  reasonEl: els['over-reason'], startBtn: els['btn-start'], restartBtn: els['btn-restart']
};

/** Deterministic PRNG so each run is reproducible. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The game reads Math.random via Entities.rand; swap it per run. */
const realRandom = Math.random;

function fly(g, seconds) {
  const step = 1 / 60;
  const groundY = g.world.height - CONFIG.world.groundHeight;
  let cd = 0;
  for (let t = 0; t < seconds; t += step) {
    if (g.state !== STATE.PLAYING) return { alive: false, t };
    const next = g.obstacles.find((o) => o.right > g.player.x - 10);
    let target = next ? (next.gapTop + next.gapBottom) / 2 : g.world.height * 0.4;
    target = Math.max(120, Math.min(groundY - 90, target));
    cd -= step;
    if (cd <= 0 && g.player.y > target && g.player.vy > -120) { g.flap(); cd = 0.22; }
    g.update(step);
  }
  return { alive: true, t: seconds };
}

let deaths = 0;
const reasons = {};
let totalScore = 0;
const stuck = [];

for (let seed = 1; seed <= RUNS; seed++) {
  const rng = mulberry32(seed);
  // Entities.rand calls Math.random at call time, so overriding it is enough.
  Math.random = rng;
  const g = new Game(els['game-canvas'], ui);
  g.resize();
  g.start();
  const r = fly(g, 30);
  if (!r.alive) {
    deaths++;
    reasons[g.reason] = (reasons[g.reason] || 0) + 1;
    stuck.push({ seed, reason: g.reason, score: g.score, t: r.t.toFixed(2) });
  }
  totalScore += g.score;
}
Math.random = realRandom;

console.log('\nPlayability sweep — ' + RUNS + ' seeds, 30s each\n');
console.log('  died:            ' + deaths + ' / ' + RUNS);
console.log('  average score:   ' + (totalScore / RUNS).toFixed(1));
console.log('  death reasons:   ' + JSON.stringify(reasons));
if (stuck.length) {
  console.log('  first failures:  ' + JSON.stringify(stuck.slice(0, 8)));
}
console.log('');
process.exit(deaths === 0 ? 0 : 1);
