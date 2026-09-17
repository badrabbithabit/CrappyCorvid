/*
 * Crappy Corvid — Phase 3: procedural audio (all WebAudio, zero sample files).
 *
 * Design notes:
 * - Lazy init: the AudioContext is created/resumed on the first user
 *   gesture (keydown / pointerdown) via unlock(), per autoplay policies.
 * - Everything is synthesized: oscillators + a shared white-noise buffer
 *   run through biquad filters. No external audio of any kind.
 * - Buses: sfx (loud, punchy) and ambient (kept low, ~0.1, atmosphere).
 * - Mute: single master-gain gate, persisted in localStorage (guarded).
 * - Fails safe: if WebAudio is unavailable every call is a silent no-op.
 * - Lightning/thunder: the game has no lightning flash hook yet (Phase 2
 *   visuals not in), so thunder is scheduled randomly by the ambient
 *   system only — same cadence the flash will use later.
 */
"use strict";

const CrowAudio = (() => {
  const MUTE_KEY = "crappycorvid.muted";
  const rand = (a, b) => a + Math.random() * (b - a);

  let ac = null;            // AudioContext, created lazily
  let master = null;        // mute gate
  let sfx = null;           // SFX bus
  let amb = null;           // ambient bus (~0.1)
  let noiseBuf = null;      // shared 2 s white-noise buffer
  let nextThunder = 0;      // ctx.currentTime when the next roll happens
  let nextCaw = 0;
  let supported = !!(typeof window !== "undefined" &&
    (window.AudioContext || window.webkitAudioContext));

  let muted = readMuted();

  function readMuted() {
    try { return localStorage.getItem(MUTE_KEY) === "1"; } catch (e) { return false; }
  }
  function writeMuted() {
    try { localStorage.setItem(MUTE_KEY, muted ? "1" : "0"); } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------ lifecycle

  function unlock() {
    if (!supported) return;
    try {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        ac = new AC();

        master = ac.createGain();
        master.gain.value = muted ? 0 : 1;
        master.connect(ac.destination);

        sfx = ac.createGain();
        sfx.gain.value = 0.9;
        sfx.connect(master);

        amb = ac.createGain();
        amb.gain.value = 0.1; // atmosphere, not noise
        amb.connect(master);

        // Shared white-noise buffer (all noise sources reuse this).
        noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

        nextThunder = ac.currentTime + rand(6, 15);   // first one a bit sooner
        nextCaw = ac.currentTime + rand(15, 30);
        startWind();
      }
      if (ac.state === "suspended") ac.resume();
    } catch (e) {
      ac = null; // WebAudio blew up: stay silent forever after
    }
  }

  // ------------------------------------------------------------ primitives

  // Oscillator tone with exponential decay. f1 optional (pitch sweep).
  function tone(o) {
    const t = o.when !== undefined ? o.when : ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1 && o.f1 !== o.f0) osc.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), t + o.dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g);
    g.connect(o.bus || sfx);
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  // Filtered noise burst with exponential decay. f1 optional (filter sweep).
  function noise(o) {
    const t = o.when !== undefined ? o.when : ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ac.createBiquadFilter();
    f.type = o.type || "bandpass";
    f.Q.value = o.q || 1;
    f.frequency.setValueAtTime(o.f0, t);
    if (o.f1 && o.f1 !== o.f0) f.frequency.exponentialRampToValueAtTime(Math.max(o.f1, 1), t + o.dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f);
    f.connect(g);
    g.connect(o.bus || sfx);
    src.start(t);
    src.stop(t + o.dur + 0.05);
  }

  // ------------------------------------------------------------ SFX

  // Wing swish: bandpassed noise burst sweeping up — a soft "fwip".
  function flap() {
    if (!ac) return;
    noise({ type: "bandpass", f0: 700, f1: 1500, q: 1.2, gain: 0.35, dur: 0.09 });
  }

  // Bone chime: two quick high sine hits, the second slightly detuned up.
  // (Deliberately NOT a coin bling — no square waves, no bright third.)
  function score() {
    if (!ac) return;
    const t = ac.currentTime;
    tone({ f0: 1174, dur: 0.10, gain: 0.30, when: t });
    tone({ f0: 1220, dur: 0.22, gain: 0.28, when: t + 0.07 }); // +~40 cents
    noise({ type: "highpass", f0: 4000, q: 0.7, gain: 0.10, dur: 0.03, when: t }); // bone "tick"
  }

  // Stone thud: low sine drop + muffled noise, then a short discordant sting
  // (two sines a minor second apart).
  function hit() {
    if (!ac) return;
    const t = ac.currentTime;
    tone({ f0: 110, f1: 40, dur: 0.18, gain: 0.8, when: t });
    noise({ type: "lowpass", f0: 160, q: 0.8, gain: 0.5, dur: 0.12, when: t });
    tone({ f0: 329.6, dur: 0.35, gain: 0.16, when: t + 0.04 }); // E4
    tone({ f0: 349.2, dur: 0.35, gain: 0.16, when: t + 0.04 }); // F4 — dissonant
  }

  // Death: descending fall whistle + a rough caw burst (two fast bandpass
  // noise chirps) layered under it.
  function die() {
    if (!ac) return;
    const t = ac.currentTime;
    tone({ f0: 750, f1: 90, dur: 0.9, gain: 0.30, when: t });
    noise({ type: "bandpass", f0: 1100, f1: 600, q: 4, gain: 0.45, dur: 0.16, when: t + 0.05 });
    noise({ type: "bandpass", f0: 950, f1: 550, q: 4, gain: 0.30, dur: 0.14, when: t + 0.18 });
  }

  // ------------------------------------------------------------ ambient

  // Endless quiet wind: looped noise -> lowpass with slow LFOs on filter
  // freq and gain. Started once on unlock.
  function startWind() {
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 280;
    lp.Q.value = 0.6;
    const g = ac.createGain();
    g.gain.value = 0.5;

    const lfo1 = ac.createOscillator();   // slow gusts on the filter
    lfo1.frequency.value = 0.11;
    const lfo1Amt = ac.createGain();
    lfo1Amt.gain.value = 140;
    lfo1.connect(lfo1Amt);
    lfo1Amt.connect(lp.frequency);

    const lfo2 = ac.createOscillator();   // even slower on the level
    lfo2.frequency.value = 0.07;
    const lfo2Amt = ac.createGain();
    lfo2Amt.gain.value = 0.25;
    lfo2.connect(lfo2Amt);
    lfo2Amt.connect(g.gain);

    src.connect(lp);
    lp.connect(g);
    g.connect(amb);
    src.start();
    lfo1.start();
    lfo2.start();
  }

  // Distant thunder: slow-rising rumble (lowpassed noise + sub sine),
  // long decay. Routed via the quiet ambient bus.
  function thunder() {
    if (!ac) return;
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const lp = ac.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 90;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.9, t + 1.4);    // slow roll-in
    g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5); // long tail
    src.connect(lp);
    lp.connect(g);
    g.connect(amb);
    src.start(t);
    src.stop(t + 4.6);
    tone({ f0: 45, f1: 28, dur: 3.5, gain: 0.30, when: t + 0.3, bus: amb });
  }

  // Rare far caw: quiet, quick, two small chirps. Ambient bus.
  function farCaw() {
    if (!ac) return;
    const t = ac.currentTime;
    noise({ type: "bandpass", f0: 1200, f1: 800, q: 6, gain: 0.22, dur: 0.15, when: t, bus: amb });
    noise({ type: "bandpass", f0: 1050, f1: 700, q: 6, gain: 0.16, dur: 0.13, when: t + 0.14, bus: amb });
  }

  // Ambient scheduler — call once per frame from the game loop.
  function tick() {
    if (!ac || ac.state !== "running") return;
    const now = ac.currentTime;
    if (now >= nextThunder) { thunder(); nextThunder = now + rand(20, 40); }
    if (now >= nextCaw) { farCaw(); nextCaw = now + rand(15, 30); }
  }

  // ------------------------------------------------------------ mute

  function toggleMute() {
    muted = !muted;
    writeMuted();
    if (ac) {
      try {
        const now = ac.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(muted ? 0 : 1, now, 0.02);
      } catch (e) { master.gain.value = muted ? 0 : 1; }
    }
    return muted;
  }

  function isMuted() {
    return muted;
  }

  return { unlock, tick, flap, score, hit, die, toggleMute, isMuted };
})();
