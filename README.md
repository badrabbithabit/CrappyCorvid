# Crappy Corvid

A dark, spooky little homage to the flappy-bird genre. You are a lone corvid
beating its wings through a graveyard night — thread the gaps between the
castle towers, don't touch the stone, and see how far one small black bird
can carry itself before it comes down.

One button. No mercy.

**Fan-made project. Not affiliated with or endorsed by 2205Games.**

## How to run

No build step, no dependencies — it's plain HTML/CSS/JS.

- **Easiest:** open `index.html` in any modern browser (double-click it).
- **Local server (optional):** `npx serve .` or `python -m http.server`, then
  visit the printed URL.
- **GitHub Pages:** push the repo, enable Pages in the repo settings, and the
  site works as-is (all assets are relative paths).

Works on desktop and mobile. Touch, mouse, and keyboard all do the same thing.

## Controls

| Input | Action |
| --- | --- |
| **Space** / **click** / **tap** | Flap (in READY it starts the run) |
| **Space** / **click** / **tap** on the game-over panel | Restart (after a 250 ms lockout) |
| **M** | Toggle sound |

The game pauses automatically when the window loses focus and resumes when it
regains it.

## Scoring & medals

One point per tower passed. Best score is saved locally (localStorage) and
shown on the game-over panel, along with a medal tier:

| Score | Medal |
| --- | --- |
| 10+ | Bone |
| 20+ | Raven Feather |
| 30+ | Corvid Crown |

The first three towers of every run get a 25% wider gap — a small grace
period before the night gets serious.

## Project layout

```
index.html      page shell, canvas, CSS
js/main.js      engine: fixed-step loop, physics, state machine, rendering
js/audio.js     procedural WebAudio: SFX (flap/score/hit/death) + ambient bed
plan.md         design plan and phase checklist
```

## Credits

- Code, art (all procedural — no image assets), and audio (all synthesized —
  no audio assets): this repository.
- Inspired by the flappy-bird genre; the name is an affectionate nod to it.

> **Hosting note:** GitHub Pages is disabled for this repo because the GitHub account plan does not allow Pages on *private* repos. Making the repo public + enabling Pages (branch `master`) serves it at `badrabbithabit.github.io/CrappyCorvid/`. Until then, just open `index.html`.
