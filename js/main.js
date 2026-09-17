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
  game.runTowers = 0; // grace gap restarts every run
  game.readyT = 0;
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

  const c = game.crow;
  switch (game.state) {
    case ST_READY: {
      // Ground creeps in READY for a live feel (same speed as towers).
      game.groundOffset = (game.groundOffset + SCROLL) % 64;
      // Bobbing crow, no physics/pipe updates (first-flap gate).
      game.readyT++;
      c.y = H * 0.42 + Math.sin(game.readyT / 10) * 8;
      c.rot = 0;
      break;
    }

    case ST_PLAYING: {
      // Ground scrolls at exactly SCROLL px/f — same as the towers.
      game.groundOffset = (game.groundOffset + SCROLL) % 64;
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
  onInput();
});

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
  CrowAudio.tick(); // ambient scheduler (thunder / far caw)
  draw();
  if (paused) drawPauseOverlay();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
