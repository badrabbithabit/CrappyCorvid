/*
 * Crappy Corvid — core engine + Phase 4 polish.
 *
 * Plain vanilla JS, fixed 60 Hz timestep. Render is split into layer
 * functions (drawBackground / drawTowers / drawGround / drawCrow / drawHUD)
 * so the scene theme can be swapped in without touching physics or state
 * logic. Phase 4 adds: HiDPI-crisp scaling, 1-frame death flash + tumble,
 * stone game-over panel with medal tiers, first-3-towers grace gap, pause
 * on window blur, and unified pointer input (touch works out of the box).
 */
"use strict";

// ---------------------------------------------------------------- canvas

const W = 288;   // logical width
const H = 512;   // logical height

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;

// Scale the canvas with CSS to fit the window, preserving the 288x512
// logical space. The backing store is sized by devicePixelRatio (capped at
// 3) so the game renders crisp on HiDPI screens instead of blurry (Phase 4).
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
  canvas.style.width = Math.floor(W * scale) + "px";
  canvas.style.height = Math.floor(H * scale) + "px";
  const px = Math.max(1, Math.round(scale * dpr)); // backing-store scale
  canvas.width = W * px;
  canvas.height = H * px;
  // All drawing below stays in 288x512 logical units.
  ctx.setTransform(px, 0, 0, px, 0, 0);
  ctx.imageSmoothingEnabled = false; // resizing resets context state; re-apply
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

// Gap center: uniform random, clamped so both caps stay on-screen with
// margin (gap top >= 60 px from the top, gap bottom >= 10 px above ground).
//
// GRACE (Phase 4): the first GRACE_TOWERS towers of every run get a
// +GRACE_GAP_MULT gap so a fresh run eases in before full difficulty hits.
const GRACE_TOWERS = 3;
const GRACE_GAP_MULT = 1.25; // 90 px gap -> 112.5 px for the first three

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
  runTowers: 0,     // towers spawned this run (drives the grace gap)
  readyT: 0,          // frames in READY, for the bob
  worldOffset: 0,    // ONE scroll accumulator (px) driving every parallax layer
  worldT: 0,         // frames the world has moved (bat drift phase)
  runT: 0,           // frames since the run left READY (lightning gate)
  crowAnimT: 0,      // wing-cycle counter (advanced while rising)
  crowFrame: 0,      // 0 wing up / 1 level / 2 tucked
  nextBoltAt: 0,     // runT frame at which the next lightning bolt may fire
  boltFrames: 0,     // lightning flash frames remaining
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
  game.runTowers = 0; // grace gap restarts every run
  game.readyT = 0;
  game.crowAnimT = 0;
  game.crowFrame = 0;
  game.flash = 0;
}

game.best = loadBest();
resetGame();

// ---------------------------------------------------------------- towers

