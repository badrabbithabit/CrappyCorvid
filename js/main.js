/*
 * Crappy Corvid — Phase 1: core engine (playable, ugly).
 *
 * Plain vanilla JS, fixed 60 Hz timestep, placeholder graphics only.
 * Render is split into layer functions (drawBackground / drawTowers /
 * drawGround / drawCrow / drawHUD) so Phase 2 can swap in the real theme
 * without touching physics or state logic.
 */
"use strict";

// ---------------------------------------------------------------- canvas

const W = 288;   // logical width
const H = 512;   // logical height

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

// Scale the canvas with CSS to fit the window, preserving the 288x512 logical space.
function resize() {
  const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width = Math.floor(W * scale) + "px";
  canvas.style.height = Math.floor(H * scale) + "px";
}
window.addEventListener("resize", resize);
resize();

// ---------------------------------------------------------------- constants
// Verified values from plan.md (60 fps, 288x512 logical canvas).

const STEP = 1000 / 60;      // fixed timestep, ms
const MAX_FRAME = 100;       // clamp dt after tab switch (spiral-of-death guard)

const GRAVITY = 0.25;        // px/f^2
const FLAP_VY = -4.6;        // flap SETS vy, never adds
const TERMINAL_VY = 11;      // px/f fall clamp

// Rotation sell: -30 deg rising, +35..90 deg falling (mapped over 0..terminal vy).
const ROT_RISE = -30 * Math.PI / 180;
const ROT_FALL_MIN = 35 * Math.PI / 180;
const ROT_FALL_MAX = 90 * Math.PI / 180;

const CROW_X = 60;           // fixed horizontal position
const CROW_W = 30;
const CROW_H = 24;
const HIT_INSET = 0.15;      // AABB hitbox inset ~15% of sprite (fairness)

const TOWER_W = 52;
const GAP = 90;
const SCROLL = 2.5;          // px/f, towers + ground scroll at exactly this speed
const SPAWN_SPACING = 190;   // px between consecutive towers (~180-200)
const FIRST_TOWER_X = W + 80; // ~2.1 s of grace at 2.5 px/f after first flap

const GROUND_H = 80;
const GROUND_Y = H - GROUND_H;

// Gap center: uniform random, clamped so both caps stay on-screen with margin.
// (Plan: e.g. 200 px from top to height-100; we use the same intent in
// concrete terms: gap top >= 60 px from top, gap bottom >= 10 px above ground.)
const GAP_MIN_CENTER = 60 + GAP / 2;                 // 105
const GAP_MAX_CENTER = GROUND_Y - GAP / 2 - 10;      // 369

const RESTART_LOCKOUT = 250; // ms, prevents accidental instant restart

// Ceiling policy (decision, documented per plan note): the ceiling is
// NON-LETHAL. The crow may flap above the top of the screen and gravity
// brings it back. Because a flap SETS vy (never adds), the max climb per
// flap is ~42 px, so the crow can never escape the screen permanently.
const CEILING_NON_LETHAL = true;

const BEST_KEY = "crappycorvid.best";

// ---------------------------------------------------------------- state

// READY -> PLAYING -> DYING -> GAME OVER -> (tap) READY
const ST_READY = 0;
const ST_PLAYING = 1;
const ST_DYING = 2;
const ST_GAMEOVER = 3;

const game = {
  state: ST_READY,
  crow: { y: 0, vy: 0, rot: 0 },
  towers: [],
  score: 0,
  best: 0,
  readyT: 0,          // frames in READY, for the bob
  groundOffset: 0,   // scroll phase for the ground layer
  gameOverAt: 0,     // ms timestamp when GAME OVER panel appeared
  flash: 0,          // death-flash frames remaining (1-frame cold flash)
};

