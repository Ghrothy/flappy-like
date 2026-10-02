/**
 * Captures PNG screenshots of the game at key moments.
 * Run: node tests/screenshot.js [outDir]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8123;
const URL = `http://127.0.0.1:${PORT}/`;
const DEBUG_PORT = Number(process.env.CDP_PORT || 9334);
const OUT = process.argv[2] || path.join(__dirname, '..', 'screenshots');
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = BROWSERS.find((p) => fs.existsSync(p));
if (!exe) { console.error('no browser found'); process.exit(1); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-shot-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch (e) { await sleep(250); }
  }
  if (!wsUrl) { console.error('no CDP'); process.exit(1); }

  let id = 0;
  const pending = new Map();
  const open = async (url) => {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { const h = pending.get(m.id); pending.delete(m.id); m.error ? h.rej(new Error(m.error.message)) : h.res(m.result); }
    });
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id; pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
    });
    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: '(function(){' + expr + '})()', returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    return { ws, send, evaluate };
  };

  const b = await open(wsUrl);
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const p = await open(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
  await p.send('Page.enable');
  await p.send('Runtime.enable');

  const shoot = async (name) => {
    // Record what the DOM says at the exact moment of capture.
    const dom = await p.evaluate(`
      return {
        state: window.__game.state,
        score: window.__game.score,
        hud: document.getElementById('score').textContent,
        panel: document.getElementById('final-score').textContent,
        startVisible: !document.getElementById('screen-start').classList.contains('hidden'),
        overVisible: !document.getElementById('screen-over').classList.contains('hidden')
      };
    `);
    const { data } = await p.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('wrote ' + file + '  ' + JSON.stringify(dom));
  };

  // Freeze the game loop so the capture matches the state we just set up,
  // and let CSS overlay transitions settle before shooting.
  const freeze = async () => {
    await p.evaluate(`
      var g = window.__game;
      if (!g.__realUpdate) { g.__realUpdate = g.update; }
      g.update = function(){};
      g.render();
      return true;
    `);
    await sleep(450); // overlay fade (0.25s) + score pop (0.12s)
  };
  const unfreeze = async () => {
    await p.evaluate(`
      var g = window.__game;
      if (g.__realUpdate) { g.update = g.__realUpdate; }
      return true;
    `);
  };

  // Desktop
  await p.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 2, mobile: false });
  await p.send('Page.navigate', { url: URL });
  await sleep(1500);
  await shoot('01-start-screen');

  // Mid-run with gates and score
  await p.evaluate(`
    var g = window.__game;
    g.start();
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
    g.render();
    return g.score;
  `);
  await freeze();
  await shoot('02-playing');
  await unfreeze();

  // Flap particles
  await p.evaluate(`window.__game.flap(); window.__game.render(); return 1;`);
  await freeze();
  await shoot('03-flap-effect');
  await unfreeze();

  // Game over
  await p.evaluate(`
    var g = window.__game;
    var t = 0; while (g.state === 'playing' && t < 6) { g.update(1/60); t += 1/60; }
    g.render();
    return g.state;
  `);
  await freeze();
  await shoot('04-game-over');
  await unfreeze();

  // Mobile
  await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(500);
  await p.evaluate(`
    var g = window.__game;
    g.start();
    var t = 0, cd = 0;
    var groundY = g.world.height - window.CONFIG.world.groundHeight;
    while (g.score < 2 && t < 20 && g.state === 'playing') {
      var next = g.obstacles.filter(function(o){return o.right > g.player.x - 10;})[0];
      var target = next ? (next.gapTop + next.gapBottom)/2 : g.world.height*0.4;
      target = Math.max(120, Math.min(groundY - 90, target));
      cd -= 1/60;
      if (cd <= 0 && g.player.y > target && g.player.vy > -120) { g.flap(); cd = 0.22; }
      g.update(1/60);
      t += 1/60;
    }
    g.render();
    return 1;
  `);
  await freeze();
  await shoot('05-mobile-playing');
  await unfreeze();

  p.ws.close(); b.ws.close();
  try { proc.kill(); } catch (e) {}
  console.log('done');
  process.exit(0);
})();