function makeTower(x) {
  // Grace: first GRACE_TOWERS towers of the run get the wider gap.
  const gap = game.runTowers < GRACE_TOWERS ? GAP * GRACE_GAP_MULT : GAP;
  const minCenter = 60 + gap / 2;
  const maxCenter = GROUND_Y - gap / 2 - 10;
  const center = minCenter + Math.random() * (maxCenter - minCenter);
  game.runTowers++;
  return {
    x,
    gap,
    topH: center - gap / 2,  // height of the upper cap
    botY: center + gap / 2,  // y of the bottom edge of the gap
    passed: false,
    seed: Math.random(), // per-tower art variation (lantern) — physics never reads this
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
  game.runT = 0;
  game.boltFrames = 0;
  game.nextBoltAt = 900 + Math.floor(Math.random() * 601); // first bolt 15-25 s in
  spawnTowers();
  flap();
}

function flap() {
  // Flap SETS velocity — never adds (double-tap ceiling-launch guard).
  game.crow.vy = FLAP_VY;
  CrowAudio.flap();
}

function die() {
  game.state = ST_DYING;
  game.flash = 1; // 1-frame cold flash
  CrowAudio.hit();
  CrowAudio.die();
}

function targetRotation(vy) {
  if (vy < 0) return ROT_RISE;
  // Map 0..TERMINAL_VY -> +35..+90 degrees.
  const t = Math.min(vy / TERMINAL_VY, 1);
  return ROT_FALL_MIN + t * (ROT_FALL_MAX - ROT_FALL_MIN);
}

function update() {
  // Flash countdown at the TOP: die() (called further down, from
  // checkCollisions) sets flash=1, and it must survive to this frame's
  // draw() — decrementing after the switch would eat the flash on the
  // very update that sets it, so the 1-frame flash would never render.
  if (game.flash > 0) game.flash--;

  // Lightning flash decays in any state (a bolt in flight never freezes
  // half-lit when the crow dies); it can only TRIGGER while PLAYING.
  if (game.boltFrames > 0) game.boltFrames--;

  const c = game.crow;
  switch (game.state) {
    case ST_READY: {
      // World frozen in READY — towers, ground and parallax all wait for the
      // first flap, so every layer freezes in sync.
      // Bobbing crow, no physics/pipe updates (first-flap gate).
      game.readyT++;
      c.y = H * 0.42 + Math.sin(game.readyT / 10) * 8;
      c.rot = 0;
      game.crowFrame = 0; // hold frame 0 with the bob
      break;
    }

    case ST_PLAYING: {
      // One world offset, advanced at exactly SCROLL px/f — towers, ground
      // and every parallax layer derive their scroll from this single value.
      game.worldOffset += SCROLL;
      game.worldT++;
      game.runT++;
      // Lightning: 2-4 frame flash, cadence 15-25 s, never in the first 10 s
      // (600 frames) of a run. nextBoltAt starts at >= 900, so the 600-frame
      // gate is a belt-and-braces check.
      if (game.runT >= 600 && game.runT >= game.nextBoltAt) {
        game.boltFrames = 2 + Math.floor(Math.random() * 3); // 2..4 frames
        game.nextBoltAt = game.runT + 900 + Math.floor(Math.random() * 601);
        // Thunder paired with the flash (ambient self-scheduling of thunder
        // was removed from audio.js so sound and flash never drift apart).
        if (typeof CrowAudio.thunder === "function") CrowAudio.thunder();
      }
      c.vy = Math.min(c.vy + GRAVITY, TERMINAL_VY);
      c.y += c.vy;
      // Wing animation: cycle up/level/tucked every ~10 frames while rising,
      // hold the tucked frame while falling (rotation sells the fall).
      if (c.vy < 0) {
        game.crowAnimT++;
        game.crowFrame = Math.floor(game.crowAnimT / 10) % 3;
      } else {
        game.crowFrame = 2;
      }
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
          CrowAudio.score();
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
      // World keeps scrolling until the crow hits the ground.
      game.worldOffset += SCROLL;
      game.worldT++;
      // Towers must move in lockstep with the ground/parallax (no new
      // spawns on death) — otherwise the world slides under frozen towers.
      for (const t of game.towers) t.x -= SCROLL;
      if (game.towers.length && game.towers[0].x + TOWER_W < 0) game.towers.shift();
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
}

// ---------------------------------------------------------------- input

function onInput() {
  if (paused) return; // never take input while blurred/paused
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
  CrowAudio.unlock(); // first user gesture: create/resume AudioContext
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) onInput();
  } else if (e.code === "KeyM") {
    CrowAudio.toggleMute();
  }
});
window.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  CrowAudio.unlock();
  // Ignore right/middle clicks and non-primary pointers (extra fingers).
  if (e.isPrimary && e.button === 0) onInput();
});

// ---------------------------------------------------------------- world art
// Phase 2 night world. Every layer scrolls from ONE accumulator,
// game.worldOffset (advanced by SCROLL per fixed step while the world
// moves: PLAYING, and DYING until the crow lands; frozen in READY,
// GAME OVER and while paused). Strips are pre-rendered offscreen once;
// shapes never cross a strip edge so wrapping is seamless.

const MOON_R = 18;

function makeWorldCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// L1: a handful of static stars (fixed positions, generated once).
const STARS = (() => {
  const s = [];
  for (let i = 0; i < 24; i++) {
    s.push({
      x: Math.random() * W,
      y: 8 + Math.random() * 290,
      r: Math.random() < 0.8 ? 1 : 2,
      a: 0.25 + Math.random() * 0.55,
    });
  }
  return s;
})();