function loadBest() {
  try {
    const v = parseInt(localStorage.getItem(BEST_KEY), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch (e) {
    return 0; // localStorage may be unavailable (privacy mode, file://)
  }
}

function saveBest(v) {
  try {
    localStorage.setItem(BEST_KEY, String(v));
  } catch (e) {
    // ignore — best score just won't persist
  }
}

function resetGame() {
  game.state = ST_READY;
  game.crow.y = H * 0.42;
  game.crow.vy = 0;
  game.crow.rot = 0;
  game.towers.length = 0;
  game.score = 0;
  game.readyT = 0;
  game.flash = 0;
}

game.best = loadBest();
resetGame();

// ---------------------------------------------------------------- towers

function makeTower(x) {
  const center = GAP_MIN_CENTER + Math.random() * (GAP_MAX_CENTER - GAP_MIN_CENTER);
  return {
    x,
    topH: center - GAP / 2,  // height of the upper cap
    botY: center + GAP / 2,  // y of the bottom edge of the gap
    passed: false,
  };
}

function spawnTowers() {
  if (game.towers.length === 0) {
    game.towers.push(makeTower(FIRST_TOWER_X));
    return;
  }
  let last = game.towers[game.towers.length - 1];
  // Keep spawning while the last tower is within SPAWN_SPACING of the right edge.
  while (last.x < W + SPAWN_SPACING) {
    const t = makeTower(last.x + SPAWN_SPACING);
    game.towers.push(t);
    last = t;
  }
}

// ---------------------------------------------------------------- collision

function crowHitbox() {
  const c = game.crow;
  const ix = CROW_W * HIT_INSET;
  const iy = CROW_H * HIT_INSET;
  return {
    x: CROW_X + ix,
    y: c.y + iy,
    w: CROW_W - 2 * ix,
    h: CROW_H - 2 * iy,
  };
}

function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function checkCollisions() {
  const hb = crowHitbox();
  // Ground is lethal.
  if (hb.y + hb.h >= GROUND_Y) return true;
  // Ceiling: non-lethal by design (see CEILING_NON_LETHAL note).
  for (const t of game.towers) {
    const top = { x: t.x, y: 0, w: TOWER_W, h: t.topH };
    const bot = { x: t.x, y: t.botY, w: TOWER_W, h: GROUND_Y - t.botY };
    if (aabb(hb, top) || aabb(hb, bot)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- update

function startPlay() {
  // First flap: leave READY, give the world its grace period.
  game.state = ST_PLAYING;
  spawnTowers();
  flap();
}

function flap() {
  // Flap SETS velocity — never adds (double-tap ceiling-launch guard).
  game.crow.vy = FLAP_VY;
}

function die() {
  game.state = ST_DYING;
  game.flash = 1; // 1-frame cold flash
}

function targetRotation(vy) {
  if (vy < 0) return ROT_RISE;
  // Map 0..TERMINAL_VY -> +35..+90 degrees.
  const t = Math.min(vy / TERMINAL_VY, 1);
  return ROT_FALL_MIN + t * (ROT_FALL_MAX - ROT_FALL_MIN);
}

function update() {
  // Scroll phase for the ground (same speed as towers, always in motion
  // after the first flap; in READY it creeps for a live feel).
  game.groundOffset = (game.groundOffset + SCROLL) % 64;

  const c = game.crow;
  switch (game.state) {
    case ST_READY: {
      // Bobbing crow, no physics/pipe updates (first-flap gate).
      game.readyT++;
      c.y = H * 0.42 + Math.sin(game.readyT / 10) * 8;
      c.rot = 0;
      break;
    }

    case ST_PLAYING: {
      c.vy = Math.min(c.vy + GRAVITY, TERMINAL_VY);
      c.y += c.vy;
      // Smooth the rotation sell toward the target.
      const target = targetRotation(c.vy);
      c.rot += (target - c.rot) * 0.2;

      // Move towers + cull + spawn.
      for (const t of game.towers) t.x -= SCROLL;
      if (game.towers.length && game.towers[0].x + TOWER_W < 0) game.towers.shift();
      spawnTowers();

      // Pipe-pass scoring: trigger once per tower, not a frame counter.
      for (const t of game.towers) {
        if (!t.passed && t.x + TOWER_W < CROW_X) {
          t.passed = true;
          game.score++;
          if (game.score > game.best) {
            game.best = game.score;
            saveBest(game.best);
          }
        }
      }

      if (checkCollisions()) die();
      break;
    }

    case ST_DYING: {
      // Crow tumbles to the ground before the game-over panel.
      c.vy = Math.min(c.vy + GRAVITY, TERMINAL_VY);
      c.y += c.vy;
      c.rot += (ROT_FALL_MAX - c.rot) * 0.3;
      const hb = crowHitbox();
      if (hb.y + hb.h >= GROUND_Y) {
        // Land so the inset hitbox bottom sits on the ground line.
        c.y = GROUND_Y - CROW_H * (1 - HIT_INSET);
        game.state = ST_GAMEOVER;
        game.gameOverAt = performance.now();
      }
      break;
    }

    case ST_GAMEOVER:
      break;
  }

  if (game.flash > 0) game.flash--;
}

// ---------------------------------------------------------------- input

function onInput() {
  switch (game.state) {
    case ST_READY:
      startPlay();
      break;
    case ST_PLAYING:
      flap();
      break;
    case ST_GAMEOVER:
      if (performance.now() - game.gameOverAt >= RESTART_LOCKOUT) resetGame();
      break;
    // ST_DYING: ignore input
  }
}

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) onInput();
  }
});
window.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  onInput();
});

