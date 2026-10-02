/**
 * Game state machine, update/render loop, input handling and effects.
 */
(function (global) {
  'use strict';

  const CONFIG = global.CONFIG;
  const { Player, Obstacle, Ground, Particles, rand } = global.Entities;

  const STATE = { READY: 'ready', PLAYING: 'playing', OVER: 'over' };

  class Game {
    constructor(canvas, ui) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.ui = ui;

      this.world = { width: 360, height: 640 };
      this.ground = new Ground(this.world);
      this.player = new Player(this.world);
      this.particles = new Particles();
      this.obstacles = [];

      this.state = STATE.READY;
      this.score = 0;
      this.best = this._loadBest();
      this.spawnTimer = 0;
      this.time = 0;
      this.shake = 0;
      this.clouds = [];
      this.flash = 0;

      this._initBackdrop();
      this._bindInput();
    }

    /* -------------------- lifecycle -------------------- */

    start() {
      this.obstacles.length = 0;
      this.particles.clear();
      this.player.reset();
      this.player.x = this.world.width * 0.32;
      this.score = 0;
      this.spawnTimer = CONFIG.obstacles.spawnInterval * 0.6;
      this.shake = 0;
      this.flash = 0;
      this.state = STATE.PLAYING;
      this._syncUI();
    }

    gameOver(reason) {
      if (this.state !== STATE.PLAYING) return;
      this.state = STATE.OVER;
      this.reason = reason;
      this.shake = CONFIG.effects.shakeDuration;
      this.flash = 0.3;
      this.particles.spawn(this.player.x, this.player.y, 18, {
        color: CONFIG.colors.body,
        speedMin: 90,
        speedMax: 300,
        lifeMin: 0.5,
        lifeMax: 1.0,
        sizeMin: 3,
        sizeMax: 6
      });
      if (this.score > this.best) {
        this.best = this.score;
        this._saveBest();
        this.isNewBest = true;
      } else {
        this.isNewBest = false;
      }
      this._syncUI();
    }

    flap() {
      if (this.state === STATE.READY) {
        this.start();
      }
      if (this.state !== STATE.PLAYING) return;
      this.player.flap();
      this.particles.spawn(
        this.player.x - CONFIG.player.radius * 0.6,
        this.player.y + CONFIG.player.radius * 0.4,
        CONFIG.effects.flapParticles,
        {
          angle: Math.PI / 2,
          speedMin: 30,
          speedMax: 110,
          lifeMin: 0.25,
          lifeMax: 0.5,
          sizeMin: 1.5,
          sizeMax: 3
        }
      );
    }

    /* -------------------- loop -------------------- */

    update(dt) {
      this.time += dt;
      this._updateClouds(dt);

      if (this.state === STATE.PLAYING) {
        this._updatePlay(dt);
      } else {
        // idle bob on the start / game-over screen
        this.player.wingPhase += dt * 6;
        this.particles.update(dt);
      }

      this.shake = Math.max(0, this.shake - dt);
      this.flash = Math.max(0, this.flash - dt);
    }

    _updatePlay(dt) {
      const o = CONFIG.obstacles;
      const speed = Math.min(o.speedMax, o.speed + this.score * o.speedRamp);

      this.player.update(dt);
      this.ground.update(dt, speed);
      this.particles.update(dt);

      for (const ob of this.obstacles) {
        ob.update(dt, speed);
        if (!ob.scored && ob.right < this.player.x - this.player.hitRadius) {
          ob.scored = true;
          this.score++;
          this.onScore && this.onScore();
          this.particles.spawn(this.player.x + 14, this.player.y, CONFIG.effects.scoreParticles, {
            color: CONFIG.colors.sparkle,
            speedMin: 60,
            speedMax: 190,
            lifeMin: 0.3,
            lifeMax: 0.6,
            gravity: 40,
            sizeMin: 1.5,
            sizeMax: 3.5
          });
        }
      }
      this.obstacles = this.obstacles.filter((ob) => !ob.offscreen());

      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer += o.spawnInterval;
        this._spawnGap();
      }

      this._checkCollisions();
    }

    _spawnGap() {
      const o = CONFIG.obstacles;
      const groundY = this.world.height - CONFIG.world.groundHeight;
      const minTop = o.marginTop;
      const maxTop = groundY - o.gap - o.marginBottom;
      const gapTop = rand(Math.max(minTop, o.minGapTop), Math.max(minTop + 10, maxTop));
      this.obstacles.push(new Obstacle(this.world, this.world.width + 30, gapTop));
    }

    _checkCollisions() {
      const b = this.player.bounds();
      const groundY = this.world.height - CONFIG.world.groundHeight;

      if (b.y - b.r <= 0) {
        this.player.y = b.r;
        return this.gameOver('You hit the ceiling.');
      }
      if (b.y + b.r >= groundY) {
        this.player.y = groundY - b.r;
        return this.gameOver('You clipped the ground.');
      }
      for (const ob of this.obstacles) {
        if (ob.right < b.x - 40 || ob.left > b.x + 40) continue;
        for (const r of ob.rects()) {
          if (this.player.hitsRect(r)) {
            return this.gameOver('You hit a gate.');
          }
        }
      }
    }

    /* -------------------- rendering -------------------- */

    render() {
      const ctx = this.ctx;
      const w = this.world.width;
      const h = this.world.height;

      ctx.save();
      if (this.shake > 0) {
        const k = this.shake / CONFIG.effects.shakeDuration;
        const amp = CONFIG.effects.shakePixels * k;
        ctx.translate(rand(-amp, amp), rand(-amp, amp));
      }

      this._drawSky();
      this._drawClouds();
      for (const ob of this.obstacles) ob.draw(ctx);
      this.ground.draw(ctx);
      this.player.draw(ctx);
      this.particles.draw(ctx);
      ctx.restore();

      if (this.flash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.9})`;
        ctx.fillRect(0, 0, w, h);
      }
    }

    _drawSky() {
      const ctx = this.ctx;
      const c = CONFIG.colors;
      const w = this.world.width;
      const h = this.world.height;
      const groundY = h - CONFIG.world.groundHeight;

      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, c.skyTop);
      g.addColorStop(1, c.skyBottom);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // far hills
      ctx.fillStyle = c.hillFar;
      this._hills(0.62, 60, 90, 0.9);
      ctx.fillStyle = c.hillNear;
      this._hills(0.72, 90, 70, 1.5);

      void groundY;
    }

    _hills(baseRatio, amplitude, wavelength, phase) {
      const ctx = this.ctx;
      const w = this.world.width;
      const base = this.world.height * baseRatio;
      ctx.beginPath();
      ctx.moveTo(0, this.world.height);
      for (let x = 0; x <= w; x += 6) {
        const y = base
          + Math.sin((x / wavelength) * Math.PI * 2 + this.time * 0.25 * phase + phase) * amplitude * 0.5
          - amplitude * 0.5;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, this.world.height);
      ctx.closePath();
      ctx.fill();
    }

    _initBackdrop() {
      this.clouds = [];
      for (let i = 0; i < 6; i++) {
        this.clouds.push({
          x: rand(0, this.world.width),
          y: rand(40, this.world.height * 0.45),
          s: rand(0.6, 1.5),
          v: rand(6, 16)
        });
      }
    }

    _updateClouds(dt) {
      for (const cl of this.clouds) {
        cl.x -= cl.v * dt;
        if (cl.x < -70) {
          cl.x = this.world.width + rand(20, 80);
          cl.y = rand(40, this.world.height * 0.45);
        }
      }
    }

    _drawClouds() {
      const ctx = this.ctx;
      ctx.fillStyle = CONFIG.colors.cloud;
      for (const cl of this.clouds) {
        ctx.beginPath();
        ctx.arc(cl.x, cl.y, 18 * cl.s, 0, Math.PI * 2);
        ctx.arc(cl.x + 20 * cl.s, cl.y + 5 * cl.s, 14 * cl.s, 0, Math.PI * 2);
        ctx.arc(cl.x - 20 * cl.s, cl.y + 6 * cl.s, 12 * cl.s, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    /* -------------------- UI + storage -------------------- */

    _bindInput() {
      const keyHandler = (e) => {
        if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
          e.preventDefault();
          this._primary();
        }
      };
      global.addEventListener('keydown', keyHandler, { passive: false });

      const pointerHandler = (e) => {
        if (e.target && e.target.closest && e.target.closest('button')) return;
        e.preventDefault();
        this._primary();
      };
      this.canvas.addEventListener('pointerdown', pointerHandler);
      // Tapping the overlay cards (not the button) also works on mobile.
      if (this.ui.startScreen) this.ui.startScreen.addEventListener('pointerdown', pointerHandler);
      if (this.ui.overScreen) this.ui.overScreen.addEventListener('pointerdown', pointerHandler);

      this.ui.startBtn.addEventListener('click', () => this._primary());
      this.ui.restartBtn.addEventListener('click', () => this._primary());
    }

    _primary() {
      if (this.state === STATE.READY || this.state === STATE.OVER) {
        this.start();
      } else {
        this.flap();
      }
    }

    _loadBest() {
      try {
        return parseInt(global.localStorage.getItem(CONFIG.storage.bestKey) || '0', 10) || 0;
      } catch (e) {
        return 0;
      }
    }

    _saveBest() {
      try {
        global.localStorage.setItem(CONFIG.storage.bestKey, String(this.best));
      } catch (e) {
        /* private mode: best simply isn't persisted */
      }
    }

    _syncUI() {
      this.ui.scoreEl.textContent = String(this.score);
      this.ui.bestEl.textContent = String(this.best);
      this.ui.finalScoreEl.textContent = String(this.score);
      this.ui.finalBestEl.textContent = 'Best ' + this.best;
      this.ui.finalBestEl.classList.toggle('new', !!this.isNewBest);
      this.ui.reasonEl.textContent = this.reason || '';

      const playing = this.state === STATE.PLAYING;
      this.ui.startScreen.classList.toggle('hidden', this.state !== STATE.READY);
      this.ui.overScreen.classList.toggle('hidden', this.state !== STATE.OVER);
      this.ui.hud.classList.toggle('hidden', this.state === STATE.READY);
      void playing;
    }

    /** Fit the logical world into the canvas element, preserving aspect. */
    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(global.devicePixelRatio || 1, 2.5);
      const cssW = Math.max(1, rect.width);
      const cssH = Math.max(1, rect.height);
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);

      const targetH = CONFIG.world.height;
      const scale = cssH / targetH;
      const worldW = Math.max(300, Math.min(620, cssW / scale));
      this.world.width = worldW;
      this.world.height = targetH;

      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Logical units -> CSS pixels, centered horizontally.
      this.ctx.setTransform(
        dpr * scale, 0, 0, dpr * scale,
        dpr * (cssW - worldW * scale) / 2,
        0
      );
      this.cssScale = scale;
      this.player.x = this.state === STATE.READY ? worldW * 0.32 : this.player.x;
    }
  }

  global.Game = Game;
  global.STATE = STATE;
})(window);