// L2: far castle skyline, #151027, scrolls at 0.5x. 432 px strip.
const L2_W = 432, L2_H = 170;
const skyStrip = (function buildSkylineStrip() {
  const c = makeWorldCanvas(L2_W, L2_H);
  const g = c.getContext("2d");
  g.fillStyle = "#151027";
  const base = L2_H; // strip bottom = horizon
  function wall(x, w, h) { g.fillRect(x, base - h, w, h); }
  function cren(x, w, top) {
    for (let cx = x; cx + 9 <= x + w; cx += 16) g.fillRect(cx, top - 6, 9, 6);
  }
  function spire(x, w, h, sh) {
    wall(x, w, h);
    g.beginPath();
    g.moveTo(x - 3, base - h);
    g.lineTo(x + w / 2, base - h - sh);
    g.lineTo(x + w + 3, base - h);
    g.closePath();
    g.fill();
  }
  // Every shape stays clear of the strip edges (seam stays invisible).
  spire(20, 26, 90, 34);
  wall(58, 34, 62); cren(58, 34, base - 62);
  spire(104, 20, 120, 40);
  wall(136, 44, 74); cren(136, 44, base - 74);
  spire(196, 24, 104, 30);
  wall(230, 30, 56); cren(230, 30, base - 56);
  wall(268, 50, 86); cren(268, 50, base - 86);
  spire(332, 22, 132, 38);
  wall(364, 40, 66); cren(364, 40, base - 66);
  spire(412, 16, 84, 26);
  return c;
})();

// L3: nearer battlements + dead trees, #0E0A1C, scrolls at 1.0x. 384 px strip.
const L3_W = 384, L3_H = 110;
const nearStrip = (function buildBattlementStrip() {
  const c = makeWorldCanvas(L3_W, L3_H);
  const g = c.getContext("2d");
  const base = L3_H;
  g.fillStyle = "#0E0A1C";
  g.strokeStyle = "#0E0A1C";
  g.lineCap = "round";
  // Low crenellated wall across the bottom (clear of the strip edges).
  const wy = base - 34;
  g.fillRect(6, wy, L3_W - 12, 34);
  for (let cx = 12; cx + 11 <= L3_W - 12; cx += 22) g.fillRect(cx, wy - 8, 11, 8);
  // Two square bastion towers.
  for (const tx of [54, 296]) {
    g.fillRect(tx, base - 66, 34, 66);
    for (let cx = tx + 2; cx + 11 <= tx + 34; cx += 18) g.fillRect(cx, base - 74, 11, 8);
  }
  // Dead trees: bare trunk with a few forked branches.
  function tree(x, h) {
    const top = base - h;
    g.lineWidth = 4;
    g.beginPath(); g.moveTo(x, base); g.lineTo(x, top); g.stroke();
    g.lineWidth = 2;
    const branches = [[-14, 0.45, -9], [12, 0.6, -11], [-9, 0.75, -8],
                      [11, 0.3, -7], [-6, 0.92, -8]];
    for (const [dx, t, dy] of branches) {
      const by = base - t * h;
      g.beginPath();
      g.moveTo(x, by);
      g.lineTo(x + dx, by + dy);
      g.stroke();
    }
  }
  tree(176, 62);
  tree(248, 48);
  return c;
})();

// L4: one pre-rendered fog puff strip, 384x44, reused twice (opposite
// directions). Baked alpha 0.22 composited at 0.9 -> effective <= 0.25.
const FOG_W = 384, FOG_H = 44;
const fogStrip = (function buildFogStrip() {
  const c = makeWorldCanvas(FOG_W, FOG_H);
  const g = c.getContext("2d");
  g.fillStyle = "#3A3352";
  g.globalAlpha = 0.22;
  // Puffs, kept clear of the strip edges so the wrap is seamless.
  const puffs = [[46, 22, 34, 10], [100, 14, 40, 8], [160, 26, 48, 11],
                 [224, 16, 42, 9], [286, 24, 44, 10], [338, 15, 36, 8]];
  for (const [px, py, rx, ry] of puffs) {
    g.beginPath();
    g.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
  }
  return c;
})();

// L2 bats: tiny slow 'v' shapes riding the far layer with a little extra
// drift of their own. Non-interactive; frozen when the world is.
const BATS = [
  { x0: 0, y0: 150, speed: 0.25, bob: 17 },
  { x0: 140, y0: 210, speed: 0.18, bob: 23 },
  { x0: 260, y0: 120, speed: 0.32, bob: 13 },
];

