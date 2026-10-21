(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TACGModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_CFG = { E: 24, T: 12, slot: 64, hand: 64, set: 32, loc: 24, s1: 256, s2: 256, act: 128, head: 256 };

  /* Every learned tensor: [name, shape, init kind]. Order is the storage order in weights.bin. */
  function specFor(L, cfg) {
    const cv = cfg.E + L.S, dinSlot = cv + cfg.E + L.D_SLOT, dinHand = cv + L.D_HAND;
    const stateIn = L.BOARD * cfg.slot + cfg.hand + L.SETS * cfg.set + 2 * cfg.loc + L.NS + cfg.T;
    const actIn = L.NTYPES + 3 * cv + cfg.T + L.NA;
    return [
      ['EMB', [L.NC, cfg.E], 'emb'], ['TXT', [L.TXT_N, cfg.T], 'emb'],
      ['Wslot', [dinSlot, cfg.slot], 'w'], ['bslot', [cfg.slot], 'b'],
      ['Whand', [dinHand, cfg.hand], 'w'], ['bhand', [cfg.hand], 'b'],
      ['Wset', [L.SETS, cv, cfg.set], 'w'], ['bset', [L.SETS, cfg.set], 'b'],
      ['Wloc', [cv, cfg.loc], 'w'], ['bloc', [cfg.loc], 'b'],
      ['W1', [stateIn, cfg.s1], 'w'], ['b1', [cfg.s1], 'b'],
      ['W2', [cfg.s1, cfg.s2], 'w'], ['b2', [cfg.s2], 'b'],
      ['Wa1', [actIn, cfg.act], 'w'], ['ba1', [cfg.act], 'b'],
      ['Wa2', [cfg.act, cfg.act], 'w'], ['ba2', [cfg.act], 'b'],
      ['Wp', [cfg.s2, cfg.act], 'w'], ['bp', [cfg.act], 'b'],
      ['Wh1s', [cfg.s2, cfg.head], 'w'], ['Wh1a', [cfg.act, cfg.head], 'w'], ['Wh1i', [cfg.act, cfg.head], 'w'], ['bh1', [cfg.head], 'b'],
      ['Wh2', [cfg.head, 1], 'out'], ['bh2', [1], 'b'],
    ];
  }

  const size = shape => shape.reduce((a, b) => a * b, 1);
  const fanIn = shape => (shape.length === 3 ? shape[1] : shape[0]);

  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16);
  }

  /* What the network structurally depends on, apart from the card table: weights with a different key are refused. Cards and static features
     may change (the model is then migrated, see migrate.js); these may not. */
  const LAYOUT_KEYS = ['FEATURE_VERSION', 'BOARD', 'EQ', 'HAND', 'SETS', 'TXT_N', 'D_SLOT', 'D_HAND', 'NS', 'NA', 'NAI', 'NTYPES', 'MULL_MAX'];
  const layoutKey = (L, cfg) => fnv(JSON.stringify([LAYOUT_KEYS.map(k => L[k]), cfg]));

  /* 'ok': the weights were trained with exactly this card table. 'migrate': same network, different cards/features. Anything else throws. */
  function compatibility(manifest, L, meta) {
    if (manifest.layoutKey !== layoutKey(L, manifest.cfg)) throw new Error('These weights were trained with a different network or feature layout (feature code changed). They cannot be reused; train a new model.');
    return manifest.metaHash === meta.hash ? 'ok' : 'migrate';
  }

  function rngFrom(seed) {
    let a = seed >>> 0;
    const uniform = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
  }

  function initParams(L, cfg, seed = 1) {
    const normal = rngFrom(seed), params = {};
    for (const [name, shape, kind] of specFor(L, cfg)) {
      const a = new Float32Array(size(shape));
      const std = kind === 'w' ? Math.sqrt(2 / fanIn(shape)) : kind === 'out' ? 0.01 : kind === 'emb' ? 0.1 : 0;
      if (std) for (let i = 0; i < a.length; i++) a[i] = normal() * std;
      params[name] = a;
    }
    return params;
  }

  function pack(L, cfg, params, meta, extra) {
    const spec = specFor(L, cfg), total = spec.reduce((n, s) => n + size(s[1]), 0), buf = new Float32Array(total), tensors = [];
    let off = 0;
    for (const [name, shape] of spec) { buf.set(params[name], off); tensors.push({ name, shape, offset: off }); off += size(shape); }
    const identity = { layoutKey: layoutKey(L, cfg), metaHash: meta.hash, cards: meta.keys, featureNames: meta.featureNames };
    return { buffer: buf.buffer, manifest: Object.assign({ version: 2, cfg, tensors }, identity, extra) };
  }

  function unpack(manifest, buffer) {
    const all = new Float32Array(buffer), params = {};
    for (const t of manifest.tensors) params[t.name] = all.subarray(t.offset, t.offset + size(t.shape));
    return params;
  }

  /* Plain-JS inference: Q-values for every legal action of one state. No dependencies, so it runs identically in workers and in the browser. */
  function createForward(L, cfg, meta, params) {
    const { E, T: TD } = cfg, S = L.S, cv = E + S, P = params;
    const STATIC = new Float32Array(L.NC * S);
    meta.static.forEach((row, i) => STATIC.set(row, i * S));
    const dinSlot = cv + E + L.D_SLOT, dinHand = cv + L.D_HAND;
    const stateIn = L.BOARD * cfg.slot + cfg.hand + L.SETS * cfg.set + 2 * cfg.loc + L.NS + TD;
    const actIn = L.NTYPES + 3 * cv + TD + L.NA;

    const xSlot = new Float32Array(dinSlot), xHand = new Float32Array(dinHand), xSet = new Float32Array(cv), xLoc = new Float32Array(cv);
    const sIn = new Float32Array(stateIn), h1 = new Float32Array(cfg.s1), hS = new Float32Array(cfg.s2), gate = new Float32Array(cfg.act);
    const zS = new Float32Array(cfg.head), aIn = new Float32Array(actIn), hA1 = new Float32Array(cfg.act), hA = new Float32Array(cfg.act), z = new Float32Array(cfg.head);
    /* mix = Wh1a + gate * Wh1i depends only on the state, so it is built once per decision rather than once per action */
    const mix = new Float32Array(cfg.act * cfg.head), emptySlot = new Float32Array(cfg.slot);
    let emptyReady = false;
    const hHand = new Float32Array(cfg.hand);

    const card = (buf, off, idx) => { buf.set(P.EMB.subarray(idx * E, idx * E + E), off); buf.set(STATIC.subarray(idx * S, idx * S + S), off + E); };
    /* out[oo..oo+nOut) = relu?(bias + x[xo..xo+nIn) . W) */
    function dense(out, oo, x, xo, nIn, W, wo, nOut, bias, bo, relu) {
      for (let j = 0; j < nOut; j++) out[oo + j] = bias ? bias[bo + j] : 0;
      for (let i = 0; i < nIn; i++) {
        const v = x[xo + i]; if (v === 0) continue;
        const r = wo + i * nOut;
        for (let j = 0; j < nOut; j++) out[oo + j] += v * W[r + j];
      }
      if (relu) for (let j = 0; j < nOut; j++) if (out[oo + j] < 0) out[oo + j] = 0;
    }

    function encodeState(si, sf) {
      let o = 0;
      for (let s = 0; s < L.BOARD; s++) {
        /* every empty tile produces the same output, so it is computed once */
        const empty = !si[L.I_SLOT + s] && sf[L.F_SLOT + s * L.D_SLOT] === 0;
        if (empty && emptyReady) { sIn.set(emptySlot, o); o += cfg.slot; continue; }
        card(xSlot, 0, si[L.I_SLOT + s]);
        for (let k = 0; k < E; k++) xSlot[cv + k] = 0;
        for (let q = 0; q < L.EQ; q++) { const e = si[L.I_EQ + s * L.EQ + q]; for (let k = 0; k < E; k++) xSlot[cv + k] += P.EMB[e * E + k]; }
        for (let k = 0; k < L.D_SLOT; k++) xSlot[cv + E + k] = sf[L.F_SLOT + s * L.D_SLOT + k];
        dense(sIn, o, xSlot, 0, dinSlot, P.Wslot, 0, cfg.slot, P.bslot, 0, true);
        if (empty) { emptySlot.set(sIn.subarray(o, o + cfg.slot)); emptyReady = true; }
        o += cfg.slot;
      }
      sIn.fill(0, o, o + cfg.hand);
      for (let h = 0; h < L.HAND; h++) {
        const idx = si[L.I_HAND + h]; if (!idx) continue;
        card(xHand, 0, idx);
        for (let k = 0; k < L.D_HAND; k++) xHand[cv + k] = sf[L.F_HAND + h * L.D_HAND + k];
        dense(hHand, 0, xHand, 0, dinHand, P.Whand, 0, cfg.hand, P.bhand, 0, true);
        for (let j = 0; j < cfg.hand; j++) sIn[o + j] += hHand[j];
      }
      o += cfg.hand;
      for (let set = 0; set < L.SETS; set++) {
        xSet.fill(0); let n = 0;
        for (let w = 0; w < L.W; w++) {
          let bits = si[L.I_SETS + set * L.W + w];
          while (bits) {
            const low = bits & -bits, idx = w * 32 + (31 - Math.clz32(low));
            bits ^= low; n++;
            for (let k = 0; k < E; k++) xSet[k] += P.EMB[idx * E + k];
            for (let k = 0; k < S; k++) xSet[E + k] += STATIC[idx * S + k];
          }
        }
        if (n) for (let k = 0; k < cv; k++) xSet[k] /= n;
        dense(sIn, o, xSet, 0, cv, P.Wset, set * cv * cfg.set, cfg.set, P.bset, set * cfg.set, true); o += cfg.set;
      }
      for (let l = 0; l < 2; l++) { card(xLoc, 0, si[L.I_LOC + l]); dense(sIn, o, xLoc, 0, cv, P.Wloc, 0, cfg.loc, P.bloc, 0, true); o += cfg.loc; }
      for (let k = 0; k < L.NS; k++) sIn[o + k] = sf[L.F_SCAL + k];
      o += L.NS;
      const title = si[L.I_TITLE];
      for (let k = 0; k < TD; k++) sIn[o + k] = P.TXT[title * TD + k];
      dense(h1, 0, sIn, 0, stateIn, P.W1, 0, cfg.s1, P.b1, 0, true);
      dense(hS, 0, h1, 0, cfg.s1, P.W2, 0, cfg.s2, P.b2, 0, true);
      dense(gate, 0, hS, 0, cfg.s2, P.Wp, 0, cfg.act, P.bp, 0, true);
      dense(zS, 0, hS, 0, cfg.s2, P.Wh1s, 0, cfg.head, P.bh1, 0, false);
      for (let i = 0; i < cfg.act; i++) { const g = gate[i], r = i * cfg.head; for (let j = 0; j < cfg.head; j++) mix[r + j] = P.Wh1a[r + j] + g * P.Wh1i[r + j]; }
    }

    function qRow(ai, af, r) {
      const io = r * L.NAI, fo = r * L.NA;
      aIn.fill(0);
      aIn[ai[io]] = 1;
      let o = L.NTYPES;
      card(aIn, o, ai[io + 1]); o += cv;
      card(aIn, o, ai[io + 2]); o += cv;
      let n = 0;
      for (let k = 0; k < L.MULL_MAX; k++) {
        const idx = ai[io + 4 + k]; if (!idx) continue;
        n++;
        for (let j = 0; j < E; j++) aIn[o + j] += P.EMB[idx * E + j];
        for (let j = 0; j < S; j++) aIn[o + E + j] += STATIC[idx * S + j];
      }
      if (n) for (let j = 0; j < cv; j++) aIn[o + j] /= n;
      o += cv;
      const txt = ai[io + 3];
      for (let k = 0; k < TD; k++) aIn[o + k] = P.TXT[txt * TD + k];
      o += TD;
      for (let k = 0; k < L.NA; k++) aIn[o + k] = af[fo + k];
      dense(hA1, 0, aIn, 0, actIn, P.Wa1, 0, cfg.act, P.ba1, 0, true);
      dense(hA, 0, hA1, 0, cfg.act, P.Wa2, 0, cfg.act, P.ba2, 0, true);
      for (let j = 0; j < cfg.head; j++) z[j] = zS[j];
      for (let i = 0; i < cfg.act; i++) {
        const a = hA[i];
        if (a === 0) continue;
        const r1 = i * cfg.head;
        for (let j = 0; j < cfg.head; j++) z[j] += a * mix[r1 + j];
      }
      let q = P.bh2[0];
      for (let j = 0; j < cfg.head; j++) if (z[j] > 0) q += z[j] * P.Wh2[j];
      return q;
    }

    return {
      q(state, actions, n) {
        encodeState(state.i, state.f);
        const out = new Float32Array(n);
        for (let r = 0; r < n; r++) out[r] = qRow(actions.i, actions.f, r);
        return out;
      },
    };
  }

  return { DEFAULT_CFG, specFor, layoutKey, compatibility, initParams, pack, unpack, createForward, size };
});
