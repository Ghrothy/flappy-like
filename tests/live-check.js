/**
 * Loads the LIVE GitHub Pages URL in headless Edge and verifies the deployed
 * game boots and plays — the final end-to-end check of the real deployment.
 *
 * Run: node tests/live-check.js [url]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL = process.argv[2] || 'https://ghrothy.github.io/flappy-like/';
const DEBUG_PORT = Number(process.env.CDP_PORT || 9338);
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = BROWSERS.find((p) => fs.existsSync(p));

let passed = 0;
const failures = [];
function test(name, ok, detail) {
  if (ok) { passed++; console.log('  ok  ' + name); }
  else { failures.push(name); console.log('FAIL  ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-live-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch (e) { await sleep(250); }
  }
  if (!wsUrl) { console.error('could not start headless browser'); process.exit(1); }

  let id = 0; const pending = new Map();
  const open = async (url) => {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const h = pending.get(m.id); pending.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 25000);
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: '(function(){' + expr + '})()', returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };
    return { ws, send, evaluate };
  };

  const b = await open(wsUrl);
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const p = await open(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  await p.send('Page.enable'); await p.send('Runtime.enable'); await p.send('Log.enable');

  const errors = [];
  p.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.text + ' ' +
        (m.params.exceptionDetails.exception?.description || ''));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      errors.push(m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  });

  console.log('\nLive deployment check — ' + URL + '\n');

  await p.send('Page.navigate', { url: URL });
  await sleep(3000);

  const boot = await p.evaluate(`
    var c = document.getElementById('game-canvas');
    return {
      title: document.title, href: location.href,
      hasGame: !!window.__game,
      state: window.__game && window.__game.state,
      canvasW: c.width, canvasH: c.height,
      cssLoaded: getComputedStyle(document.querySelector('.btn')).borderRadius !== '0px',
      config: !!window.CONFIG, entities: !!window.Entities,
      startVisible: !document.getElementById('screen-start').classList.contains('hidden')
    };
  `);

  test('live page loads on the Pages URL', boot.title === "Pip's Peril" && boot.hasGame, JSON.stringify(boot));
  test('served from the ghrothy.github.io subpath', /ghrothy\.github\.io\/flappy-like/.test(boot.href || ''), boot.href);
  test('stylesheet loaded from /flappy-like/css/', boot.cssLoaded, JSON.stringify(boot));
  test('all game scripts executed (config + entities globals)', boot.config && boot.entities, JSON.stringify(boot));
  test('canvas has a backing store', boot.canvasW > 300 && boot.canvasH > 300, JSON.stringify(boot));
  test('start screen visible', boot.startVisible && boot.state === 'ready', JSON.stringify(boot));
  test('no console errors or failed requests', errors.length === 0, errors.join(' | '));

  // Space starts the game (real key event, not a JS call).
  for (const type of ['keyDown', 'keyUp']) {
    await p.send('Input.dispatchKeyEvent', { type, code: 'Space', key: ' ', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  }
  await sleep(300);
  const started = await p.evaluate(`return window.__game.state;`);
  test('Space starts the run on the live site', started === 'playing', started);

  const play = await p.evaluate(`
    var g = window.__game;
    var t = 0, cd = 0;
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
    return { score: g.score, state: g.state, hud: document.getElementById('score').textContent };
  `);
  test('gameplay and scoring work live', play.score > 0 && play.hud === String(play.score), JSON.stringify(play));

  const crash = await p.evaluate(`
    var g = window.__game;
    var t=0; while (g.state === 'playing' && t < 8) { g.update(1/60); t += 1/60; }
    return { state: g.state, panel: document.getElementById('final-score').textContent,
             score: g.score, best: g.best,
             stored: localStorage.getItem(window.CONFIG.storage.bestKey) };
  `);
  test('game-over screen works live', crash.state === 'over' && crash.panel === String(crash.score), JSON.stringify(crash));
  test('best score persists to localStorage on the live origin',
    Number(crash.stored) === crash.best, JSON.stringify(crash));

  // Mobile viewport against the live site.
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(600);
  const mobile = await p.evaluate(`
    var c = document.getElementById('game-canvas');
    var r = c.getBoundingClientRect();
    return { w: r.width, h: r.height, backing: c.width,
             overflowX: document.documentElement.scrollWidth > window.innerWidth };
  `);
  test('mobile viewport lays out live without overflow',
    mobile.w > 200 && mobile.backing > mobile.w && !mobile.overflowX, JSON.stringify(mobile));

  test('still no console errors after playing live', errors.length === 0, errors.join(' | '));

  p.ws.close(); b.ws.close();
  try { proc.kill(); } catch (e) {}
  console.log('\n' + passed + ' passed, ' + failures.length + ' failed\n');
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('crashed: ' + e.stack); process.exit(1); });