// L5: graveyard cobble tile, 64x80, scrolls at exactly 1.0x (SCROLL).
const GROUND_TILE_W = 64;
const groundTile = (function buildGroundTile() {
  const c = makeWorldCanvas(GROUND_TILE_W, GROUND_H);
  const g = c.getContext("2d");
  g.fillStyle = "#1C1633";
  g.fillRect(0, 0, GROUND_TILE_W, GROUND_H);
  // Moonlit rim along the top edge.
  g.fillStyle = "#4A3F6B";
  g.fillRect(0, 0, GROUND_TILE_W, 3);
  // Cobble courses: dark mortar lines with staggered joints.
  g.strokeStyle = "#0E0A1C";
  g.lineWidth = 2;
  for (let row = 0; 22 + row * 18 < GROUND_H; row++) {
    const y = 22 + row * 18;
    g.beginPath(); g.moveTo(0, y); g.lineTo(GROUND_TILE_W, y); g.stroke();
    const off = row % 2 ? 16 : 0;
    for (let x = off + 16; x < GROUND_TILE_W; x += 32) {
      g.beginPath(); g.moveTo(x, y - 18); g.lineTo(x, y); g.stroke();
    }
  }
  // A few soil specks (all clear of the tile seam).
  g.fillStyle = "#0E0A1C";
  for (const [sx, sy] of [[10, 50], [34, 62], [52, 40], [22, 74], [44, 10]]) {
    g.fillRect(sx, sy, 3, 2);
  }
  return c;
})();

// Draw a pre-rendered strip tiled left-to-right, wrapped, from offset px.
function drawWrapped(strip, width, offset, y) {
  let x = -offset;
  for (; x < W; x += width) ctx.drawImage(strip, x, y);
}

// ---------------------------------------------------------------- render
// Each layer is its own function so the scene theme can be replaced
// without touching the frame loop. UI elements use the Phase 4 palette:
// eerie green #7CFC8B with glow, stone #1C1633 / edge #4A3F6B / mortar
// #0E0A1C, bone-white #E8E3D0, dim stone-grey #8F8A9E.

// Eerie green (Phase 4) — the glow accent for score/medals/hints.
const GREEN = "#7CFC8B";