// ---------------------------------------------------------------- render
// Placeholder graphics only — each layer is its own function so Phase 2
// can replace the body without touching the frame loop.

function drawBackground() {
  // Placeholder: flat dark fill. (Phase 2: sky gradient, moon, stars, parallax.)
  ctx.fillStyle = "#202028";
  ctx.fillRect(0, 0, W, H);
}

function drawTowers() {
  ctx.fillStyle = "#4a4a55";
  for (const t of game.towers) {
    if (t.x > W || t.x + TOWER_W < 0) continue;
    ctx.fillRect(t.x, 0, TOWER_W, t.topH);
    ctx.fillRect(t.x, t.botY, TOWER_W, GROUND_Y - t.botY);
  }
}

function drawGround() {
  // Placeholder: flat strip with a scrolling stripe so the scroll is visible.
  ctx.fillStyle = "#33333c";
  ctx.fillRect(0, GROUND_Y, W, GROUND_H);
  ctx.fillStyle = "#3d3d48";
  const off = -game.groundOffset;
  for (let x = off % 64 - 64; x < W; x += 64) {
    ctx.fillRect(x, GROUND_Y, 32, GROUND_H);
  }
}

function drawCrow() {
  ctx.save();
  const c = game.crow;
  ctx.translate(CROW_X + CROW_W / 2, c.y + CROW_H / 2);
  ctx.rotate(c.rot);
  ctx.fillStyle = "#c9c9c9"; // grey rectangle crow
  ctx.fillRect(-CROW_W / 2, -CROW_H / 2, CROW_W, CROW_H);
  ctx.restore();
}

function drawHUD() {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 24px monospace";
  ctx.textAlign = "center";
  if (game.state === ST_READY) {
    ctx.fillText("tap / space to flap", W / 2, 100);
  } else {
    ctx.fillText(String(game.score), W / 2, 60);
  }
}

function drawGameOver() {
  if (game.state !== ST_GAMEOVER) return;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px monospace";
  ctx.textAlign = "center";
  ctx.fillText("GAME OVER", W / 2, H / 2 - 40);
  ctx.font = "16px monospace";
  ctx.fillText("score " + game.score + "   best " + game.best, W / 2, H / 2);
  ctx.fillText("tap to restart", W / 2, H / 2 + 36);
}

function draw() {
  drawBackground();
  drawTowers();
  drawGround();
  drawCrow();
  drawHUD();
  drawGameOver();
  if (game.flash > 0) {
    ctx.fillStyle = "#B8C4D6"; // 1-frame cold death flash
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------------------------------------------------------------- loop

let last = performance.now();
let acc = 0;

function frame(now) {
  let dt = now - last;
  last = now;
  if (dt > MAX_FRAME) dt = MAX_FRAME; // tab switch: don't spiral
  acc += dt;
  while (acc >= STEP) {
    update();
    acc -= STEP;
  }
  draw();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
