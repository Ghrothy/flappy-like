/**
 * Bootstrap: wire the DOM to the game and drive the requestAnimationFrame loop
 * with a fixed timestep for stable physics.
 */
(function (global) {
  'use strict';

  const canvas = document.getElementById('game-canvas');
  const ui = {
    hud: document.getElementById('hud'),
    scoreEl: document.getElementById('score'),
    bestEl: document.getElementById('best'),
    startScreen: document.getElementById('screen-start'),
    overScreen: document.getElementById('screen-over'),
    finalScoreEl: document.getElementById('final-score'),
    finalBestEl: document.getElementById('final-best-label'),
    reasonEl: document.getElementById('over-reason'),
    startBtn: document.getElementById('btn-start'),
    restartBtn: document.getElementById('btn-restart')
  };

  const game = new global.Game(canvas, ui);
  global.__game = game; // handy for debugging / automated tests

  let resizeRaf = 0;
  function handleResize() {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      game.resize();
    });
  }
  global.addEventListener('resize', handleResize);
  global.addEventListener('orientationchange', handleResize);
  if (global.visualViewport) {
    global.visualViewport.addEventListener('resize', handleResize);
  }
  game.resize();

  // score pop animation
  game.onScore = function () {
    ui.scoreEl.textContent = String(game.score);
    ui.bestEl.textContent = String(game.best);
    ui.scoreEl.classList.add('pop');
    setTimeout(() => ui.scoreEl.classList.remove('pop'), 120);
  };

  const FIXED = 1 / 60;
  const MAX_STEP = 0.1;
  let last = performance.now();
  let acc = 0;

  function frame(now) {
    let delta = (now - last) / 1000;
    last = now;
    if (delta > MAX_STEP) delta = MAX_STEP;
    acc += delta;

    while (acc >= FIXED) {
      game.update(FIXED);
      acc -= FIXED;
    }
    game.render();
    requestAnimationFrame(frame);
  }

  game._syncUI();
  requestAnimationFrame(frame);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) last = performance.now();
  });
})(window);
