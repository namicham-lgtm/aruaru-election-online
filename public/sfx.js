"use strict";
/**
 * あるある選挙 効果音（Web Audio API 合成 / 音源ファイル不使用）
 *
 * - AudioContext はシングルトン。初回のユーザー操作(click/keydown)で resume。
 * - master gain 0.3 で控えめに統一。
 * - ミュート状態は localStorage("aru_muted") に保存。window.SFX.setMuted/isMuted。
 * - prefers-reduced-motion とは独立（音はミュートボタンのみで制御）。
 */
(function () {
  let ctx = null;
  let master = null;
  let muted = localStorage.getItem("aru_muted") === "1";

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.3;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // 初回ユーザー操作で resume（自動再生制限の解除）
  const unlock = () => { ensureCtx(); };
  window.addEventListener("click", unlock, { once: false });
  window.addEventListener("keydown", unlock, { once: false });

  // 共通: 単発オシレータ音
  function tone(freq, t0, dur, { type = "sine", gain = 0.5, attack = 0.005, release = 0.08 } = {}) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.setValueAtTime(gain, t0 + Math.max(attack, dur - release));
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // 共通: ノイズバースト（バッファ生成）
  function noise(t0, dur, { gain = 0.4, lp = 4000 } = {}) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = lp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  function ready() {
    if (muted) return null;
    return ensureCtx();
  }

  const SFX = {
    isMuted: () => muted,
    setMuted(m) {
      muted = !!m;
      localStorage.setItem("aru_muted", muted ? "1" : "0");
    },
    // 投函音: 短いノイズバースト＋下降サイン波（ヒュッ→ポン）約0.2s
    throw() {
      if (!ready()) return;
      const t = ctx.currentTime;
      noise(t, 0.08, { gain: 0.25, lp: 3000 });
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(720, t + 0.04);
      osc.frequency.exponentialRampToValueAtTime(240, t + 0.2);
      g.gain.setValueAtTime(0.0001, t + 0.04);
      g.gain.linearRampToValueAtTime(0.5, t + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
      osc.connect(g).connect(master);
      osc.start(t + 0.04);
      osc.stop(t + 0.24);
    },
    // タップ音: 短いブリップ square 880→660Hz 約0.06s
    tap() {
      if (!ready()) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "square";
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(660, t + 0.06);
      g.gain.setValueAtTime(0.15, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.08);
    },
    // 選択トグル音: sine C5 単音 約0.09s
    select() {
      if (!ready()) return;
      const t = ctx.currentTime;
      tone(523.25, t, 0.09, { type: "sine", gain: 0.18, release: 0.05 });
    },
    // 当確スタンプ音: 短い低音ドン（180→70Hz）＋アタックのクリック 約0.12s
    stamp() {
      if (!ready()) return;
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(180, t);
      osc.frequency.exponentialRampToValueAtTime(70, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.6, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(g).connect(master);
      osc.start(t);
      osc.stop(t + 0.14);
      noise(t, 0.03, { gain: 0.25, lp: 2000 }); // 押下のクリック
    },
    // 投票確定: 明るい2音チャイム E5→A5 約0.3s
    vote() {
      if (!ready()) return;
      const t = ctx.currentTime;
      tone(659.25, t, 0.16, { type: "triangle", gain: 0.45 });        // E5
      tone(880.0, t + 0.12, 0.2, { type: "triangle", gain: 0.45 });   // A5
    },
    // フェーズ遷移: 柔らかい単音チャイム
    phase() {
      if (!ready()) return;
      const t = ctx.currentTime;
      tone(587.33, t, 0.32, { type: "sine", gain: 0.4, release: 0.22 }); // D5
    },
    // 開票前ドラムロール: 約1.2sの低音ロール（ノイズ＋減衰の連打）
    drumroll() {
      if (!ready()) return;
      const t = ctx.currentTime;
      const hits = 24;
      for (let i = 0; i < hits; i++) {
        const ti = t + i * (1.2 / hits);
        const g = 0.12 + (i / hits) * 0.2; // 徐々に高揚
        noise(ti, 0.05, { gain: g, lp: 1200 });
        tone(110, ti, 0.05, { type: "sine", gain: g * 0.6 });
      }
    },
    // 当選ファンファーレ: メジャーアルペジオ＋シマー 約1.5s
    fanfare() {
      if (!ready()) return;
      const t = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
      notes.forEach((f, i) => {
        tone(f, t + i * 0.12, 0.5, { type: "triangle", gain: 0.4, release: 0.3 });
      });
      // 最後の和音＋シマー
      const ch = t + notes.length * 0.12;
      [523.25, 659.25, 783.99].forEach((f) =>
        tone(f, ch, 0.7, { type: "sine", gain: 0.28, release: 0.5 })
      );
      // シマー（高音の揺らぎ）
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const lfo = ctx.createOscillator();
      const lfoG = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 2093; // C7
      lfo.frequency.value = 8;
      lfoG.gain.value = 40;
      lfo.connect(lfoG).connect(osc.frequency);
      g.gain.setValueAtTime(0.0001, ch);
      g.gain.linearRampToValueAtTime(0.12, ch + 0.1);
      g.gain.exponentialRampToValueAtTime(0.0001, ch + 0.8);
      osc.connect(g).connect(master);
      lfo.start(ch);
      osc.start(ch);
      osc.stop(ch + 0.85);
      lfo.stop(ch + 0.85);
    },
  };

  window.SFX = SFX;
})();
