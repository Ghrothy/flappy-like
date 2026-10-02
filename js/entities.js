/**
 * Game entities: Player character, obstacle gate, scrolling ground and the
 * particle system used for the visual effects.
 * All drawing is done with primitive canvas calls (no external assets).
 */
(function (global) {
  'use strict';

  const CONFIG = global.CONFIG;
  const rand = (min, max) => min + Math.random() * (max - min);

  /* ------------------------------------------------------------------ */
  class Player {
    constructor(world) {
      this.world = world;
      this.reset();
    }

    reset() {
      this.x = CONFIG.player.x;
      this.y = this.world.height * 0.42;
      this.vy = 0;
      this.radius = CONFIG.player.radius;
      this.hitRadius = CONFIG.player.hitRadius;
      this.rotation = 0;
      this.wingPhase = 0;
      this.wingUp = false;
    }

    flap() {
      this.vy = CONFIG.physics.flapImpulse;
      this.wingUp = true;
      this.wingPhase = 0;
    }

    update(dt) {
      this.vy += CONFIG.physics.gravity * dt;
      if (this.vy > CONFIG.physics.maxFallSpeed) {
        this.vy = CONFIG.physics.maxFallSpeed;
      }
      this.y += this.vy * dt;

      const target = this.vy < 0
        ? CONFIG.physics.tiltUp
        : CONFIG.physics.tiltDown * Math.min(1, this.vy / 620);
      this.rotation += (target - this.rotation) * Math.min(1, CONFIG.physics.tiltLerp * dt);

      this.wingPhase += dt * 9;
      this.wingUp = false;
    }

    /** Circle used for collision, drawn rotated with the body. */
    bounds() {
      return { x: this.x, y: this.y, r: this.hitRadius };
    }

    hitsRect(rect) {
      const b = this.bounds();
      const nx = Math.max(rect.x, Math.min(b.x, rect.x + rect.w));
      const ny = Math.max(rect.y, Math.min(b.y, rect.y + rect.h));
      const dx = b.x - nx;
      const dy = b.y - ny;
      return dx * dx + dy * dy <= b.r * b.r;
    }

    draw(ctx) {
      const s = this.radius;
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.rotation);

      // tail
      ctx.fillStyle = CONFIG.colors.bodyDark;
      ctx.beginPath();
      ctx.moveTo(-s * 0.75, 0);
      ctx.lineTo(-s * 1.75, -s * 0.5);
      ctx.lineTo(-s * 1.6, s * 0.15);
      ctx.closePath();
      ctx.fill();

      // body
      const grad = ctx.createLinearGradient(0, -s, 0, s);
      grad.addColorStop(0, CONFIG.colors.body);
      grad.addColorStop(1, CONFIG.colors.bodyDark);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 1.05, s * 0.92, 0, 0, Math.PI * 2);
      ctx.fill();

      // wing: animates right after a flap
      const swing = Math.max(0, 1 - this.wingPhase / 0.35);
      ctx.fillStyle = CONFIG.colors.wing;
      ctx.beginPath();
      ctx.ellipse(
        -s * 0.05,
        -s * 0.05 - swing * s * 0.75,
        s * 0.62,
        s * (0.4 - swing * 0.12),
        -0.5 - swing * 0.5,
        0,
        Math.PI * 2
      );
      ctx.fill();

      // eye
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(s * 0.45, -s * 0.3, s * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = CONFIG.colors.eye;
      ctx.beginPath();
      ctx.arc(s * 0.55, -s * 0.3, s * 0.14, 0, Math.PI * 2);
      ctx.fill();

      // beak
      ctx.fillStyle = '#ff8f3f';
      ctx.beginPath();
      ctx.moveTo(s * 0.75, -s * 0.05);
      ctx.lineTo(s * 1.7, s * 0.12);
      ctx.lineTo(s * 0.75, s * 0.3);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ */
  class Obstacle {
    constructor(world, x, gapTop) {
      const o = CONFIG.obstacles;
      this.world = world;
      this.w = o.width;
      this.h = 46; // cap height
      this.gap = o.gap;
      this.x = x;
      this.gapTop = gapTop;
      this.gapBottom = gapTop + this.gap;
      this.scored = false;
    }

    get right() {
      return this.x + this.w;
    }

    get left() {
      return this.x;
    }

    /** Top and bottom pipe rects. */
    rects() {
      const groundY = this.world.height - CONFIG.world.groundHeight;
      return [
        { x: this.x, y: 0, w: this.w, h: this.gapTop },
        { x: this.x, y: this.gapBottom, w: this.w, h: groundY - this.gapBottom }
      ];
    }

    update(dt, speed) {
      this.x -= speed * dt;
    }

    offscreen() {
      return this.right < -8;
    }

    draw(ctx) {
      const [top, bottom] = this.rects();
      this._drawPipe(ctx, top, true);
      this._drawPipe(ctx, bottom, false);
    }

    _drawPipe(ctx, r, isTop) {
      const c = CONFIG.colors;
      const capH = this.h;
      const capY = isTop ? r.y + r.h - capH : r.y;
      const shaftH = r.h - capH;

      // shaft
      const g = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
      g.addColorStop(0, c.pipeDark);
      g.addColorStop(0.35, c.pipe);
      g.addColorStop(1, c.pipeDark);
      ctx.fillStyle = g;
      ctx.fillRect(r.x, capY, r.w, shaftH);

      // cap
      const cg = ctx.createLinearGradient(r.x, 0, r.x + r.w, 0);
      cg.addColorStop(0, c.pipeDark);
      cg.addColorStop(0.3, c.pipeCap);
      cg.addColorStop(1, c.pipeDark);
      ctx.fillStyle = cg;
      ctx.fillRect(r.x - 5, capY, r.w + 10, capH);

      // highlight
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(r.x + 6, capY + 3, 5, Math.max(0, r.h - capH - 6));
    }
  }

  /* ------------------------------------------------------------------ */
  class Ground {
    constructor(world) {
      this.world = world;
      this.y = world.height - CONFIG.world.groundHeight;
      this.offset = 0;
    }

    update(dt, speed) {
      this.offset = (this.offset + speed * dt) % 32;
    }

    draw(ctx) {
      const c = CONFIG.colors;
      const w = this.world.width;

      ctx.fillStyle = c.ground;
      ctx.fillRect(0, this.y, w, CONFIG.world.groundHeight);
      ctx.fillStyle = c.groundDark;
      ctx.fillRect(0, this.y + 46, w, CONFIG.world.groundHeight - 46);

      // grass strip with scalloped edge
      ctx.fillStyle = c.groundGrass;
      ctx.fillRect(0, this.y, w, 14);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      for (let x = -32 + this.offset; x < w + 32; x += 32) {
        ctx.fillRect(x, this.y + 2, 14, 4);
      }

      // dirt pebbles
      ctx.fillStyle = 'rgba(0,0,0,0.10)';
      for (let x = -32 + this.offset; x < w + 32; x += 32) {
        ctx.beginPath();
        ctx.arc(x + 8, this.y + 34, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  class Particles {
    constructor() {
      this.items = [];
    }

    clear() {
      this.items.length = 0;
    }

    spawn(x, y, count, opts = {}) {
      for (let i = 0; i < count; i++) {
        const angle = opts.angle != null
          ? opts.angle + rand(-0.7, 0.7)
          : rand(0, Math.PI * 2);
        const speed = rand(opts.speedMin || 40, opts.speedMax || 140);
        this.items.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: rand(opts.lifeMin || 0.35, opts.lifeMax || 0.7),
          age: 0,
          size: rand(opts.sizeMin || 2, opts.sizeMax || 4),
          color: opts.color || CONFIG.colors.feather,
          gravity: opts.gravity != null ? opts.gravity : 260,
          spin: rand(-6, 6)
        });
      }
    }

    update(dt) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const p = this.items[i];
        p.age += dt;
        if (p.age >= p.life) {
          this.items.splice(i, 1);
          continue;
        }
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.98;
      }
    }

    draw(ctx) {
      for (const p of this.items) {
        const k = 1 - p.age / p.life;
        ctx.globalAlpha = Math.max(0, k);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.4 + k * 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  global.Entities = { Player, Obstacle, Ground, Particles, rand };
})(window);
