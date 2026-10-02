/**
 * Headless-browser smoke test.
 *
 * Launches Edge/Chrome with --headless --remote-debugging-port, loads the game
 * over a local HTTP server, then drives it through the Chrome DevTools
 * Protocol: start screen, flap input, scoring, collision, restart, and a
 * mobile-sized viewport pass. Uses only Node built-ins (global WebSocket).
 *
 * Run: node tests/browser.test.js
 * (assumes `node tests/server.js` is already serving on PORT, default 8123)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8123;
const URL = `http://127.0.0.1:${PORT}/`;
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333);
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('no Chrome/Edge executable found');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- tiny CDP client ------------------------- */

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 20000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: '(function(){' + expression + '})()',
      returnByValue: true,
      awaitPromise: true
    });
    if (res.exceptionDetails) {
      throw new Error('page error: ' + JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails));
    }
    return res.result.value;
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

/* ------------------------- test runner ------------------------- */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    failures.push(name);
    console.log('FAIL  ' + name + '\n      ' + err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function assertEq(a, b, msg) {
  if (a !== b) throw new Error((msg || 'not equal') + ': got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}

/* ------------------------- runner ------------------------- */

(async () => {
  console.log('\nPip\'s Peril — browser tests\n');
  const exe = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-profile-'));
  const browser = spawn(exe, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--mute-audio',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + profile,
    'about:blank'
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { browser.kill(); } catch (e) { /* ignore */ }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  };
  process.on('exit', cleanup);

  // wait for the debugging endpoint
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
      break;
    } catch (e) {
      await sleep(250);
    }
  }
  if (!wsUrl) {
    console.log('FAIL  could not start headless browser (no CDP endpoint)');
    cleanup();
    process.exit(1);
  }

  const browserCdp = new CDP(wsUrl);
  await browserCdp.connect();
  const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const target = targets.find((t) => t.id === targetId);
  const page = new CDP(target.webSocketDebuggerUrl);
  await page.close; // no-op
  await (async () => {
    page.ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      page.ws.addEventListener('open', res, { once: true });
      page.ws.addEventListener('error', rej, { once: true });
    });
    page.id = 0;
    page.pending = new Map();
    page.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && page.pending.has(msg.id)) {
        const { resolve, reject } = page.pending.get(msg.id);
        page.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  })();

  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');

  const consoleErrors = [];
  page.ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.text + ' ' +
        (msg.params.exceptionDetails.exception?.description || ''));
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    }
  });

  const key = async (code, keyName, keyCode) => {
    for (const type of ['keyDown', 'keyUp']) {
      await page.send('Input.dispatchKeyEvent', {
        type, code, key: keyName, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
      });
    }
  };
  const space = () => key('Space', ' ', 32);

  // ---- load ----
  await page.send('Page.navigate', { url: URL });
  await sleep(1200);

  await test('page loads with no console errors', async () => {
    assertEq(consoleErrors.length, 0, 'console errors: ' + consoleErrors.join(' | '));
    assertEq(await page.eval('return document.title'), "Pip's Peril");
  });

  await test('game object boots and start screen is visible', async () => {
    const s = await page.eval(`
      var c = document.getElementById('game-canvas');
      return {
        hasGame: !!window.__game,
        state: window.__game && window.__game.state,
        canvasW: c.width, canvasH: c.height,
        startVisible: !document.getElementById('screen-start').classList.contains('hidden'),
        overHidden: document.getElementById('screen-over').classList.contains('hidden'),
        hudHidden: document.getElementById('hud').classList.contains('hidden'),
        worldW: window.__game && window.__game.world.width,
        worldH: window.__game && window.__game.world.height,
        cssLoaded: getComputedStyle(document.querySelector('.btn')).borderRadius !== '0px'
      };
    `);
    assert(s.hasGame, 'window.__game missing');
    assertEq(s.state, 'ready', 'initial state');
    assert(s.canvasW > 300 && s.canvasH > 300, 'canvas has no backing size: ' + s.canvasW + 'x' + s.canvasH);
    assert(s.startVisible, 'start screen should be visible');
    assert(s.overHidden, 'game-over screen should be hidden');
    assert(s.hudHidden, 'HUD should be hidden before the run starts');
    assertEq(s.worldH, 640, 'world height');
    assert(s.worldW >= 300 && s.worldW <= 620, 'world width out of range: ' + s.worldW);
    assert(s.cssLoaded, 'stylesheet did not load (button not styled)');
  });

  await test('canvas actually has non-trivial pixels drawn', async () => {
    const info = await page.eval(`
      var c = document.getElementById('game-canvas');
      var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      var seen = {};
      var n = 0;
      for (var i = 0; i < d.length; i += 4 * 97) {
        var k = d[i] + ',' + d[i+1] + ',' + d[i+2];
        if (!seen[k]) { seen[k] = 1; n++; }
      }
      return n;
    `);
    assert(info > 5, 'canvas looks blank, only ' + info + ' distinct sampled colors');
  });

  await test('Space starts the run and the player moves', async () => {
    await space();
    await sleep(150);
    const a = await page.eval(`
      var g = window.__game;
      return { state: g.state, x: g.player.x, y: g.player.y, vy: g.player.vy,
               startHidden: document.getElementById('screen-start').classList.contains('hidden'),
               hudVisible: !document.getElementById('hud').classList.contains('hidden') };
    `);
    assertEq(a.state, 'playing', 'state after Space');
    assert(a.startHidden, 'start screen should hide when playing');
    assert(a.hudVisible, 'HUD should be visible while playing');
    await sleep(250);
    const b = await page.eval('return {x: window.__game.player.x, y: window.__game.player.y};');
    assert(a.y !== b.y, 'player should be falling after a flap');
  });

  await test('gravity pulls the player down when not flapping', async () => {
    const y0 = await page.eval('return window.__game.player.y;');
    await sleep(400);
    const r = await page.eval('return {y: window.__game.player.y, vy: window.__game.player.vy};');
    assert(r.y > y0, 'player should descend, went from ' + y0 + ' to ' + r.y);
    assert(r.vy > 0, 'player should have downward velocity');
  });

  await test('click on the canvas flaps the player', async () => {
    // Make sure a run is in progress (the previous test may have ended in a crash).
    await page.eval(`
      var g = window.__game;
      if (g.state !== 'playing') g.start();
      g.player.vy = 120;
      return g.state;
    `);
    const vy0 = await page.eval('return window.__game.player.vy;');
    await page.eval(`
      var c = document.getElementById('game-canvas');
      var r = c.getBoundingClientRect();
      var ev = new PointerEvent('pointerdown', {bubbles:true, cancelable:true, clientX:r.left+50, clientY:r.top+50});
      c.dispatchEvent(ev);
      return true;
    `);
    const vy1 = await page.eval('return window.__game.player.vy;');
    assert(vy1 < vy0, 'flap should reduce vy, ' + vy0 + ' -> ' + vy1);
    assert(vy1 < 0, 'flap should give upward velocity, got ' + vy1);
  });

  await test('gates spawn and the player can score through one', async () => {
    // Drive the game with the in-page autopilot until it scores.
    const res = await page.eval(`
      var g = window.__game;
      var start = g.score;
      var t = 0;
      var cooldown = 0;
      var groundY = g.world.height - window.CONFIG.world.groundHeight;
      while (g.score === start && t < 15 && g.state === 'playing') {
        var next = g.obstacles.filter(function(o){return o.right > g.player.x - 10;})[0];
        var target = next ? (next.gapTop + next.gapBottom) / 2 : g.world.height * 0.4;
        target = Math.max(120, Math.min(groundY - 90, target));
        cooldown -= 1/60;
        if (cooldown <= 0 && g.player.y > target && g.player.vy > -120) { g.flap(); cooldown = 0.22; }
        g.update(1/60);
        t += 1/60;
      }
      return { score: g.score, state: g.state, t: t,
               hudScore: document.getElementById('score').textContent,
               obstaclesSeen: g.obstacles.length };
    `);
    assert(res.score > 0, 'autopilot never scored in 15s');
    assertEq(String(res.score), res.hudScore, 'HUD should mirror the score');
  });

  await test('game over: dropping into the ground shows the final score', async () => {
    const res = await page.eval(`
      var g = window.__game;
      // stop flapping and let gravity win
      var t = 0;
      while (g.state === 'playing' && t < 5) { g.update(1/60); t += 1/60; }
      return { state: g.state, reason: g.reason, score: g.score,
               finalScore: document.getElementById('final-score').textContent,
               overVisible: !document.getElementById('screen-over').classList.contains('hidden'),
               restartBtn: !!document.getElementById('btn-restart') };
    `);
    assertEq(res.state, 'over', 'state after crashing');
    assert(/ground|gate|ceiling/i.test(res.reason), 'unexpected reason: ' + res.reason);
    assertEq(res.finalScore, String(res.score), 'final score display');
    assert(res.overVisible, 'game-over screen should be visible');
    assert(res.restartBtn, 'restart button missing');
  });

  await test('best score persisted to localStorage', async () => {
    const r = await page.eval(`
      return { best: window.__game.best, stored: localStorage.getItem(window.CONFIG.storage.bestKey) };
    `);
    assert(Number(r.stored) > 0, 'best not stored: ' + JSON.stringify(r));
    assertEq(Number(r.stored), r.best, 'stored best should match game.best');
  });

  await test('Restart button starts a fresh run', async () => {
    // The game-over screen must be up for the button to be laid out.
    await page.eval(`
      var g = window.__game;
      if (g.state === 'playing') { var t=0; while (g.state === 'playing' && t < 5) { g.update(1/60); t+=1/60; } }
      return g.state;
    `);
    await sleep(100);
    const before = await page.eval(`
      var b = document.getElementById('btn-restart');
      var r = b.getBoundingClientRect();
      var ov = document.getElementById('screen-over');
      return { w: r.width, h: r.height, vis: getComputedStyle(ov).opacity,
               hidden: ov.classList.contains('hidden'), state: window.__game.state };
    `);
    assert(before.state === 'over', 'expected game-over screen, state=' + before.state);
    assert(!before.hidden, 'game-over overlay should be visible for the restart button');
    assert(before.w > 20 && before.h > 20,
      'restart button not laid out: ' + JSON.stringify(before));
    await page.eval(`
      document.getElementById('btn-restart').dispatchEvent(
        new MouseEvent('click', {bubbles:true, cancelable:true}));
      return true;
    `);
    await sleep(150);
    const r = await page.eval(`
      var g = window.__game;
      return { state: g.state, score: g.score, obstacles: g.obstacles.length,
               overHidden: document.getElementById('screen-over').classList.contains('hidden') };
    `);
    assertEq(r.state, 'playing', 'state after clicking Restart');
    assertEq(r.score, 0, 'score should reset');
    assert(r.overHidden, 'game-over screen should hide again');
  });

  await test('Space restarts from the game-over screen', async () => {
    await page.eval(`
      var g = window.__game;
      var t=0; while (g.state === 'playing' && t < 5) { g.update(1/60); t+=1/60; }
      return g.state;
    `);
    assertEq(await page.eval('return window.__game.state;'), 'over');
    await space();
    await sleep(120);
    assertEq(await page.eval('return window.__game.state;'), 'playing', 'Space should restart');
  });

  await test('mobile viewport (390x844) lays out and plays', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true
    });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await sleep(400);
    const r = await page.eval(`
      var c = document.getElementById('game-canvas');
      var rect = c.getBoundingClientRect();
      var stage = document.getElementById('stage').getBoundingClientRect();
      return { cssW: rect.width, cssH: rect.height, backingW: c.width, backingH: c.height,
               stageW: stage.width, worldW: window.__game.world.width,
               overflowX: document.documentElement.scrollWidth > window.innerWidth,
               overflowY: document.documentElement.scrollHeight > window.innerHeight };
    `);
    assert(r.cssW > 200 && r.cssH > 400, 'canvas not sized on mobile: ' + JSON.stringify(r));
    assert(r.backingW > r.cssW, 'backing store should be DPR-scaled, ' + r.backingW + ' vs ' + r.cssW);
    assert(!r.overflowX, 'page scrolls horizontally on mobile');
    assert(!r.overflowY, 'page scrolls vertically on mobile');

    // tap to flap
    await page.eval(`
      var c = document.getElementById('game-canvas');
      var r0 = c.getBoundingClientRect();
      c.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, cancelable:true,
        clientX: r0.left + r0.width/2, clientY: r0.top + r0.height/2, pointerType:'touch'}));
      return true;
    `);
    await sleep(120);
    const st = await page.eval('return window.__game.state;');
    assert(st === 'playing' || st === 'over', 'touch input did not register, state=' + st);
  });

  await test('overlays fade out / in correctly (computed opacity, not just classes)', async () => {
    // Reload so the run really starts from the start screen (earlier tests
    // leave the game in an 'over' state).
    consoleErrors.length = 0;
    await page.send('Page.navigate', { url: URL });
    await sleep(1200);
    let r = await page.eval(`
      var ov = document.getElementById('screen-start');
      return { op: parseFloat(getComputedStyle(ov).opacity), pe: getComputedStyle(ov).pointerEvents };
    `);
    assert(r.op > 0.9, 'start overlay should be opaque on load, got ' + r.op);

    // Hidden while playing: the fade must complete and clicks must pass through.
    await page.eval(`
      var g = window.__game;
      if (g.state !== 'playing') g.start();
      return g.state;
    `);
    await sleep(400);
    r = await page.eval(`
      var ov = document.getElementById('screen-start');
      return { op: parseFloat(getComputedStyle(ov).opacity), pe: getComputedStyle(ov).pointerEvents };
    `);
    assertEq(r.op, 0, 'start overlay opacity should reach 0 while playing');
    assertEq(r.pe, 'none', 'hidden start overlay must not swallow clicks');

    // Game-over overlay fully visible, start overlay fully hidden.
    await page.eval(`
      var g = window.__game;
      var t=0; while (g.state === 'playing' && t < 6) { g.update(1/60); t+=1/60; }
      return g.state;
    `);
    await sleep(400);
    r = await page.eval(`
      function op(id){ return parseFloat(getComputedStyle(document.getElementById(id)).opacity); }
      return { start: op('screen-start'), over: op('screen-over') };
    `);
    assertEq(r.start, 0, 'start overlay must stay hidden');
    assert(r.over > 0.9, 'game-over overlay should be opaque, got ' + r.over);
  });

  await test('HUD score and game-over panel never disagree', async () => {
    const r = await page.eval(`
      var g = window.__game;
      if (g.state === 'over') g.start();
      var t=0, cd=0;
      var groundY = g.world.height - window.CONFIG.world.groundHeight;
      while (g.score < 3 && t < 20 && g.state === 'playing') {
        var next = g.obstacles.filter(function(o){return o.right > g.player.x - 10;})[0];
        var target = next ? (next.gapTop + next.gapBottom)/2 : g.world.height*0.4;
        target = Math.max(120, Math.min(groundY - 90, target));
        cd -= 1/60;
        if (cd <= 0 && g.player.y > target && g.player.vy > -120) { g.flap(); cd = 0.22; }
        g.update(1/60);
        t += 1/60;
      }
      var t2=0; while (g.state === 'playing' && t2 < 8) { g.update(1/60); t2 += 1/60; }
      return {
        state: g.state, score: g.score,
        hud: document.getElementById('score').textContent,
        panel: document.getElementById('final-score').textContent
      };
    `);
    assertEq(r.state, 'over', 'should have crashed by now');
    assertEq(r.hud, String(r.score), 'HUD score should match the game score');
    assertEq(r.panel, String(r.score), 'game-over panel score should match the game score');
  });

  await test('restart clears the game-over panel for the next run', async () => {
    await page.eval(`
      document.getElementById('btn-restart').dispatchEvent(
        new MouseEvent('click', {bubbles:true, cancelable:true}));
      return true;
    `);
    await sleep(400); // the overlay fade transition is 0.25s
    const r = await page.eval(`
      var g = window.__game;
      return { state: g.state, score: g.score,
               panel: document.getElementById('final-score').textContent,
               overOp: parseFloat(getComputedStyle(document.getElementById('screen-over')).opacity) };
    `);
    assertEq(r.state, 'playing');
    assertEq(r.panel, '0', 'stale final score should be reset on restart');
    assertEq(r.overOp, 0, 'game-over overlay should be transparent while playing');
  });

  await test('no console errors accumulated during the whole run', async () => {
    assertEq(consoleErrors.length, 0, 'console errors: ' + consoleErrors.join(' | '));
  });

  page.close();
  browserCdp.close();
  cleanup();

  console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
  process.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('browser test runner crashed: ' + err.stack);
  process.exit(1);
});
