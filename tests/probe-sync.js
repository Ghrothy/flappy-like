/**
 * Ad-hoc probe: start a run, autopilot to some points, crash, and report
 * every score display so the HUD and the game-over panel can be compared.
 * Run: node tests/probe-sync.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8123;
const DEBUG_PORT = Number(process.env.CDP_PORT || 9335);
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = BROWSERS.find((p) => fs.existsSync(p));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-probe-'));
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio',
    '--remote-debugging-port=' + DEBUG_PORT, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => { try { proc.kill(); fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl; }
    catch (e) { await sleep(250); }
  }
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
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout')); } }, 20000);
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
  await p.send('Page.enable'); await p.send('Runtime.enable');
  await p.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);

  const r = await p.evaluate(`
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
    var midScore = g.score;
    var t2 = 0; while (g.state === 'playing' && t2 < 8) { g.update(1/60); t2 += 1/60; }
    return {
      midScore: midScore,
      finalGameScore: g.score,
      state: g.state,
      hudScore: document.getElementById('score').textContent,
      panelScore: document.getElementById('final-score').textContent,
      panelBest: document.getElementById('final-best-label').textContent,
      best: g.best
    };
  `);
  console.log(JSON.stringify(r, null, 2));
  p.ws.close(); b.ws.close();
  try { proc.kill(); } catch (e) {}
  process.exit(0);
})();
