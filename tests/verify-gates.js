/**
 * Visual verification of the gate rendering: reads real canvas pixels through a
 * headless browser and proves, for every spawned gate, that
 *   - the top gate's pixels reach the top edge of the play area, and
 *   - the bottom gate's pixels reach the ground line with no gap,
 *   - no gate pixels bleed into the playable gap.
 *
 * Run: node tests/verify-gates.js
 * (requires `node tests/server.js` running)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = process.env.PORT || 8123;
const URL = `http://127.0.0.1:${PORT}/`;
const DEBUG_PORT = Number(process.env.CDP_PORT || 9336);
const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exe = BROWSERS.find((p) => fs.existsSync(p));

// Colours used by CONFIG.colors.pipe family (green channel clearly dominant).
function isPipePixel(r, g, b) {
  return g > 90 && g > r + 25 && g > b + 25;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pip-gates-'));
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
      setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 20000);
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
  await p.send('Page.enable'); await p.send('Runtime.enable');
  await p.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
  await p.send('Page.navigate', { url: URL });
  await sleep(1500);

  // Place several gates at known positions and sample a column through each.
  const report = await p.evaluate(`
    var g = window.__game;
    var C = window.CONFIG;
    var canvas = document.getElementById('game-canvas');
    var ctx = canvas.getContext('2d');

    g.start();
    var scale = g.cssScale;               // logical units -> css px
    var groundY = g.world.height - C.world.groundHeight;

    // Build gates spanning the full legal spawn range.
    var tops = [C.obstacles.marginTop, 140, 230, 320, groundY - C.obstacles.gap - C.obstacles.marginBottom];
    g.obstacles.length = 0;
    var Ob = window.Entities.Obstacle;
    for (var i = 0; i < tops.length; i++) {
      g.obstacles.push(new Ob(g.world, 20 + i * ((g.world.width - 90) / tops.length), tops[i]));
    }

    // Hide the player and ground is fine to keep; we only look for pipe green.
    g.render();

    // The world is centred horizontally in the canvas; map logical x -> device px.
    function devX(lx) {
      var cssW = canvas.getBoundingClientRect().width;
      return (cssW - g.world.width * scale) / 2 + lx * scale;
    }
    function devY(ly) { return ly * scale; }
    function pipeAt(ly, devx) {
      var d = ctx.getImageData(Math.round(devx), Math.round(devY(ly)), 1, 1).data;
      return d[1] > 90 && d[1] > d[0] + 25 && d[1] > d[2] + 25;
    }

    var out = [];
    for (var k = 0; k < g.obstacles.length; k++) {
      var ob = g.obstacles[k];
      var lx = ob.x + ob.w / 2;
      var dx = devX(lx);

      // Walk the top pipe from y=0 down; is there any non-pipe row before the gap?
      var topHoleAt = -1;
      for (var y = 0; y < ob.gapTop; y++) {
        if (!pipeAt(y, dx)) { topHoleAt = y; break; }
      }
      // Walk the bottom pipe from the ground up; is there any non-pipe row?
      var botHoleAt = -1;
      for (var y2 = groundY - 1; y2 > ob.gapBottom; y2--) {
        if (!pipeAt(y2, dx)) { botHoleAt = y2; break; }
      }
      // Does any pipe colour bleed into the gap?
      var gapLeak = -1;
      for (var y3 = Math.ceil(ob.gapTop); y3 < ob.gapBottom; y3++) {
        if (pipeAt(y3, dx)) { gapLeak = y3; break; }
      }
      out.push({
        gapTop: ob.gapTop, gapBottom: ob.gapBottom, groundY: groundY,
        topReachesEdge: topHoleAt === -1,
        topHoleAt: topHoleAt,
        bottomReachesGround: botHoleAt === -1,
        bottomHoleAt: botHoleAt,
        gapLeak: gapLeak
      });
    }
    return out;
  `);

  let failed = 0;
  console.log('\nGate rendering — real pixel verification\n');
  console.log('  ' + 'gapTop'.padEnd(7) + 'gapBot'.padEnd(7) + 'ground'.padEnd(7) +
    'top->edge'.padEnd(11) + 'bot->ground'.padEnd(12) + 'gap clear');
  for (const r of report) {
    const top = r.topReachesEdge ? 'PASS' : 'FAIL@' + r.topHoleAt;
    const bot = r.bottomReachesGround ? 'PASS' : 'FAIL@' + r.bottomHoleAt;
    const gap = r.gapLeak === -1 ? 'PASS' : 'LEAK@' + r.gapLeak;
    if (!r.topReachesEdge || !r.bottomReachesGround || r.gapLeak !== -1) failed++;
    console.log('  ' + String(Math.round(r.gapTop)).padEnd(7) +
      String(Math.round(r.gapBottom)).padEnd(7) +
      String(Math.round(r.groundY)).padEnd(7) +
      top.padEnd(11) + bot.padEnd(12) + gap);
  }

  p.ws.close(); b.ws.close();
  try { proc.kill(); } catch (e) {}
  console.log('\n  ' + (report.length - failed) + '/' + report.length + ' gates render correctly\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crashed: ' + e.stack); process.exit(1); });
