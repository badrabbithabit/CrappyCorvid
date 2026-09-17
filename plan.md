# Crappy Corvid — Dark Flappy Bird Clone

A crow flies between castle towers through a foggy graveyard night.
Gravity + one flap impulse. +1 per tower passed. Brutally simple, dark, spooky.

## Research notes (verified)

### Physics (60 fps, 288×512 logical canvas — verified against 2 faithful clones)
- Gravity: **0.25 px/f²**
- Flap: **sets** vy = **−4.6** (never adds — double-tap ceiling launch is the #1 clone bug)
- Terminal fall: clamp vy ≈ 10–12 px/f
- Rotation: −30° rising, +35→90° falling, 90° death tumble
- Tower width: 52 px; gap: 90 px; scroll: 2–3 px/f; spawn spacing: ~180–200 px
- Gap center: uniform random with safe margins (e.g. 200 px from top to height−100); clamp so caps stay on-screen
- Original had ZERO difficulty scaling; clone softening: first 3–5 pipes +25% gap, optional

### States & feel
- READY (bobbing crow; first tap starts world) → PLAYING → GAME OVER (panel; tap to restart with 250 ms input lockout)
- Score +1 on pipe-pass trigger (NOT frame counters — known clone bug)
- Best score in localStorage
- Death: 1-frame cold flash (`#B8C4D6`), crow tumbles to ground, then game-over panel
- First tower spawns off-screen right after first flap (~1.5–2 s grace at 2–3 px/f)

### Implementation rules
- Fixed 60 Hz timestep (accumulator), clamp dt (tab-switch spiral-of-death)
- Collision: AABB, crow hitbox inset ~15% of sprite (this is what makes it feel fair)
- Physics/pipes must NOT update before the first flap (READY gate)
- All bird-adjacent layers (towers, ground) scroll at exactly the same speed

## Theme (dark/spooky)

### Palette
- Sky gradient: `#0B0714` (top) → `#1A1030` → `#2D1B4E` (horizon)
- Moon: disc `#E8E3D0`, halo `#C9C4B8` low alpha
- Distant silhouettes: `#151027` (far) / `#0E0A1C` (near) — always darker than sky behind
- Stone/towers: fill `#1C1633`, moonlit edge `#4A3F6B`, mortar lines `#0E0A1C`
- Accent (score, UI): eerie green `#7CFC8B` (glow via shadowBlur); death flash `#B8C4D6`
- **Readability rule:** crow body `#2B2B35`, rim light `#8F8A9E`, green eye dot `#7CFC8B` (the eye is the playability anchor). ≥4:1 contrast between crow and mid-sky. Pure black-on-black is forbidden.

### Parallax (base scroll 2 px/f)
- L1 sky gradient + moon + stars: 0.1× (moon drift 0.2×)
- L2 far castle skyline silhouette: 0.5×
- L3 near battlements/dead trees: 1× (same as towers)
- L4 fog bands: two offset strips 0.7–0.8× scrolling opposite directions, α ≤ 0.25, never cover the gap
- L5 graveyard ground tile: 1× (matches towers exactly)

### Crow animation (3 frames)
- Frames: wing up / level / tucked down; identical body size + anchor point every frame
- Cycle ~every 10 frames while rising; hold tuck while falling; X-eyes + open beak + fast fixed-rotation tumble on death
- Silhouette changes must be large (full wing sweep)

### Mood touches (playability-safe)
- Flickering lanterns: far layer only, 1-frame brightness pulse
- 2–3 tiny slow bats in L2, non-interactive
- Lightning: full-screen flash max every 15–25 s, 2–4 frames, paired with thunder SFX; never in first 10 s of a run
- All effects stay out of the gap corridor and never follow input

### Audio (all procedural WebAudio — no external files)
- SFX: wing swish (flap), bone-chime (score), stone thud + discordant sting (hit), caw + fall whistle (die)
- Ambient: low-passed quiet loops — wind, distant thunder, rare far caw

## Phases

## [x] Phase 1 — Core engine (playable, ugly)
- [x] Scaffold: index.html + main.js (+ game files), no framework, GitHub Pages–ready (relative paths)
- [x] 288×512 logical canvas scaled to window, fixed 60 Hz timestep
- [x] Physics: gravity 0.25, flap sets vy −4.6, terminal clamp, rotation sell
- [x] Towers: 52 px wide, 90 px gap, 2–3 px/f, ~180–200 px spacing, random gap with margins
- [x] States READY/PLAYING/GAME OVER, first-flap gate, 250 ms restart lockout
- [x] AABB collision with 15% inset hitbox, pipe-pass scoring, best score in localStorage
- [x] Keyboard (space) + pointer input; crude placeholder graphics only

## [ ] Phase 2 — Theme
- [ ] Palette applied: sky gradient, moon, stars
- [ ] 5-layer parallax: skyline 0.5×, battlements 1×, fog strips 0.75×, ground 1×
- [ ] Castle tower sprites (procedural: stone fill, moonlit edge, crenellations, occasional flickering lantern)
- [ ] Crow: 3-frame path-drawn animation, rim light + green eye dot, death tumble
- [ ] Graveyard ground tile
- [ ] Bats (2–3, L2), lightning flash (15–25 s cadence, 2–4 frames, not in first 10 s)
- [ ] Contrast check: crow readable at all gap positions

## [x] Phase 3 — Audio (procedural WebAudio)
- [x] Flap swish, score chime (bone-like), hit thud + sting, die whistle
- [x] Ambient: wind loop, distant thunder, rare caw (low-passed, quiet)
- [x] Mute toggle (M key + UI), resume AudioContext on first user gesture

## [x] Phase 4 — Polish
- [x] Death flash `#B8C4D6` (1 frame), crow tumbles to ground before panel
- [x] Game-over panel with medal tiers (10/20/30) in eerie green, best score
- [x] Pause on window blur
- [x] First-3-pipes grace gap (+25%)
- [x] Mobile touch works (unified pointer events)
- [x] No console errors, playtest pass

## [ ] Phase 5 — Ship
- [ ] git init + commits per phase
- [ ] Private GitHub repo `crappycorvid` (gh CLI), push
- [ ] GitHub Pages enabled on branch, site named crappycorvid
- [ ] README.md with how to run and controls
- [ ] All phase boxes in plan.md ticked
