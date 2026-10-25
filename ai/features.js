(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TACGFeatures = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FRONT = 4, BACK = 2, BOARD = 2 * (FRONT + BACK), EQ = 3, HAND = 12, SETS = 6, TXT_N = 128, MULL_MAX = 5, NUM_CHOICES = 12;
  const FEATURE_VERSION = 3;   // bump whenever the meaning of any feature changes, so old weights are refused instead of misread
  const SET_BUCKETS = 32, N_SCALARS = 32;
  const TILE_BLOCKED = /cannot play a card on that tile/i;   // the server's refusal text for a tile an enemy effect blocks
  const DEFAULT_MAX_HP = 20;   // engine.js START_HP: the HP cap (and starting HP) when a room does not say otherwise (test/hp_rule.js checks it)
  const D_SLOT = 18, D_HAND = 6, NS = N_SCALARS + SET_BUCKETS, NA = 29, NAI = 9;
  const T = { END: 0, PLAY: 1, ATTACK: 2, MANUAL: 3, ACTIVE: 4, LOCATION: 5, MULLIGAN: 6, PCARD: 7, PCHOICE: 8, PDONE: 9, PNUM: 10, START: 11 };
  const NTYPES = 12;
  const RANGE = { Short: 0, Medium: 1, Long: 2 };

  function txtBucket(s) {
    s = String(s == null ? '' : s).toLowerCase().replace(/\d+/g, '#').trim();
    if (!s) return 0;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 1 + (h % (TXT_N - 1));
  }

  function hash32(s, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  }

  /* HP a hit does to the player (an estimate: effects the view does not show can still change it) */
  function damageToPlayer(view, id) {
    const st = (view.stats && view.stats[id]) || {}, a = typeof st.a === 'number' && isFinite(st.a) ? st.a : 0, opp = 1 - view.you;
    const asleep = (view.st && view.st.asleep) || [];
    let blockers = 0;
    for (let i = 0; i < FRONT; i++) { const z = view.zones[`front${opp}_${i}`]; if (z && z.ids && z.ids.length && !asleep.includes(z.ids[0])) blockers++; }
    return st.r === 'Medium' && blockers ? Math.floor(a / 2) : a;   // engine.js: Medium range halves the damage to the player, rounded down, when an enemy front-row card can block (test/damage_rule.js checks this against the engine)
  }

  /* With probability `variety` a Location pick is replaced by a uniformly random one, so no single Location is always chosen.
     Used in training (so every Location is experienced and learned) and when playing (so the AI is not predictable). Other decisions are untouched. */
  function varyLocation(dec, index, variety, rnd) {
    return dec.kind === 'location' && variety > 0 && (rnd || Math.random)() < variety ? Math.floor((rnd || Math.random)() * dec.actions.length) : index;
  }

  /* the room's HP cap, which is also the starting HP */
  const roomMaxHp = view => { const m = Math.round(Number(view.settings && view.settings.maxHp)); return m > 0 ? m : DEFAULT_MAX_HP; };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const n0 = v => (typeof v === 'number' && isFinite(v) ? v : 0);

  function create(meta) {
    const NC = meta.keys.length + 1, W = Math.ceil(NC / 32), S = meta.static[1].length;
    const idxByKey = new Map(meta.keys.map((k, i) => [k, i + 1])), ignoredSettings = new Set(meta.ignoredSettings || ['idle', 'board']);
    const typeOf = meta.types;
    const mainIdx = [], extraIdx = [];
    meta.kinds.forEach((k, i) => { if (k === 'main') mainIdx.push(i); else if (k === 'extra') extraIdx.push(i); });

    const L = {
      FEATURE_VERSION, NC, W, S, FRONT, BACK, BOARD, EQ, HAND, SETS, TXT_N, D_SLOT, D_HAND, NS, NA, NAI, NTYPES, MULL_MAX,
      I_SLOT: 0, I_EQ: BOARD, I_HAND: BOARD + BOARD * EQ, I_LOC: BOARD + BOARD * EQ + HAND, I_TITLE: BOARD + BOARD * EQ + HAND + 2,
      I_SETS: BOARD + BOARD * EQ + HAND + 3, NI: BOARD + BOARD * EQ + HAND + 3 + SETS * W,
      F_SLOT: 0, F_HAND: BOARD * D_SLOT, F_SCAL: BOARD * D_SLOT + HAND * D_HAND, NF: BOARD * D_SLOT + HAND * D_HAND + NS,
    };

    const idxOfCard = (view, id) => { const c = view.cards && view.cards[id]; return c ? idxByKey.get(c.key) || 0 : 0; };
    const idxOfOption = (view, o) => {
      const c = view.cards && view.cards[o.id];
      if (c && idxByKey.has(c.key)) return idxByKey.get(c.key);
      const stem = String(o.img || '').split('?')[0].split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
      return idxByKey.get(stem) || meta.names[o.name] || 0;
    };

    /* where every field base card stands, from the viewer's perspective: side 0 = me, 1 = opponent */
    function boardMap(view) {
      const you = view.you, out = [], where = new Map();
      for (const side of [0, 1]) {
        const seat = side === 0 ? you : 1 - you;
        for (const [row, n] of [['front', FRONT], ['back', BACK]]) {
          for (let i = 0; i < n; i++) {
            const z = view.zones[`${row}${seat}_${i}`], ids = (z && z.ids) || [];
            out.push(ids);
            if (ids.length) where.set(ids[0], { side, row, slot: i, board: out.length - 1 });
          }
        }
      }
      return { slots: out, where };
    }

    const chosenOf = (view, ctx) => (ctx && ctx.pid === (view.prompt && view.prompt.id) ? ctx.chosen : []);

    function zoneGroup(view, zone) {
      const you = view.you, m = /^(hand|gy|neut|front|back)([01])/.exec(zone || '');
      if (!m) return 5;
      const mine = +m[2] === you;
      if (m[1] === 'hand') return mine ? 0 : 5;
      if (m[1] === 'front' || m[1] === 'back') return mine ? 1 : 3;
      return mine ? 2 : 4;
    }

    function promptActions(view, ctx) {
      const p = view.prompt, chosen = chosenOf(view, ctx), out = [];
      if (p.kind === 'cards') {
        for (const o of p.options) if (!chosen.includes(o.id)) out.push({ type: T.PCARD, pick: o.id, option: o });
        if (chosen.length >= p.min && chosen.length < p.max) out.push({ type: T.PDONE });
      } else if (p.kind === 'choice') {
        p.options.forEach((o, pos) => out.push({ type: T.PCHOICE, msg: { t: 'choose', pid: p.id, ans: [o.value] }, label: o.label, pos, n: p.options.length }));
      } else {
        const span = p.max - p.min, step = Math.max(1, Math.ceil(span / (NUM_CHOICES - 1)));
        const values = []; for (let v = p.min; v <= p.max; v += step) values.push(v);
        if (values[values.length - 1] !== p.max) values.push(p.max);
        values.forEach((v, pos) => out.push({ type: T.PNUM, msg: { t: 'choose', pid: p.id, ans: [v] }, pos, n: values.length, value: v, span }));
      }
      return out;
    }

    /* turns a chosen prompt action into either a message to send or the updated partial selection */
    function resolvePrompt(view, ctx, action) {
      const p = view.prompt;
      if (action.msg) return { send: action.msg };
      const chosen = chosenOf(view, ctx).slice();
      if (action.type === T.PCARD) {
        chosen.push(action.pick);
        const left = p.options.filter(o => !chosen.includes(o.id));
        if (chosen.length >= p.max || !left.length) return { send: { t: 'choose', pid: p.id, ans: chosen } };
        if (left.length <= p.min - chosen.length) return { send: { t: 'choose', pid: p.id, ans: chosen.concat(left.map(o => o.id)) } };
        return { pending: { pid: p.id, chosen } };
      }
      return { send: { t: 'choose', pid: p.id, ans: chosen } };
    }

    function mainActions(view) {
      const you = view.you, out = [{ type: T.END, msg: { t: 'endTurn' } }];
      const hand = view.zones['hand' + you].ids;
      for (const id of hand) {
        const c = view.costs && view.costs[id];
        if (!c || !c.ok) continue;
        const ty = typeOf[idxOfCard(view, id)];
        if (ty === 'unit' || ty === 'summon') {
          let free = 0;
          for (let i = 0; i < FRONT; i++) {
            const z = view.zones[`front${you}_${i}`];
            if (z && !z.ids.length) { out.push({ type: T.PLAY, msg: { t: 'play', id, to: `front${you}_${i}` }, id, tile: i, paid: c.paid, hp: c.hp }); free++; }
          }
          if (!free) out.push({ type: T.PLAY, msg: { t: 'play', id }, id, tile: -1, paid: c.paid, hp: c.hp });
        } else out.push({ type: T.PLAY, msg: { t: 'play', id }, id, tile: -1, paid: c.paid, hp: c.hp });
      }
      for (const [id, a] of Object.entries(view.atk || {})) {
        if (a.why) continue;
        for (const target of a.t || []) out.push({ type: T.ATTACK, msg: { t: 'attack', id, target }, id, target });
        if (a.p) out.push({ type: T.ATTACK, msg: { t: 'attack', id, target: 'P' }, id, target: 'P' });
        if (a.s) out.push({ type: T.ATTACK, msg: { t: 'attack', id, target: 'S' }, id, target: 'S' });
      }
      for (const [id, list] of Object.entries(view.acts || {})) {
        for (const a of list) if (a.ok) out.push({ type: a.key === 'manual' ? T.MANUAL : T.ACTIVE, msg: { t: 'activate', id, key: a.key, i: a.i }, id, ability: a });
      }
      return out;
    }

    function mulliganActions(view) {
      const hand = view.zones['hand' + view.you].ids.slice(0, MULL_MAX), out = [];
      for (let mask = 0; mask < 1 << hand.length; mask++) {
        const ids = hand.filter((_, i) => mask >> i & 1);
        out.push({ type: T.MULLIGAN, msg: { t: 'mulligan', ids }, ids });
      }
      return out;
    }

    /* The decision the viewer faces right now, or null if it is not their move. ctx: { pid, chosen } for multi-select prompts, { banned } for rejected messages. */
    function decision(view, ctx) {
      const you = view.you;
      if (!(you === 0 || you === 1) || !view.zones) return null;
      let kind, actions;
      if (view.phase === 'location') {
        if (view.pick !== you) return null;
        kind = 'location'; actions = view.zones.locpool.ids.map(id => ({ type: T.LOCATION, msg: { t: 'pickLocation', id }, id }));
      } else if (view.phase === 'mulligan') {
        if (!view.mull || view.mull.done[you]) return null;
        kind = 'mulligan'; actions = mulliganActions(view);
      } else if (view.phase === 'playing') {
        if (view.prompt) { kind = 'prompt'; actions = promptActions(view, ctx); }
        else if (view.waiting || view.turn.p !== you) return null;
        else if (view.turn.phase === 'start') { kind = 'start'; actions = [{ type: T.START, msg: { t: 'startPhase' } }]; }
        else if (!view.myTurn) return null;
        else { kind = 'main'; actions = mainActions(view); }
      } else return null;
      const banned = ctx && ctx.banned;
      if (banned && banned.size) { const kept = actions.filter(a => !a.msg || !banned.has(JSON.stringify(a.msg))); if (kept.length) actions = kept; }
      return actions.length ? { kind, actions } : null;
    }

    /* Remembers that `sent` was refused by the server, so the next decision does not offer it again.
       A refused play on a tile blocked by an enemy effect (e.g. Firewhistle) is refused for every card, so the whole tile is banned: banning one card/tile pair
       at a time let a large hand exhaust the reject limit and end the game as an error. */
    function banRejected(ctx, dec, sent, reason) {
      ctx.banned.add(JSON.stringify(sent));
      if (sent.t !== 'play' || !sent.to || !TILE_BLOCKED.test(String(reason || ''))) return;
      for (const a of (dec && dec.actions) || []) if (a.msg && a.msg.t === 'play' && a.msg.to === sent.to) ctx.banned.add(JSON.stringify(a.msg));
    }

    function encodeState(view, ctx) {
      const you = view.you, opp = 1 - you, I = new Int32Array(L.NI), F = new Float32Array(L.NF);
      const { slots } = boardMap(view);
      const stats = view.stats || {}, flags = view.flags || {}, turn = view.turn || { n: 0 };
      const asleep = new Set((view.st && view.st.asleep) || []), silenced = new Set((view.st && view.st.silenced) || []);
      const acts = view.acts || {}, atk = view.atk || {};

      for (let s = 0; s < BOARD; s++) {
        const ids = slots[s]; if (!ids.length) continue;
        const base = ids[0], idx = idxOfCard(view, base), st = stats[base] || {}, fl = flags[base] || {}, o = L.F_SLOT + s * D_SLOT;
        I[L.I_SLOT + s] = idx;
        for (let k = 1; k < ids.length && k <= EQ; k++) I[L.I_EQ + s * EQ + k - 1] = idxOfCard(view, ids[k]);
        const mine = s < FRONT + BACK, myActs = (mine && acts[base]) || [];
        F[o] = 1; F[o + 1] = n0(st.a) / 10; F[o + 2] = n0(st.d) / 10;
        F[o + 3] = (n0(st.a) - n0(st.ra)) / 10; F[o + 4] = (n0(st.d) - n0(st.rd)) / 10;
        if (st.r in RANGE) F[o + 5 + RANGE[st.r]] = 1;
        F[o + 8] = asleep.has(base) ? 1 : 0; F[o + 9] = silenced.has(base) ? 1 : 0;
        F[o + 10] = Math.min(n0(fl.att), 2) / 2; F[o + 11] = fl.pt === turn.n ? 1 : 0;
        if (typeof fl.cd === 'number') { F[o + 12] = Math.min(fl.cd, 10) / 5; F[o + 13] = 1; }
        F[o + 14] = Math.min(ids.length - 1, 3) / 3;
        F[o + 15] = mine && atk[base] && !atk[base].why ? 1 : 0;
        F[o + 16] = myActs.some(a => a.ok && a.key === 'manual') ? 1 : 0;
        F[o + 17] = Math.min(myActs.filter(a => a.ok).length, 3) / 3;
      }

      const hand = view.zones['hand' + you].ids, dp = n0(view.dp && view.dp[you]);
      for (let h = 0; h < Math.min(hand.length, HAND); h++) {
        const id = hand[h], c = view.costs && view.costs[id], o = L.F_HAND + h * D_HAND;
        I[L.I_HAND + h] = idxOfCard(view, id);
        if (!c) continue;
        const paid = typeof c.paid === 'number' ? c.paid : 0;
        F[o] = c.ok ? 1 : 0; F[o + 1] = paid / 10; F[o + 2] = clamp((dp - paid) / 10, -1, 1);
        F[o + 3] = c.paid === 'all' ? 1 : 0; F[o + 4] = c.paid === '?' ? 1 : 0; F[o + 5] = n0(c.hp) / 10;
      }

      const seen = new Uint8Array(NC), setBits = (set, idxs) => { for (const i of idxs) if (i) I[L.I_SETS + set * W + (i >> 5)] |= 1 << (i & 31); };
      for (const id in view.cards) { const i = idxOfCard(view, id); if (i) seen[i] = 1; }
      const pile = z => ((view.zones[z] && view.zones[z].ids) || []).map(id => idxOfCard(view, id));
      setBits(0, pile('gy' + you)); setBits(1, pile('gy' + opp)); setBits(2, pile('neut' + you)); setBits(3, pile('neut' + opp));
      setBits(4, mainIdx.filter(i => !seen[i])); setBits(5, extraIdx.filter(i => !seen[i]));
      I[L.I_LOC] = pile('loc' + you)[0] || 0; I[L.I_LOC + 1] = pile('loc' + opp)[0] || 0;

      const p = view.prompt, chosen = chosenOf(view, ctx), sc = L.F_SCAL;
      const count = z => (view.zones[z] && (view.zones[z].ids ? view.zones[z].ids.length : view.zones[z].n)) || 0;
      const side = (seat, row, n) => { let c = 0; for (let i = 0; i < n; i++) if (count(`${row}${seat}_${i}`)) c++; return c; };
      const hp = view.hp || [0, 0], hpMe = n0(hp[you]), hpOpp = n0(hp[opp]);
      const unseen = mainIdx.filter(i => !seen[i]).length;
      const vals = [
        hpMe / 30, hpOpp / 30, (hpMe - hpOpp) / 30, roomMaxHp(view) / 30, dp / 10, Math.min(n0(turn.n) / 40, 1.5),
        view.turn && view.turn.p === you ? 1 : 0, view.phase === 'playing' ? 1 : 0, view.phase === 'location' ? 1 : 0, view.phase === 'mulligan' ? 1 : 0,
        hand.length / 8, count('hand' + opp) / 8, count('deck') / 150, count('extra') / 12, view.first === you ? 1 : 0, count('deck') < 12 ? 1 : 0,
        side(you, 'front', FRONT) / FRONT, side(opp, 'front', FRONT) / FRONT, side(you, 'back', BACK) / BACK, side(opp, 'back', BACK) / BACK,
        p && p.kind === 'cards' ? 1 : 0, p && p.kind === 'choice' ? 1 : 0, p && p.kind === 'number' ? 1 : 0,
        p ? n0(p.min) / 5 : 0, p ? Math.min(n0(p.max), 10) / 5 : 0, chosen.length / 5,
        view.phase === 'mulligan' && view.mull && view.mull.done[1 - you] ? 1 : 0,
        count('gy' + opp) / 50, count('gy' + you) / 50, unseen / 150,
        count('neut' + you) / 20, count('neut' + opp) / 20,
      ];
      for (let i = 0; i < N_SCALARS; i++) F[sc + i] = vals[i];
      /* every setting other than the idle timer is a "key=value" fact; two hashes per fact keep collisions between facts rare */
      for (const [k, v] of Object.entries(view.settings || {})) {
        if (ignoredSettings.has(k)) continue;
        const fact = k + '=' + v;
        F[sc + N_SCALARS + hash32(fact, 0x811c9dc5) % SET_BUCKETS] = 1; F[sc + N_SCALARS + hash32(fact, 0x9747b28c) % SET_BUCKETS] = 1;
      }
      I[L.I_TITLE] = p ? txtBucket(p.title) : 0;
      return { i: I, f: F };
    }

    /* Features of every legal action, packed row by row: ints [type, src, tgt, txt, set x5], floats [NA] */
    function encodeActions(view, dec, ctx) {
      const you = view.you, opp = 1 - you, n = dec.actions.length, I = new Int32Array(n * NAI), F = new Float32Array(n * NA);
      const { where } = boardMap(view), stats = view.stats || {}, dp = n0(view.dp && view.dp[you]), oppHp = n0(view.hp && view.hp[opp]);
      const chosen = chosenOf(view, ctx), p = view.prompt;
      dec.actions.forEach((a, r) => {
        const io = r * NAI, fo = r * NA;
        let src = 0, tgt = 0, txt = 0, set = [];
        F[fo + 1] = dp / 10;
        switch (a.type) {
          case T.PLAY: {
            src = idxOfCard(view, a.id); const paid = typeof a.paid === 'number' ? a.paid : 0;
            F[fo] = paid / 10; F[fo + 1] = clamp((dp - paid) / 10, 0, 2); F[fo + 28] = n0(a.hp) / 10;   // part of the cost can be paid in HP
            if (a.tile >= 0) F[fo + 2 + a.tile] = 1;
            break;
          }
          case T.ATTACK: {
            src = idxOfCard(view, a.id);
            const as = stats[a.id] || {}, atkV = n0(as.a); F[fo + 6] = atkV / 10;
            if (a.target === 'P' || a.target === 'S') {
              const dmg = damageToPlayer(view, a.id);
              F[fo + (a.target === 'P' ? 12 : 13)] = 1; F[fo + 7] = oppHp / 30; F[fo + 16] = dmg / 30;
              F[fo + 15] = a.target === 'P' && dmg >= oppHp ? 1 : 0;
            } else {
              tgt = idxOfCard(view, a.target);
              const ts = stats[a.target] || {}, w = where.get(a.target), defV = n0(ts.d);
              F[fo + 7] = defV / 10; F[fo + 8] = clamp((atkV - defV) / 10, -1, 1);
              F[fo + 17] = view.st && view.st.asleep && view.st.asleep.includes(a.target) ? 1 : 0;
              if (w && w.row === 'back') { F[fo + 14] = 1; F[fo + 9] = 1; }
              else F[fo + (atkV > defV ? 9 : atkV === defV ? 10 : 11)] = 1;
            }
            break;
          }
          case T.MANUAL: case T.ACTIVE:
            src = idxOfCard(view, a.id); txt = txtBucket(a.ability.label);
            F[fo] = n0(a.ability.cost) / 10; F[fo + 1] = clamp((dp - n0(a.ability.cost)) / 10, 0, 2);
            F[fo + 18] = Math.min(n0(a.ability.count), 3) / 3; F[fo + 19] = Math.min(n0(a.ability.i), 3) / 3;
            break;
          case T.LOCATION: src = idxOfCard(view, a.id); break;
          case T.MULLIGAN: set = a.ids.map(id => idxOfCard(view, id)); F[fo + 20] = a.ids.length / MULL_MAX; break;
          case T.PCARD:
            src = idxOfOption(view, a.option); F[fo + 22 + zoneGroup(view, a.option.zone)] = 1;
            set = chosen.map(id => { const o = p.options.find(x => x.id === id); return o ? idxOfOption(view, o) : 0; });
            F[fo + 21] = chosen.length / 5;
            break;
          case T.PCHOICE: txt = txtBucket(a.label); F[fo + 20] = a.n > 1 ? a.pos / (a.n - 1) : 0; break;
          case T.PNUM: F[fo + 20] = a.n > 1 ? a.pos / (a.n - 1) : 0; F[fo] = a.span ? (a.value - p.min) / a.span : 0; break;
          case T.PDONE:
            set = chosen.map(id => { const o = p.options.find(x => x.id === id); return o ? idxOfOption(view, o) : 0; });
            F[fo + 21] = chosen.length / 5;
            break;
          default: break;
        }
        I[io] = a.type; I[io + 1] = src; I[io + 2] = tgt; I[io + 3] = txt;
        for (let k = 0; k < MULL_MAX; k++) I[io + 4 + k] = set[k] || 0;
      });
      return { i: I, f: F };
    }

    return { layout: L, decision, resolvePrompt, banRejected, encodeState, encodeActions, txtBucket };
  }

  /* Loop guard. A repeatable ability that costs nothing (e.g. the Museum's "move a card") can be used any number of times, so an AI that finds it
     attractive can shuffle cards back and forth until the turn's decision cap. Each such ability may be used at most `maxUses` times per turn
     (paid abilities are limited by DP anyway, and one-use abilities by the game). One guard per player; the counts reset when the turn changes. */
  const MAX_FREE_REPEATS = 2;
  function createTurnGuard(maxUses = MAX_FREE_REPEATS) {
    let turn = null, uses = {};
    const key = msg => `${msg.id}|${msg.key}|${msg.i}`;
    const looping = a => a.msg.t === 'activate' && a.ability && a.ability.repeat && !a.ability.cost && (uses[key(a.msg)] || 0) >= maxUses;
    return {
      observe(view) { const now = view.turn ? `${view.turn.n}:${view.you}` : 'setup'; if (now !== turn) { turn = now; uses = {}; } },
      /* the decision without the actions that would repeat an ability too often (a decision is never left empty) */
      filter(dec) {
        if (!dec || dec.kind !== 'main') return dec;
        const kept = dec.actions.filter(a => !looping(a));
        return kept.length && kept.length < dec.actions.length ? Object.assign({}, dec, { actions: kept }) : dec;
      },
      /* call with every message that is sent */
      record(msg) { if (msg && msg.t === 'activate') uses[key(msg)] = (uses[key(msg)] || 0) + 1; },
    };
  }

  return { create, createTurnGuard, MAX_FREE_REPEATS, txtBucket, damageToPlayer, varyLocation, roomMaxHp, DEFAULT_MAX_HP, T, NTYPES };
});