function glowText(text, x, y, font, alpha) {
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.globalAlpha = alpha !== undefined ? alpha : 1;
  ctx.fillStyle = GREEN;
  ctx.shadowColor = GREEN;
  ctx.shadowBlur = 10;
  ctx.fillText(text, x, y);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function drawBackground() {
  const wo = game.worldOffset;

  // L1: night sky, #0B0714 -> #1A1030 -> #2D1B4E at the horizon.
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, "#0B0714");
  sky.addColorStop(0.55, "#1A1030");
  sky.addColorStop(1, "#2D1B4E");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, GROUND_Y);

  // L1: static stars.
  ctx.fillStyle = "#E8E3D0";
  for (const s of STARS) {
    ctx.globalAlpha = s.a;
    ctx.fillRect(s.x, s.y, s.r, s.r);
  }
  ctx.globalAlpha = 1;

  // L1: moon with soft halo, drifting left at 0.2x, wrapping fully
  // off-screen before reappearing (margin M keeps it clear at both ends).
  const M = MOON_R + 20;
  const mx = W + M - ((wo * 0.2) % (W + 2 * M));
  const my = 84;
  const halo = ctx.createRadialGradient(mx, my, MOON_R, mx, my, 54);
  halo.addColorStop(0, "rgba(201,196,184,0.20)");
  halo.addColorStop(1, "rgba(201,196,184,0)");
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(mx, my, 54, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#E8E3D0";
  ctx.beginPath(); ctx.arc(mx, my, MOON_R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(201,196,184,0.5)"; // a couple of craters
  ctx.beginPath(); ctx.arc(mx - 5, my - 3, 3.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(mx + 4, my + 6, 2.3, 0, Math.PI * 2); ctx.fill();

  // L2: far castle skyline at 0.5x, wrapping 432 px strip.
  drawWrapped(skyStrip, L2_W, (wo * 0.5) % L2_W, GROUND_Y - L2_H);

  // L2 bats: tiny 'v' shapes riding the far layer, slow bob + own drift.
  ctx.strokeStyle = "#0E0A1C";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  const bt = game.worldT;
  for (let i = 0; i < BATS.length; i++) {
    const b = BATS[i];
    const span = W + 40;
    const bx = W + 20 - ((b.x0 + wo * 0.5 + bt * b.speed) % span);
    const by = b.y0 + Math.sin(bt / b.bob + i * 2.1) * 7;
    const wing = Math.sin(bt / 6 + i * 1.7) > 0 ? 3.5 : 1; // wing flicker
    ctx.beginPath();
    ctx.moveTo(bx - 4, by - wing);
    ctx.lineTo(bx, by);
    ctx.lineTo(bx + 4, by - wing);
    ctx.stroke();
  }

  // L3: near battlements + dead trees at 1.0x, wrapping 384 px strip.
  drawWrapped(nearStrip, L3_W, wo % L3_W, GROUND_Y - L3_H);

  // L4: two fog bands at 0.75x, opposite directions, lower third only
  // (soft puffs, low alpha — never a solid bar, never across mid-screen).
  ctx.globalAlpha = 0.9;
  drawWrapped(fogStrip, FOG_W, (wo * 0.75) % FOG_W, 344);
  drawWrapped(fogStrip, FOG_W, (FOG_W - ((wo * 0.75) % FOG_W)) % FOG_W, 396);
  ctx.globalAlpha = 1;

  // Lightning: full-screen white flash, 2-4 frames, fading each frame.
  if (game.boltFrames > 0) {
    const a = (game.boltFrames * 0.045).toFixed(3); // 0.18 -> 0.045
    ctx.fillStyle = "rgba(226,232,255," + a + ")";
    ctx.fillRect(0, 0, W, H);
  }
}

// Castle tower art (Phase 2). Collision boxes are unchanged: the upper box
// is (x, 0, TOWER_W, topH) and the lower box (x, botY, TOWER_W, ...). All
// decorative pixels stay inside those boxes EXCEPT the 5 px crenellated
// teeth on the gap-adjacent ends, which extend into the gap. 5 px is small
// against the crow's 15% hitbox inset (3.6 px vertical) so the death still
// reads fair: the crow visually touches a tooth just before the hitbox trips.
function drawTowerBody(x, y0, y1) {
  const h = y1 - y0;
  if (h <= 0) return;
  ctx.fillStyle = "#1C1633"; // stone fill
  ctx.fillRect(x, y0, TOWER_W, h);
  // Moonlit edge on the lit (left) side.
  ctx.fillStyle = "#4A3F6B";
  ctx.fillRect(x, y0, 3, h);
  // Subtle vertical shading: lit left fading into shadow on the right.
  const sh = ctx.createLinearGradient(x, 0, x + TOWER_W, 0);
  sh.addColorStop(0, "rgba(74,63,107,0.15)");
  sh.addColorStop(0.45, "rgba(11,7,20,0)");
  sh.addColorStop(1, "rgba(11,7,20,0.30)");
  ctx.fillStyle = sh;
  ctx.fillRect(x, y0, TOWER_W, h);
  // Dark mortar courses with staggered joints (inside the body only).
  ctx.strokeStyle = "#0E0A1C";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let y = y0 + 20, row = 0; y < y1 - 6; y += 20, row++) {
    ctx.moveTo(x + 1, y);
    ctx.lineTo(x + TOWER_W - 1, y);
    for (let vx = x + 8 + (row % 2 ? 17 : 0); vx < x + TOWER_W - 4; vx += 34) {
      ctx.moveTo(vx, Math.max(y0 + 2, y - 17));
      ctx.lineTo(vx, y);
    }
  }
  ctx.stroke();
}

// Crenellated cap on the gap-adjacent end of a tower. dir=+1: teeth extend
// DOWN from yEdge (upper tower, yEdge = topH); dir=-1: teeth extend UP from
// yEdge (lower tower, yEdge = botY). A 2 px moonlit lip sits just inside the
// collision box along the gap end.
function drawTowerTeeth(t, yEdge, dir) {
  const h = 5; // extension beyond the collision box, kept small (see note)
  ctx.fillStyle = "#1C1633";
  for (let cx = t.x + 2; cx + 9 <= t.x + TOWER_W - 1; cx += 16) {
    ctx.fillRect(cx, dir > 0 ? yEdge : yEdge - h, 9, h);
  }
  ctx.fillStyle = "#4A3F6B";
  ctx.fillRect(t.x, dir > 0 ? yEdge - 2 : yEdge, TOWER_W, 2);
}

// Occasional flickering lantern: ~1 in 3 towers (t.seed), always on the
// stone body at least 18 px away from the gap edge — never in the corridor.
function drawTowerLantern(t, now) {
  if (t.seed >= 0.34) return; // most towers stay dark
  const phase = t.seed * 40;
  // Occasional dropout blink, plus a slow warm pulse in between.
  if (Math.floor(now / 420 + phase) % 5 === 0) return;
  const a = 0.35 + 0.55 * (Math.sin(now / 90 + phase) * 0.5 + 0.5);
  let lx, ly, ok;
  if (t.seed < 0.17) {
    lx = t.x + 14; ly = t.topH - 20;   // upper tower body
    ok = t.topH > 46;
  } else {
    lx = t.x + TOWER_W - 14; ly = t.botY + 20; // lower tower body
    ok = t.botY + 28 < GROUND_Y;
  }
  if (!ok) return;
  ctx.save();
  ctx.fillStyle = "#E8A54C";
  ctx.globalAlpha = a * 0.25; // soft glow
  ctx.beginPath(); ctx.arc(lx, ly, 6, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = a;        // the flame dot
  ctx.beginPath(); ctx.arc(lx, ly, 2.2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawTowers() {
  const now = performance.now();
  for (const t of game.towers) {
    if (t.x > W || t.x + TOWER_W < 0) continue;
    // Upper tower: body from the top edge down to the gap, crenellated cap
    // on its bottom (gap) end.
    drawTowerBody(t.x, 0, t.topH);
    drawTowerTeeth(t, t.topH, 1);
    // Lower tower: body from the gap down to the ground, crenellated cap on
    // its top (gap) end.
    drawTowerBody(t.x, t.botY, GROUND_Y);
    drawTowerTeeth(t, t.botY, -1);
    drawTowerLantern(t, now);
  }
}

function drawGround() {
  // L5: graveyard cobble tile at exactly SCROLL (1.0x), wrapping 64 px tile.
  drawWrapped(groundTile, GROUND_TILE_W, game.worldOffset % GROUND_TILE_W, GROUND_Y);
}

// Crow art (Phase 2). Three frames — 0 wing up, 1 wings level, 2 tucked
// down-back — share an identical body/anchor (CROW_W x CROW_H, origin at
// the sprite center) so only the wing silhouette sweeps. The bright green
// eye is the playability anchor; the #8F8A9E rim light on the top edge is
// what separates the dark body from the dark mid-sky.
function drawCrowBody(frame, dead) {
  const BODY = "#2B2B35";
  const RIM = "#8F8A9E";
  // Wing first, behind the body.
  ctx.fillStyle = BODY;
  ctx.beginPath();
  if (frame === 0) {
    // Wing up: sweeps up and back over the body.
    ctx.moveTo(0, -2);
    ctx.quadraticCurveTo(-6, -14, -15, -11);
    ctx.quadraticCurveTo(-8, -1, -1, 1);
  } else if (frame === 1) {
    // Wings level: flat back sweep.
    ctx.moveTo(0, -1);
    ctx.quadraticCurveTo(-10, -7, -15, -3);
    ctx.quadraticCurveTo(-9, 1, -1, 2);
  } else {
    // Tucked: folded down and back, smallest silhouette.
    ctx.moveTo(-2, 0);
    ctx.quadraticCurveTo(-11, 2, -13, 8);
    ctx.quadraticCurveTo(-7, 5, -1, 4);
  }
  ctx.closePath();
  ctx.fill();

  // Body + head (identical every frame).
  ctx.beginPath();
  ctx.ellipse(-1, 2, 11, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(8, -4, 6.5, 0, Math.PI * 2);
  ctx.fill();

  // Beak (open jaws on the death frame).
  if (dead) {
    ctx.beginPath();
    ctx.moveTo(12, -6.5); ctx.lineTo(15.5, -9); ctx.lineTo(13, -3);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(12, -3); ctx.lineTo(15.5, 0.5); ctx.lineTo(12.5, -1);
    ctx.closePath(); ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(13, -5.5); ctx.lineTo(16, -4); ctx.lineTo(13, -2);
    ctx.closePath(); ctx.fill();
  }

  // Rim light along the top edge (moonlight from above).
  ctx.strokeStyle = RIM;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.ellipse(8, -4, 6.5, 6.5, 0, -2.6, -0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(-1, 2, 11, 8, 0, -2.9, -0.9);
  ctx.stroke();

  // Eye.
  if (dead) {
    // X eye for the death frame.
    ctx.strokeStyle = "#E8E3D0";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, -6); ctx.lineTo(12, -2);
    ctx.moveTo(12, -6); ctx.lineTo(8, -2);
    ctx.stroke();
  } else {
    ctx.fillStyle = "#7CFC8B";
    ctx.shadowColor = "#7CFC8B";
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.arc(9.5, -4.5, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}

function drawCrow() {
  ctx.save();
  const c = game.crow;
  ctx.translate(CROW_X + CROW_W / 2, c.y + CROW_H / 2);
  ctx.rotate(c.rot);
  // DYING/GAME OVER render the death frame (X-eye + open beak) while the
  // existing 90-degree tumble rotation keeps applying from update().
  const dead = game.state === ST_DYING || game.state === ST_GAMEOVER;
  drawCrowBody(dead ? 2 : game.crowFrame, dead);
  ctx.restore();
}

function drawHUD() {
  if (game.state === ST_READY) {
    // "tap to flap" hint (Phase 4), gently pulsing.
    const a = 0.6 + 0.4 * Math.sin(performance.now() / 350);
    glowText("tap to flap", W / 2, 120, "bold 18px monospace", a);
    if (game.best > 0) glowText("best " + game.best, W / 2, 146, "12px monospace", 0.7);
  } else {
    glowText(String(game.score), W / 2, 56, "bold 24px monospace");
  }
}

function drawMuteIndicator() {
  // Small always-on mute state, top-left (M toggles).
  ctx.font = "10px monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = CrowAudio.isMuted() ? "#8F8A9E" : "rgba(255,255,255,0.35)";
  ctx.fillText(CrowAudio.isMuted() ? "MUTED (M)" : "SOUND (M)", 4, 12);
}

// ---- game-over panel (Phase 4) ------------------------------------------
// Dark stone slab: stone face #1C1633 over a moonlit edge #4A3F6B with
// crenellations and staggered mortar joints in #0E0A1C. Score + best glow
// eerie green. Appears only AFTER the crow has tumbled to the ground
// (the DYING state handles the fall).

function drawStonePanel(x, y, w, h) {
  ctx.fillStyle = "#4A3F6B"; // moonlit slab edge
  ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
  for (let cx = x - 3; cx < x + w; cx += 24) ctx.fillRect(cx, y - 9, 14, 6); // crenellations
  ctx.fillStyle = "#1C1633"; // stone face
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#0E0A1C"; // staggered mortar joints
  for (let r = 1, rowY = y + 26; rowY < y + h; r++, rowY += 26) {
    ctx.fillRect(x, rowY, w, 2);
    for (let mx = x + (r % 2 ? 30 : 0); mx < x + w; mx += 60) {
      ctx.fillRect(mx, rowY - 26, 2, 26);
    }
  }
}

// Medal tiers (Phase 4): 30+ corvid crown, 20+ raven feather, 10+ bone.
// Simple procedural icons in glowing green inside a medallion ring.
function drawMedal(score, cx, cy) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = GREEN;
  ctx.fillStyle = GREEN;
  ctx.lineWidth = 2;
  ctx.shadowColor = GREEN;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(0, 0, 20, 0, Math.PI * 2);
  ctx.stroke();
  if (score >= 30) {
    // Corvid crown: three-spike silhouette on a band.
    ctx.beginPath();
    ctx.moveTo(-9, 6); ctx.lineTo(-9, -3); ctx.lineTo(-4, 1); ctx.lineTo(0, -8);
    ctx.lineTo(4, 1); ctx.lineTo(9, -3); ctx.lineTo(9, 6);
    ctx.closePath();
    ctx.stroke();
  } else if (score >= 20) {
    // Raven feather: curved quill with barbs.
    ctx.beginPath();
    ctx.moveTo(-7, 8);
    ctx.quadraticCurveTo(2, 4, 8, -8);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const t = 0.3 + i * 0.2;
      const qx = -7 + t * 15, qy = 8 - t * 16;
      ctx.beginPath();
      ctx.moveTo(qx, qy);
      ctx.lineTo(qx + 5, qy - 1);
      ctx.stroke();
    }
  } else if (score >= 10) {
    // Bone: bar with four knob ends.
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-7, 0); ctx.lineTo(7, 0);
    ctx.stroke();
    for (const [bx, by] of [[-7, -3.5], [-7, 3.5], [7, -3.5], [7, 3.5]]) {
      ctx.beginPath();
      ctx.arc(bx, by, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function medalName(score) {
  if (score >= 30) return "Corvid Crown";
  if (score >= 20) return "Raven Feather";
  if (score >= 10) return "Bone";
  return null;
}

function drawGameOver() {
  if (game.state !== ST_GAMEOVER) return;
  ctx.fillStyle = "rgba(6,4,14,0.55)";
  ctx.fillRect(0, 0, W, H);

  const pw = 232, ph = 216, px = (W - pw) / 2, py = 108;
  drawStonePanel(px, py, pw, ph);

  ctx.fillStyle = "#E8E3D0";
  ctx.font = "bold 20px monospace";
  ctx.textAlign = "center";
  ctx.fillText("GAME OVER", W / 2, py + 32);

  drawMedal(game.score, W / 2, py + 82);
  const name = medalName(game.score);
  glowText(name ? name : "no medal (10+ for a bone)", W / 2, py + 118,
    "11px monospace", name ? 0.95 : 0.55);

  ctx.fillStyle = "rgba(232,227,208,0.6)";
  ctx.font = "10px monospace";
  ctx.textAlign = "center";
  ctx.fillText("SCORE", W / 2, py + 140);
  glowText(String(game.score), W / 2, py + 168, "bold 30px monospace");
  glowText("BEST " + game.best, W / 2, py + 194, "12px monospace", 0.85);

  // Restart hint: only starts pulsing once the 250 ms lockout has passed.
  const ready = performance.now() - game.gameOverAt >= RESTART_LOCKOUT;
  glowText(ready ? "tap / space to restart" : "...", W / 2, py + ph + 26,
    "12px monospace", ready ? 0.6 + 0.4 * Math.sin(performance.now() / 350) : 0.5);
}

function drawPauseOverlay() {
  ctx.fillStyle = "rgba(6,4,14,0.6)";
  ctx.fillRect(0, 0, W, H);
  glowText("PAUSED", W / 2, H / 2 - 8, "bold 24px monospace");
  ctx.fillStyle = "#8F8A9E";
  ctx.font = "12px monospace";
  ctx.textAlign = "center";
  ctx.fillText("refocus the window to resume", W / 2, H / 2 + 18);
}

function draw() {
  drawBackground();
  drawTowers();
  drawGround();
  drawCrow();
  drawHUD();
  drawMuteIndicator();
  drawGameOver();
  if (game.flash > 0) {
    ctx.fillStyle = "#B8C4D6"; // 1-frame cold death flash
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------------------------------------------------------------- pause
// Pause on window blur / hidden tab (Phase 4). While paused the fixed-step
// accumulator must NOT run: acc is zeroed every frame and dt is already
// clamped to MAX_FRAME, so there is no burst of updates on resume.

let paused = false;

function setPaused(p) {
  if (p === paused) return;
  paused = p;
  if (!paused) { last = performance.now(); acc = 0; }
}

window.addEventListener("blur", () => {
  if (game.state === ST_PLAYING || game.state === ST_READY) setPaused(true);
});
window.addEventListener("focus", () => setPaused(false));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (game.state === ST_PLAYING || game.state === ST_READY) setPaused(true);
  } else {
    setPaused(false);
  }
});

// ---------------------------------------------------------------- loop

let last = performance.now();
let acc = 0;

function frame(now) {
  let dt = now - last;
  last = now;
  if (dt > MAX_FRAME) dt = MAX_FRAME; // tab switch: don't spiral
  if (paused) {
    acc = 0; // paused: accumulator must not run (no backlog on resume)
  } else {
    acc += dt;
    while (acc >= STEP) {
      update();
      acc -= STEP;
    }
  }
  if (!paused) CrowAudio.tick(); // ambient scheduler (far caw) — frozen with the game
  draw();
  if (paused) drawPauseOverlay();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
