/* Adds "Play against AI" to the lobby of the game page, inside the Advanced section: opening it unfolds the list of AI opponents, and picking one starts it.
   Load it after app.js:
     <script src="https://YOU.github.io/REPO/ai/lobby-button.js" defer></script>
   It sits next to the other AI files (features.js, model.js, bot-client.js, models.json, cards_meta.json, models/), loads them when an opponent is picked and
   starts the AI in this browser tab; the AI then joins the room through the normal game server like any other player. */
(function () {
  'use strict';
  if (window.__TACG_AI_LOBBY__) return;
  window.__TACG_AI_LOBBY__ = true;
  const BASE = window.TACG_AI_BASE || document.currentScript.src.replace(/[^/]*$/, '');
  const STATUS = { loading: 'Loading AI…', waiting: 'AI is in the room', thinking: 'AI is playing…' };

  const STYLE = `
    #lbAI { margin: 0 0 12px; }
    #lbAI .ai-head { display: flex; align-items: center; gap: 8px; width: 100%; margin: 0; padding: 0; min-height: 0; border: 0; background: none; color: inherit; font: inherit; font-weight: 600; text-align: left; cursor: pointer; }
    #lbAI .ai-head:disabled { cursor: default; }
    #lbAI .ai-state { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--mut, #9aa1ad); }
    #lbAI .ai-caret { font-size: 12px; transition: transform .25s ease; }
    #lbAI.open .ai-caret { transform: rotate(90deg); }
    #lbAI .ai-fold { display: grid; grid-template-rows: 0fr; opacity: 0; visibility: hidden; transition: grid-template-rows .28s ease, opacity .2s ease, visibility 0s .28s; }
    #lbAI.open .ai-fold { grid-template-rows: 1fr; opacity: 1; visibility: visible; transition-delay: 0s; }
    #lbAI .ai-clip { min-height: 0; overflow: hidden; }
    #lbAI .ai-levels { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; }
    #lbAI .ai-level { display: flex; align-items: center; justify-content: space-between; width: 100%; margin: 0; padding: 8px 10px; text-align: left; background: #15171c; border: 1px solid var(--line, rgba(255,255,255,.18)); border-radius: 8px; color: inherit; font: inherit; cursor: pointer; }
    #lbAI .ai-level:hover:not(:disabled), #lbAI .ai-level:focus-visible { border-color: var(--acc, #ffd23f); }
    #lbAI .ai-level:disabled { opacity: .6; cursor: default; }
    #lbAI .ai-level small { color: var(--mut, #9aa1ad); }
    @media (prefers-reduced-motion: reduce) { #lbAI .ai-caret, #lbAI .ai-fold { transition: none; } }`;

  let bot = null, botRoom = null, scriptsReady = null, index = null, indexRequested = false, ui = null;

  const el = (tag, props, ...children) => { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; };
  const load = src => new Promise((resolve, reject) => {
    const script = el('script', { src: BASE + src, onload: resolve, onerror: () => reject(new Error('Could not load ' + src)) });
    document.head.appendChild(script);
  });
  const loadAll = () => scriptsReady || (scriptsReady = load('features.js').then(() => load('model.js')).then(() => load('bot-client.js')).catch(e => { scriptsReady = null; throw e; }));

  const stopBot = () => { if (bot) { bot.stop(); bot = null; botRoom = null; } };

  /* ---- the panel ---- */
  function build() {
    const anchor = document.getElementById('lbAdv');
    if (!anchor || ui) return !!ui;
    document.head.appendChild(el('style', { textContent: STYLE }));
    const state = el('span', { className: 'ai-state' }), caret = el('span', { className: 'ai-caret', textContent: '▸', ariaHidden: 'true' });
    const toggle = el('button', { type: 'button', className: 'ai-head', id: 'lbAIToggle' }, el('span', { textContent: 'Play against AI' }), state, caret);
    const levels = el('div', { className: 'ai-levels', role: 'group', ariaLabel: 'AI difficulty' });
    const fold = el('div', { className: 'ai-fold', id: 'lbAIList' }, el('div', { className: 'ai-clip' }, levels));
    const root = el('div', { id: 'lbAI', className: 'advbox hidden' }, toggle, fold);
    toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'lbAIList');
    toggle.onclick = () => setOpen(!root.classList.contains('open'));
    anchor.after(root);
    new MutationObserver(sync).observe(anchor, { attributes: true, attributeFilter: ['class'] });   // follows the Advanced button
    ui = { root, toggle, state, levels };
    return true;
  }

  function setOpen(open) {
    ui.root.classList.toggle('open', open);
    ui.toggle.setAttribute('aria-expanded', open);
  }

  function renderLevels() {
    ui.levels.textContent = '';
    for (const level of index.levels) {
      const button = el('button', { type: 'button', className: 'ai-level', textContent: level.label });
      if (level.id === index.default) button.append(el('small', { textContent: 'recommended' }));
      button.dataset.level = level.id; button.onclick = () => startBot(level.id);
      ui.levels.appendChild(button);
    }
  }

  function setBusy(busy) {
    ui.toggle.disabled = busy;
    for (const b of ui.levels.children) b.disabled = busy;
  }

  function onStatus(state, text) {
    if (!ui) return;
    if (state === 'error' || state === 'stopped') {
      bot = null; botRoom = null; setBusy(false);
      ui.state.textContent = state === 'error' ? 'AI failed: ' + text + ' (pick one to retry)' : '';
    } else ui.state.textContent = STATUS[state] || text;
  }

  function startBot(level) {
    if (!S || bot) return;
    setBusy(true); setOpen(false); ui.state.textContent = STATUS.loading;
    if (S.searching) send({ t: 'search', on: false });
    loadAll().then(() => {
      if (!S) return onStatus('stopped');
      botRoom = S.code;
      bot = TACGBot.start({ server: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host, room: S.code, model: BASE, level, onStatus: o => onStatus(o.state, o.text) });
    }).catch(e => onStatus('error', e.message));
  }

  /* the list of difficulty levels is a tiny file; fetched once, the first time a lobby is shown */
  function fetchIndex() {
    if (indexRequested) return;
    indexRequested = true;
    fetch(BASE + 'models.json').then(r => r.json()).then(json => { index = json; renderLevels(); sync(); }).catch(() => { indexRequested = false; /* the AI is simply not offered */ });
  }

  /* shown to the host of a room with a free seat (or with the AI in it), while Advanced is open */
  function sync() {
    if (!build()) return;
    fetchIndex();
    const advanced = document.getElementById('lbAdv'), advancedOpen = !advanced.classList.contains('hidden');
    const isHost = S && !spec && me === S.host, seatFree = S && !(S.filled[0] && S.filled[1]);
    const show = !!index && advancedOpen && isHost && (seatFree || !!bot);
    ui.root.classList.toggle('hidden', !show);
    if (!show) setOpen(false);
  }

  function install() {
    if (typeof renderLobby !== 'function') return;
    const original = renderLobby;
    renderLobby = function () { original.apply(this, arguments); sync(); };
    setInterval(() => { if (bot && (!S || S.code !== botRoom || spec)) stopBot(); }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
