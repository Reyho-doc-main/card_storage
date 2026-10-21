/* Adds "Play vs AI" (with a difficulty selector) to the lobby of the game page. Load it after app.js:
     <script src="https://YOU.github.io/REPO/ai/lobby-button.js" defer></script>
   It sits next to the other AI files (features.js, model.js, bot-client.js, models.json, cards_meta.json, models/), loads them on first click and
   starts the AI in this browser tab; the AI then joins the room through the normal game server like any other player. */
(function () {
  'use strict';
  const BASE = window.TACG_AI_BASE || document.currentScript.src.replace(/[^/]*$/, '');
  const LABELS = { loading: 'Loading AI…', waiting: 'AI is in the room', thinking: 'AI is playing…' };
  let bot = null, botRoom = null, scriptsReady = null, button = null, picker = null, index = null, indexFailed = false;

  const load = src => new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = BASE + src; el.onload = resolve; el.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(el);
  });
  const loadAll = () => scriptsReady || (scriptsReady = load('features.js').then(() => load('model.js')).then(() => load('bot-client.js')).catch(e => { scriptsReady = null; throw e; }));

  const stopBot = () => { if (bot) { bot.stop(); bot = null; botRoom = null; } };

  function onStatus(state, text) {
    if (!button) return;
    if (state === 'error' || state === 'stopped') {
      bot = null; botRoom = null; picker.disabled = false;
      button.disabled = false; button.textContent = state === 'error' ? 'AI failed: ' + text + ' (retry)' : 'Play vs AI';
    } else button.textContent = LABELS[state] || text;
  }

  function startBot() {
    if (!S || bot) return;
    button.disabled = true; picker.disabled = true; button.textContent = 'Loading AI…';
    if (S.searching) send({ t: 'search', on: false });
    loadAll().then(() => {
      if (!S) return onStatus('stopped');
      botRoom = S.code;
      bot = TACGBot.start({ server: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host, room: S.code, model: BASE, level: picker.value, onStatus: (o => onStatus(o.state, o.text)) });
    }).catch(e => onStatus('error', e.message));
  }

  /* the list of difficulty levels is a tiny file; fetched once, the first time a lobby is shown */
  function fetchIndex() {
    if (index || indexFailed) return;
    indexFailed = true;
    fetch(BASE + 'models.json').then(r => r.json()).then(j => {
      index = j; indexFailed = false;
      picker.textContent = '';
      for (const l of j.levels) { const o = document.createElement('option'); o.value = l.id; o.textContent = l.label; picker.appendChild(o); }
      picker.value = j.default; sync();
    }).catch(() => { /* the AI is simply not offered */ });
  }

  function sync() {
    if (!button) {
      const anchor = document.getElementById('lbSearch');
      if (!anchor) return;
      picker = document.createElement('select'); picker.id = 'lbAILevel'; picker.className = 'hidden'; picker.title = 'AI difficulty';
      button = document.createElement('button'); button.id = 'lbAI'; button.className = 'hidden'; button.textContent = 'Play vs AI'; button.onclick = startBot;
      anchor.after(button); anchor.after(picker);
    }
    fetchIndex();
    const isHost = S && !spec && me === S.host, open = S && !(S.filled[0] && S.filled[1]);
    const show = !!index && isHost && (open || bot);
    button.classList.toggle('hidden', !show);
    picker.classList.toggle('hidden', !show || !!bot || index.levels.length < 2);
    if (!bot && show && !button.disabled) button.textContent = 'Play vs AI';
  }

  function install() {
    if (typeof renderLobby !== 'function') return;
    const original = renderLobby;
    renderLobby = function () { original.apply(this, arguments); sync(); };
    setInterval(() => { if (bot && (!S || S.code !== botRoom || spec)) stopBot(); }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
})();
