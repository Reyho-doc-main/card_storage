(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../lib/features'), require('../lib/model'));
  else root.TACGBot = factory(root.TACGFeatures, root.TACGModel);
})(typeof self !== 'undefined' ? self : this, function (Features, Model) {
  'use strict';

  const MAX_TURN_DECISIONS = 150;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const CAN_INFLATE = typeof DecompressionStream === 'function';
  const inflate = buf => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'))).text();

  const getFrom = base => name => fetch(base + name).then(r => { if (!r.ok) throw new Error(`${base}${name}: HTTP ${r.status}`); return r; });
  const dirUrl = url => url.replace(/\/?$/, '/');

  /* The difficulty levels on offer: { default, levels: [{ id, label, temperature }] } */
  const listLevels = base => getFrom(dirUrl(base))('models.json').then(r => r.json());

  /* Downloads one level (default if omitted) from the AI folder `source`, or takes { manifest, buffer, meta } directly, and builds the policy.
     Rejects weights that do not belong to their card table or to this version of the code. */
  async function loadPolicy(source, levelId) {
    let manifest, buffer, meta, level = { temperature: 0, locationVariety: 0.3 };
    if (typeof source === 'string') {
      const base = dirUrl(source), get = getFrom(base), index = await get('models.json').then(r => r.json());
      level = index.levels.find(l => l.id === (levelId || index.default));
      if (!level) throw new Error(`The AI has no difficulty level "${levelId}".`);
      [manifest, meta, buffer] = await Promise.all([get(`models/${level.id}/manifest.json`).then(r => r.json()), get('cards_meta.json').then(r => r.json()), get(`models/${level.id}/weights.bin`).then(r => r.arrayBuffer())]);
    } else ({ manifest, buffer, meta } = source);
    const F = Features.create(meta);
    if (Model.compatibility(manifest, F.layout, meta) !== 'ok') throw new Error('The AI model does not belong to its card table: rebuild the web package.');
    const forward = Model.createForward(F.layout, manifest.cfg, meta, Model.unpack(manifest, buffer));
    return { F, forward, manifest, level };
  }

  function greedy(forward, temperature) {
    return (state, actions, n) => {
      const q = forward.q(state, actions, n);
      if (!(temperature > 0)) { let best = 0; for (let i = 1; i < n; i++) if (q[i] > q[best]) best = i; return best; }
      let max = -Infinity; for (let i = 0; i < n; i++) if (q[i] > max) max = q[i];
      const w = Array.from(q, v => Math.exp((v - max) / temperature)), total = w.reduce((a, b) => a + b, 0);
      let r = Math.random() * total; for (let i = 0; i < n; i++) if ((r -= w[i]) < 0) return i;
      return n - 1;
    };
  }

  const freshCtx = () => ({ pid: null, chosen: [], banned: new Set() });

  /* What the viewer's decision looks like. If it is unchanged after we sent a move, that move has not been processed yet: the broadcast was about something else
     (the opponent's mulligan, a chat line, a reconnect). Acting again then would send a duplicate. */
  const signature = (dec, v) => JSON.stringify([dec.kind, dec.actions.map(a => a.msg || a.pick || a.type), v.dp, v.hp, v.turn]);

  /* Joins `room` on `server` as an ordinary second player and plays it with the model.
     options: { server: 'wss://host', room, name (default: "AI (<level label>)"), model: url of the AI folder | { manifest, buffer, meta }, level: 'easy', delayMs, temperature, onStatus }
     (tests only: WebSocket, choose, policy, session { code, token } to resume a seat) */
  function start(options) {
    const o = Object.assign({ delayMs: 700, onStatus: () => {} }, options);
    const WS = o.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) throw new Error('No WebSocket implementation available (use Node 22+ or a browser).');
    /* shown in the lobby: "AI (Medium)", from the level's label */
    const displayName = () => (policy && policy.level && policy.level.label ? `AI (${policy.level.label})` : 'AI');
    const guard = Features.createTurnGuard();                    // keeps this bot from repeating a free ability over and over
    let ws, stopped = false, policy = null, view = null, session = o.session || null, ctx = freshCtx(), busy = false, sentSignature = null, thinking = false, wake = false, last = null, turnKey = '', turnCount = 0;
    const status = (state, text) => o.onStatus({ state, text });

    async function act() {
      if (thinking) { wake = true; return; }
      if (busy || stopped || !view || !policy) return;
      thinking = true;
      try {
        for (;;) {
          const v = view, key = v.turn ? v.turn.n + ':' + v.you : 'setup';
          let dec = policy.F.decision(v, ctx);
          guard.observe(v); dec = guard.filter(dec);
          if (!dec) { status('waiting', v.phase === 'over' ? 'Game over' : v.phase === 'lobby' ? 'Waiting for the host to start' : 'Waiting for the opponent'); return; }
          if (key !== turnKey) { turnKey = key; turnCount = 0; }
          if (++turnCount > MAX_TURN_DECISIONS && dec.kind === 'main') dec = { kind: 'main', actions: dec.actions.filter(a => a.msg.t === 'endTurn') };
          status('thinking', 'Thinking...');
          let idx = 0;
          if (dec.actions.length > 1) {
            await sleep(o.delayMs);
            if (stopped || v !== view) return;
            idx = o.choose ? o.choose(v, dec) : Features.varyLocation(dec, policy.pick(policy.F.encodeState(v, ctx), policy.F.encodeActions(v, dec, ctx), dec.actions.length), policy.locationVariety);
          } else await sleep(Math.min(o.delayMs, 250));
          if (stopped || v !== view) return;
          const action = dec.actions[idx], step = dec.kind === 'prompt' ? policy.F.resolvePrompt(v, ctx, action) : { send: action.msg };
          if (step.pending) { Object.assign(ctx, step.pending); continue; }
          const before = policy.F.decision(v, freshCtx());
          ctx.pid = null; ctx.chosen = []; last = step.send; busy = true; sentSignature = before && signature(before, v);
          guard.record(step.send);
          ws.send(JSON.stringify(Object.assign({ ok: true }, step.send)));
          setTimeout(() => { if (busy && last === step.send) { busy = false; act(); } }, 5000);
          return;
        }
      } finally { thinking = false; if (wake) { wake = false; act(); } }
    }

    function connect() {
      ws = new WS(o.server + (CAN_INFLATE ? '/?z=1' : ''));   // the server sends large state messages deflated, about 3x smaller on the wire, like for the normal client
      ws.binaryType = 'arraybuffer';
      let inbox = Promise.resolve();
      ws.onopen = () => ws.send(JSON.stringify(session ? { t: 'rejoin', code: session.code, token: session.token } : { t: 'join', code: o.room, name: o.name || displayName() }));
      ws.onmessage = e => { inbox = inbox.then(async () => receive(JSON.parse(typeof e.data === 'string' ? e.data : await inflate(e.data)))).catch(console.error); };
      ws.onclose = () => { if (!stopped) { status('waiting', 'Reconnecting...'); setTimeout(() => { if (!stopped) connect(); }, 2000); } };
    }

    function receive(m) {
      if (m.t === 'joined') {
        if (m.spectator) { status('error', 'That room is full: the AI needs a free seat.'); handle.stop(); return; }
        session = { code: m.code, token: m.token }; status('waiting', 'Joined room ' + m.code);
      } else if (m.t === 'replaced') { status('error', 'This seat was taken over by another connection.'); handle.stop(); }
      else if (m.t === 'state') {
        view = m;
        if (busy) { const now = policy && policy.F.decision(m, freshCtx()); if (now && signature(now, m) === sentSignature) return; busy = false; ctx = freshCtx(); }
        act();
      }
      else if (m.t === 'error') {
        if (m.fatal || !view) { status('error', m.msg); handle.stop(); return; }
        if (last) policy.F.banRejected(ctx, policy.F.decision(view, ctx), last, m.msg);
        busy = false; act();
      }
    }

    const handle = { stop() { stopped = true; try { ws.close(); } catch (e) { /* already closed */ } status('stopped', 'Stopped'); } };
    status('loading', 'Loading the AI model...');
    (o.policy ? Promise.resolve(o.policy) : loadPolicy(o.model, o.level)).then(p => {
      policy = Object.assign({ pick: greedy(p.forward, o.temperature !== undefined ? o.temperature : p.level.temperature), locationVariety: o.locationVariety !== undefined ? o.locationVariety : (p.level.locationVariety ?? 0.5) }, p);
      if (!stopped) connect();
    }).catch(e => { status('error', String(e.message || e)); stopped = true; });
    return handle;
  }

  return { start, loadPolicy, listLevels };
});
