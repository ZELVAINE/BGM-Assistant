// BGM Assistant GM - content script
// Runs on play.basketball-gm.com/l/* only (see manifest)

(function () {
  // don't double-inject if the SPA somehow re-runs this
  if (document.getElementById('bgm-assistant-panel')) return;

  // ── constants ──────────────────────────────────────────

  const MODEL = 'deepseek/deepseek-chat-v3-0324';
  const CHAT_KEEP = 30;          // max messages to keep in history
  const CACHE_TTL = 8 * 60000;   // cached replies expire after 8 mins
  const CACHE_MAX = 18;
  const COOLDOWN = 4500;         // ms between API calls

  // the four involvement modes
  const MODES = [
    {
      label: 'Scout',
      prompt: 'Only speak when asked. Keep answers short. Evaluate, don\'t coach. No unsolicited trade ideas.'
    },
    {
      label: 'Advisor',
      prompt: 'Give clear, balanced advice with enough detail to actually act on. Flag obvious issues, but don\'t overwhelm.'
    },
    {
      label: 'Co-GM',
      prompt: 'Be proactive. Tell the user what you\'d do and why, flag problems before they hurt, think a few moves ahead.'
    },
    {
      label: 'Auto',
      prompt: 'Give the single best action to take right now with clear reasoning, a backup option, and what to watch next. Skip the hedging.'
    }
  ];

  // system prompt - this is the most important thing to get right
  // key design decisions:
  //  - extremely clear about what the game lets you actually control
  //  - uses in-game data only, ignores real-world rep
  //  - explains its reasoning so the user can learn
  //  - stays grounded (no invented mechanics)
  const SYSTEM_PROMPT = `You are the assistant GM in a Basketball GM simulation. Your job is to help the user make good decisions based on what's actually in the game.

WHO YOU ARE
You're like a smart front office analyst sitting next to the user. Friendly, direct, and honest. You explain your thinking so the user understands *why*, not just *what*. You admit uncertainty rather than making stuff up.

WHAT YOU CAN AND CAN'T DO
The game gives the user these controls:
- Sign, trade, waive, or extend players
- Set the lineup order (which affects who plays more)
- Adjust PT (playing time) modifiers per player using the in-game slider
- Draft players
- Set the team's strategy (rebuilding / contending)
- Manage the trade block

What the game does NOT let you control:
- You CANNOT set exact minutes for a specific player. Use PT modifiers and lineup order as proxies.
- You CANNOT script substitution timing or rotations
- You CANNOT manually develop a player or choose what ratings improve
- You CANNOT control opponents or their decisions
- Player development happens automatically based on age and pot

So if you want to say "give this player more minutes", say "move him up the depth chart and bump his PT modifier" instead. Never say "play him 28 minutes a game" - the user can't set that directly.

READING THE DATA
All monetary values in the game are in thousands. $20,000 = $20M. Always convert when talking to the user.

OVR rating scale (0-100):
- 80+: superstar, franchise cornerstone
- 70-79: all-star level, clear starter
- 60-69: solid starter, reliable contributor
- 50-59: average starter or good bench piece
- 40-49: bench player, rotation-depth
- Below 40: fringe roster / two-way type

POT is the ceiling. A 22-year-old with OVR 55 and POT 75 is potentially very valuable. A 30-year-old with OVR 65 and POT 66 is what he is.

The salary cap is soft - teams can go over it using Bird Rights and other exceptions, but they pay luxury tax above the luxury line.

Draft picks:
- Round 1 picks are real assets, especially from rebuilding teams that might lottery
- Round 2 picks are depth/development pieces, not usually headline trade assets
- Unprotected picks from bad teams are worth more than your own picks if you're good

TRADE LOGIC
When evaluating trades, think about:
- Asset value (OVR, POT, age, contract) on both sides
- Cap implications - does the trade work salary-wise?
- Timeline fit - does this player help now or later?
- Roster count (max 18 players, must stay at or below)
- What each team actually needs

If you can't confirm a trade is legal from the data provided, say "legality uncertain" rather than guessing.

PLAN ALIGNMENT
The user will set a plan (rebuild, contend, trade for picks, etc). Every recommendation should align to that plan. If you think the plan is wrong, say so once with brief reasoning, then suggest a better one using exactly this format on its own line:
PLAN_UPDATE_CANDIDATE: <your suggested plan>

Only use that marker when genuinely suggesting a new plan. Don't nag if the user rejects it.

RESPONSE STYLE
- Be direct. Get to the point.
- Explain your reasoning, especially for trades or big moves.
- Use short paragraphs, not walls of text. Bold key terms.
- No markdown tables.
- Don't repeat the context back at the user.
- If you don't know something or the data is unclear, say so.
- If there's no good move right now, say "there's no great move here" rather than forcing a recommendation.
- In Auto mode: structure as Best action → Why → Risk → What to watch.
- When learning mode is ON: add a short "Why this works" section at the end explaining the basketball principle.`;

  // ── state ──────────────────────────────────────────────

  let chatHistory = [];
  let gameContext = null;   // { gc, pageType, page } - refreshed before each call
  let apiKey = '';
  let mode = 1;             // index into MODES
  let plan = '';            // user's stated team goal
  let panelOpen = false;
  let learningMode = false;
  let responseCache = {};
  let lastCallAt = 0;
  let actionLog = [];       // recent game state changes we've noticed
  let lastSnapshot = null;  // for diffing roster changes
  let pendingPlan = '';     // plan candidate waiting for user accept/reject
  let rejectedPlans = [];   // plans the user has said no to

  // ── panel HTML ─────────────────────────────────────────

  const panel = document.createElement('div');
  panel.id = 'bgm-assistant-panel';
  panel.innerHTML = `
    <div id="bgm-panel-resizer"></div>
    <div id="bgm-panel-header">
      <div id="bgm-header-top">
        <div id="bgm-logo-area">
          <div id="bgm-title">Assistant GM</div>
          <div id="bgm-subtitle">No league loaded</div>
        </div>
        <div id="bgm-header-actions">
          <button class="bgm-icon-btn" id="bgm-settings-toggle" title="API key settings">⚙</button>
          <button class="bgm-icon-btn" id="bgm-clear-btn" title="Clear chat">↺</button>
          <button class="bgm-icon-btn" id="bgm-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="bgm-info-strip">
        <div class="bgm-strip-cell">
          <span class="bgm-strip-label">Team</span>
          <span class="bgm-strip-value" id="bgm-ctx-team">—</span>
        </div>
        <div class="bgm-strip-cell">
          <span class="bgm-strip-label">Season</span>
          <span class="bgm-strip-value accent" id="bgm-ctx-season">—</span>
        </div>
        <div class="bgm-strip-cell">
          <span class="bgm-strip-label">Payroll</span>
          <span class="bgm-strip-value" id="bgm-ctx-cap">—</span>
        </div>
        <div class="bgm-strip-cell">
          <span class="bgm-strip-label">Page</span>
          <span class="bgm-strip-value" id="bgm-ctx-page">—</span>
        </div>
      </div>
      <div id="bgm-controls-row">
        <div id="bgm-mode-row">
          ${MODES.map((m, i) => `<button class="bgm-mode-btn${i === 1 ? ' active' : ''}" data-mode="${i}" title="${m.prompt}">${m.label}</button>`).join('')}
        </div>
        <div id="bgm-goal-row">
          <span id="bgm-goal-label">Plan</span>
          <input type="text" id="bgm-goal-input" placeholder="e.g. rebuild through picks, contend this year…">
        </div>
        <div id="bgm-aux-row">
          <label class="bgm-switch" title="Adds explanations of basketball reasoning to responses">
            <input type="checkbox" id="bgm-learning-toggle">
            <span class="bgm-switch-ui"></span>
            <span class="bgm-switch-label">Explain reasoning</span>
          </label>
          <span id="bgm-cache-status">Ready</span>
        </div>
      </div>
      <div id="bgm-settings-panel">
        <label class="bgm-setting-label">OpenRouter API Key</label>
        <input type="password" id="bgm-api-key-input" placeholder="sk-or-…">
        <button id="bgm-save-settings">Save</button>
        <div id="bgm-api-status"></div>
      </div>
    </div>
    <div id="bgm-chat-area">
      <div class="bgm-message system">
        <div class="bgm-bubble">Load a league page, set a plan above, and ask anything. I'll read your roster, cap, picks, and the current page automatically.</div>
      </div>
    </div>
    <div id="bgm-quick-actions">
      <button class="bgm-quick-btn" data-prompt="Give me a quick roster diagnosis based on our plan.">Roster</button>
      <button class="bgm-quick-btn" data-prompt="What's the best move to make right now given our plan and current situation?">Next move</button>
      <button class="bgm-quick-btn" data-prompt="Break down our cap situation — payroll, flexibility, any bad contracts.">Cap</button>
      <button class="bgm-quick-btn" data-prompt="Which free agents make sense for us right now and why?">Free agents</button>
      <button class="bgm-quick-btn" data-prompt="What trade targets actually fit our plan? Be specific about what we'd give up.">Trade targets</button>
      <button class="bgm-quick-btn" data-prompt="Evaluate the trade on screen. Is it good for us? Walk me through it.">Eval trade</button>
      <button class="bgm-quick-btn" data-prompt="What are the biggest problems with our team right now and what order should I fix them?">Issues</button>
    </div>
    <div id="bgm-input-area">
      <div id="bgm-input-row">
        <textarea id="bgm-user-input" placeholder="Ask anything…" rows="1"></textarea>
        <button id="bgm-send-btn">↑</button>
      </div>
      <div id="bgm-input-hint">Enter to send · Shift+Enter for new line</div>
    </div>`;

  const tab = document.createElement('button');
  tab.id = 'bgm-toggle-tab';
  tab.textContent = 'GM';

  const root = document.body || document.documentElement;
  root.appendChild(panel);
  root.appendChild(tab);

  // quick refs to elements we'll need repeatedly
  const chatArea      = panel.querySelector('#bgm-chat-area');
  const userInput     = panel.querySelector('#bgm-user-input');
  const sendBtn       = panel.querySelector('#bgm-send-btn');
  const goalInput     = panel.querySelector('#bgm-goal-input');
  const settingsPanel = panel.querySelector('#bgm-settings-panel');
  const apiKeyInput   = panel.querySelector('#bgm-api-key-input');
  const apiStatus     = panel.querySelector('#bgm-api-status');
  const subtitle      = panel.querySelector('#bgm-subtitle');
  const ctxTeam       = panel.querySelector('#bgm-ctx-team');
  const ctxSeason     = panel.querySelector('#bgm-ctx-season');
  const ctxCap        = panel.querySelector('#bgm-ctx-cap');
  const ctxPage       = panel.querySelector('#bgm-ctx-page');
  const learningCheck = panel.querySelector('#bgm-learning-toggle');
  const cacheLabel    = panel.querySelector('#bgm-cache-status');

  // ── storage helpers ────────────────────────────────────
  // keys are scoped per league so different saves don't bleed into each other

  function leagueId() {
    const m = location.pathname.match(/\/l\/(\d+)/);
    return m ? m[1] : 'global';
  }

  function key(suffix) {
    return `bgm:${leagueId()}:${suffix}`;
  }

  async function loadState() {
    const id = leagueId();
    const result = await browser.storage.local.get([
      'apiKey', 'mode',
      key('chat'), key('plan'), key('rejectedPlans'),
      key('learning'), key('cache'), key('actionLog'), key('snapshot')
    ]);

    if (result.apiKey)  { apiKey = result.apiKey; apiKeyInput.value = result.apiKey; apiStatus.textContent = '✓ Key saved'; apiStatus.className = 'ok'; }
    if (result.mode != null) { mode = result.mode; updateModeButtons(); }

    plan = result[key('plan')] || '';
    goalInput.value = plan;

    chatHistory    = result[key('chat')]          || [];
    rejectedPlans  = result[key('rejectedPlans')] || [];
    learningMode   = !!result[key('learning')];
    responseCache  = result[key('cache')]         || {};
    actionLog      = result[key('actionLog')]      || [];
    lastSnapshot   = result[key('snapshot')]       || null;
    learningCheck.checked = learningMode;

    renderHistory();
  }

  function saveChat()   { return browser.storage.local.set({ [key('chat')]: chatHistory.slice(-CHAT_KEEP) }); }
  function savePlan()   { return browser.storage.local.set({ [key('plan')]: plan }); }
  function saveRejected() { return browser.storage.local.set({ [key('rejectedPlans')]: rejectedPlans.slice(-10) }); }
  function saveLearning() { return browser.storage.local.set({ [key('learning')]: learningMode }); }
  function saveLog()    { return browser.storage.local.set({ [key('actionLog')]: actionLog.slice(-20) }); }
  function saveSnap()   { return browser.storage.local.set({ [key('snapshot')]: lastSnapshot }); }

  function saveCache() {
    // prune expired entries before saving
    const now = Date.now();
    const pruned = Object.fromEntries(
      Object.entries(responseCache)
        .filter(([, v]) => now - v.ts < CACHE_TTL)
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, CACHE_MAX)
    );
    responseCache = pruned;
    return browser.storage.local.set({ [key('cache')]: pruned });
  }

  // ── panel open/close ───────────────────────────────────

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    tab.style.right = panelOpen ? (panel.offsetWidth || 340) + 'px' : '0';
    if (panelOpen) {
      refreshContext();
      setTimeout(() => userInput.focus(), 80);
    }
  }

  tab.addEventListener('click', togglePanel);
  panel.querySelector('#bgm-close-btn').addEventListener('click', togglePanel);
  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'TOGGLE_PANEL') togglePanel();
  });

  // ── mode buttons ───────────────────────────────────────

  function updateModeButtons() {
    panel.querySelectorAll('.bgm-mode-btn').forEach((btn, i) => {
      btn.classList.toggle('active', i === mode);
    });
  }

  panel.querySelectorAll('.bgm-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      mode = parseInt(btn.dataset.mode, 10);
      updateModeButtons();
      browser.storage.local.set({ mode });
    });
  });

  // ── settings ───────────────────────────────────────────

  panel.querySelector('#bgm-settings-toggle').addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
  });

  panel.querySelector('#bgm-save-settings').addEventListener('click', () => {
    const k = apiKeyInput.value.trim();
    if (!k) { apiStatus.textContent = '✗ Paste your OpenRouter key'; apiStatus.className = 'err'; return; }
    apiKey = k;
    browser.storage.local.set({ apiKey: k });
    apiStatus.textContent = '✓ Saved';
    apiStatus.className = 'ok';
    settingsPanel.classList.remove('open');
  });

  // ── plan input ─────────────────────────────────────────

  goalInput.addEventListener('change', async () => {
    plan = goalInput.value.trim();
    await savePlan();
  });

  // ── learning toggle ────────────────────────────────────

  learningCheck.addEventListener('change', async () => {
    learningMode = learningCheck.checked;
    await saveLearning();
  });

  // ── clear chat ─────────────────────────────────────────

  panel.querySelector('#bgm-clear-btn').addEventListener('click', async () => {
    chatHistory = [];
    chatArea.innerHTML = '';
    addMsg('system', 'Chat cleared.');
    await saveChat();
  });

  // ── quick buttons ──────────────────────────────────────

  panel.querySelectorAll('.bgm-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      userInput.value = btn.dataset.prompt;
      send();
    });
  });

  // ── textarea auto-resize ───────────────────────────────

  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 90) + 'px';
  });

  userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  sendBtn.addEventListener('click', send);

  // ── resize handle ──────────────────────────────────────

  let dragging = false;
  panel.querySelector('#bgm-panel-resizer').addEventListener('mousedown', e => {
    dragging = true; e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = window.innerWidth - e.clientX;
    if (w >= 260 && w <= 640) {
      panel.style.width = w + 'px';
      if (panelOpen) tab.style.right = w + 'px';
    }
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // ── chat rendering ─────────────────────────────────────

  function escape(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // minimal formatting: **bold** and line breaks only
  function format(text) {
    return escape(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  function addMsg(role, text) {
    const wrap = document.createElement('div');
    wrap.className = 'bgm-message ' + role;

    if (role !== 'system') {
      const lbl = document.createElement('div');
      lbl.className = 'bgm-msg-label';
      lbl.textContent = role === 'user' ? 'You' : 'Assistant GM';
      wrap.appendChild(lbl);
    }

    const bub = document.createElement('div');
    bub.className = 'bgm-bubble';
    bub.innerHTML = format(text);
    wrap.appendChild(bub);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
    return bub;
  }

  function renderHistory() {
    chatArea.innerHTML = '';
    if (!chatHistory.length) {
      addMsg('system', 'Load a league page, set a plan above, and ask anything. I\'ll read your roster, cap, picks, and the current page automatically.');
      return;
    }
    for (const m of chatHistory) addMsg(m.role, m.content);
  }

  // stream in the reply word by word so it feels less instant
  async function streamReply(text) {
    const wrap = document.createElement('div');
    wrap.className = 'bgm-message assistant';
    const lbl = document.createElement('div');
    lbl.className = 'bgm-msg-label';
    lbl.textContent = 'Assistant GM';
    const bub = document.createElement('div');
    bub.className = 'bgm-bubble';
    wrap.appendChild(lbl);
    wrap.appendChild(bub);
    chatArea.appendChild(wrap);

    let built = '';
    const chunks = text.split(/(\s+)/);
    for (let i = 0; i < chunks.length; i++) {
      built += chunks[i];
      bub.innerHTML = format(built);
      chatArea.scrollTop = chatArea.scrollHeight;
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 10));
    }
    return bub;
  }

  function showTyping() {
    const wrap = document.createElement('div');
    wrap.id = 'bgm-typing';
    wrap.className = 'bgm-message assistant';
    const lbl = document.createElement('div');
    lbl.className = 'bgm-msg-label';
    lbl.textContent = 'Assistant GM';
    const bub = document.createElement('div');
    bub.className = 'bgm-bubble';
    const dots = document.createElement('div');
    dots.className = 'bgm-typing';
    for (let i = 0; i < 3; i++) {
      const d = document.createElement('div');
      d.className = 'bgm-dot';
      dots.appendChild(d);
    }
    bub.appendChild(dots);
    wrap.appendChild(lbl);
    wrap.appendChild(bub);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('bgm-typing');
    if (el) el.remove();
  }

  // ── page reading ───────────────────────────────────────

  function getPageType() {
    const p = location.pathname;
    if (p.includes('/trade_proposals')) return 'trade_proposals';
    if (p.includes('/trade'))           return 'trade';
    if (p.includes('/roster'))          return 'roster';
    if (p.includes('/finances'))        return 'finances';
    if (p.includes('/draft'))           return 'draft';
    if (p.includes('/free_agents'))     return 'free_agents';
    if (p.includes('/standings'))       return 'standings';
    if (p.includes('/schedule'))        return 'schedule';
    if (p.includes('/player/'))         return 'player';
    return 'other';
  }

  function readPage() {
    const tables = [...document.querySelectorAll('table')].map(t => {
      const headers = [...t.querySelectorAll('th')].map(h => h.innerText.trim()).join(' | ');
      const rows = [...t.querySelectorAll('tr')].slice(0, 35)
        .map(r => [...r.querySelectorAll('td')].map(c => c.innerText.trim()).join(' | '))
        .filter(Boolean).join('\n');
      return headers ? headers + '\n' + rows : rows;
    }).filter(Boolean).join('\n\n');

    const alerts = [...document.querySelectorAll('.alert, .bg-danger, .bg-warning, .bg-success')]
      .map(a => a.innerText.trim()).filter(Boolean).join('\n');

    const heading = document.querySelector('h1, h2')?.innerText?.trim() || '';

    return { tables, alerts, heading };
  }

  // ── IndexedDB helpers ──────────────────────────────────

  function openDB(id) {
    return new Promise((res, rej) => {
      const req = indexedDB.open('league' + id);
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  }

  function getAll(db, store) {
    return new Promise(res => {
      try {
        const req = db.transaction([store], 'readonly').objectStore(store).getAll();
        req.onsuccess = e => res(e.target.result);
        req.onerror = () => res([]);
      } catch { res([]); }
    });
  }

  // ── player summarisation ───────────────────────────────

  // get the ratings row for the given season (or closest past season)
  function pickRatings(player, season) {
    if (!player.ratings?.length) return null;
    return [...player.ratings]
      .sort((a, b) => b.season - a.season)
      .find(r => r.season <= season) || player.ratings[player.ratings.length - 1];
  }

  // get last regular season stats, trying current season first then previous
  function pickStats(player, season) {
    if (!player.stats?.length) return null;
    const current = player.stats.filter(s => s.season === season && !s.playoffs).pop();
    if (current?.gp > 0) return current;
    const prev = player.stats.filter(s => s.season === season - 1 && !s.playoffs).pop();
    return prev?.gp > 0 ? prev : null;
  }

  function summarisePlayer(player, season) {
    const r = pickRatings(player, season);
    if (!r) return null;
    const s = pickStats(player, season);
    return {
      pid:      player.pid,
      tid:      player.tid,
      name:     player.firstName + ' ' + player.lastName,
      pos:      r.pos || player.pos,
      age:      season - player.born.year,
      ovr:      r.ovr,
      pot:      r.pot,
      contract: player.contract ? {
        amount: player.contract.amount,
        exp:    player.contract.exp,
        yrs:    Math.max(0, player.contract.exp - season + 1)
      } : null,
      injury: player.injury?.type !== 'Healthy' ? player.injury.type : null,
      stats: s ? {
        season: s.season,
        gp:  s.gp,
        pts: s.gp ? +(s.pts / s.gp).toFixed(1) : null,
        reb: s.gp ? +((s.drb + s.orb) / s.gp).toFixed(1) : null,
        ast: s.gp ? +(s.ast / s.gp).toFixed(1) : null,
        per: s.per ? +s.per.toFixed(1) : null
      } : null
    };
  }

  // rough trade value score - used to rank who other teams might move
  function tradeValue(p) {
    const contractPenalty = p.contract ? (p.contract.amount / 2000) * Math.max(1, p.contract.yrs) : 0;
    const upside = Math.max(0, p.pot - p.ovr) * 0.7;
    const youth  = Math.max(0, 25 - p.age) * 0.9;
    const perf   = p.stats?.per ? Math.max(0, p.stats.per - 12) * 0.9 : 0;
    return +(p.ovr * 1.5 + upside + youth + perf - contractPenalty).toFixed(1);
  }

  // ── context builder ────────────────────────────────────

  async function buildGameContext(id) {
    const db = await openDB(id);
    const [attrs, players, teams, picks] = await Promise.all([
      getAll(db, 'gameAttributes'),
      getAll(db, 'players'),
      getAll(db, 'teams'),
      getAll(db, 'draftPicks')
    ]);

    // flatten gameAttributes array into a plain object
    const ga = Object.fromEntries(attrs.map(a => [a.key, a.value]));
    const season  = ga.season || new Date().getFullYear();
    const userTid = Array.isArray(ga.userTid)
      ? ga.userTid[ga.userTid.length - 1].value
      : ga.userTid;

    const activeTeams = teams.filter(t => !t.disabled);
    const teamMap = new Map(activeTeams.map(t => [t.tid, t]));
    const myTeam  = teamMap.get(userTid);

    // summarise all players (skip retired/historical)
    const allSummarised = players
      .filter(p => p.tid !== -3 && p.tid !== -2)
      .map(p => summarisePlayer(p, season))
      .filter(Boolean);

    // group by team id for fast lookup
    const byTeam = new Map();
    for (const p of allSummarised) {
      if (!byTeam.has(p.tid)) byTeam.set(p.tid, []);
      byTeam.get(p.tid).push(p);
    }
    for (const list of byTeam.values()) list.sort((a, b) => b.ovr - a.ovr);

    const roster = byTeam.get(userTid) || [];
    const freeAgents = (byTeam.get(-1) || []).slice(0, 30);
    const payroll = roster.reduce((s, p) => s + (p.contract?.amount || 0), 0);

    const myPicks = picks
      .filter(p => p.tid === userTid)
      .map(p => ({
        season: p.season,
        round:  p.round,
        isOwn:  p.originalTid === userTid,
        orig:   p.originalTid === userTid
          ? (myTeam?.abbrev || 'OWN')
          : (teamMap.get(p.originalTid)?.abbrev || 'T' + p.originalTid)
      }))
      .sort((a, b) => a.season - b.season || a.round - b.round);

    // build a snapshot of every other team (used for trade context)
    const otherTeams = activeTeams
      .filter(t => t.tid !== userTid)
      .map(team => {
        const tp = byTeam.get(team.tid) || [];
        const tpay = tp.reduce((s, p) => s + (p.contract?.amount || 0), 0);
        return {
          tid:         team.tid,
          abbrev:      team.abbrev,
          name:        team.region + ' ' + team.name,
          strategy:    team.strategy || 'unknown',
          payroll:     tpay,
          rosterCount: tp.length,
          // top players and their trade value
          top:    tp.slice(0, 5).map(p => ({ name: p.name, pos: p.pos, age: p.age, ovr: p.ovr, pot: p.pot, contract: p.contract })),
          // players most likely to be moveable (low trade value = cheaper, possibly available)
          moveable: tp
            .filter(p => p.contract && p.ovr >= 45)
            .map(p => ({ ...p, tv: tradeValue(p) }))
            .sort((a, b) => a.tv - b.tv)
            .slice(0, 4)
            .map(p => ({ name: p.name, ovr: p.ovr, pot: p.pot, contract: p.contract }))
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      season, userTid,
      teamName:   myTeam ? myTeam.region + ' ' + myTeam.name : 'Unknown',
      teamAbbrev: myTeam?.abbrev || '???',
      strategy:   myTeam?.strategy || 'unknown',
      cap: {
        salaryCap: ga.salaryCap,
        luxury:    ga.luxuryPayroll,
        min:       ga.minPayroll,
        type:      ga.salaryCapType,
        payroll
      },
      roster, freeAgents, myPicks, otherTeams
    };
  }

  // ── snapshot diffing ───────────────────────────────────
  // detects changes between context refreshes so the AI knows what happened

  function makeSnapshot(gc, pageType) {
    return {
      pageType,
      rosterNames: gc.roster.map(p => p.name),
      payroll:     gc.cap.payroll,
      season:      gc.season
    };
  }

  function diffSnapshots(prev, next) {
    if (!prev || !next) return [];
    const changes = [];
    const nextNames = new Set(next.rosterNames);
    for (const n of next.rosterNames) {
      if (!prev.rosterNames.includes(n)) changes.push('Added to roster: ' + n);
    }
    for (const n of prev.rosterNames) {
      if (!nextNames.has(n)) changes.push('Removed from roster: ' + n);
    }
    if (Math.abs(next.payroll - prev.payroll) > 500) {
      changes.push(`Payroll changed to $${Math.round(next.payroll / 1000)}M`);
    }
    return changes.slice(0, 6);
  }

  // ── context refresh ────────────────────────────────────

  async function refreshContext() {
    const m = location.pathname.match(/\/l\/(\d+)/);
    if (!m) return;
    const id = parseInt(m[1], 10);

    try {
      const gc       = await buildGameContext(id);
      const pageType = getPageType();
      const page     = readPage();

      gameContext = { gc, pageType, page };
      updateInfoStrip(gc, pageType);

      // check if anything changed since last refresh
      const snap = makeSnapshot(gc, pageType);
      const diffs = diffSnapshots(lastSnapshot, snap);
      for (const d of diffs) {
        if (actionLog[actionLog.length - 1] !== d) actionLog.push(d);
      }
      lastSnapshot = snap;
      if (diffs.length) await saveLog();
      await saveSnap();

    } catch (e) {
      console.warn('BGM Assistant: context refresh failed', e);
    }
  }

  function updateInfoStrip(gc, pageType) {
    subtitle.textContent  = gc.teamName;
    ctxTeam.textContent   = gc.teamAbbrev;
    ctxSeason.textContent = gc.season;
    ctxPage.textContent   = pageType;
    if (gc.cap) {
      const pay = Math.round(gc.cap.payroll / 1000);
      ctxCap.textContent = '$' + pay + 'M';
      ctxCap.className = gc.cap.payroll > gc.cap.luxury
        ? 'bgm-strip-value danger'
        : 'bgm-strip-value';
    }
  }

  // ── prompt builder ─────────────────────────────────────

  // pick the most relevant other teams to include
  // - if on a trade page: include all teams (user is actively trading)
  // - otherwise: pick teams most likely to have useful trade partners
  function pickRelevantTeams(gc, pageType) {
    if (pageType === 'trade' || pageType === 'trade_proposals') {
      return gc.otherTeams;
    }
    const planLower = plan.toLowerCase();
    const isRebuilding = /rebuild|tank|picks|young|future/.test(planLower);
    return gc.otherTeams
      .map(t => {
        let score = 0;
        // teams with opposite strategy are better trade partners
        if (isRebuilding && t.strategy === 'contending') score += 4;
        if (!isRebuilding && t.strategy === 'rebuilding') score += 4;
        // teams with lots of roster space might want to take on salary
        if (t.rosterCount < 12) score += 2;
        return { t, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(x => x.t);
  }

  function buildPrompt(userText) {
    const modeInfo = MODES[mode];
    let p = SYSTEM_PROMPT + '\n\n';

    p += `MODE: ${modeInfo.label}\n${modeInfo.prompt}\n`;
    p += `EXPLAIN REASONING: ${learningMode ? 'YES - add a short "Why this works" section at the end' : 'NO - skip it'}\n\n`;

    // plan context
    p += `ACTIVE PLAN: ${plan || 'Not set - ask the user what direction they want to go before making major recommendations.'}\n`;
    if (rejectedPlans.length) {
      p += `Plans user has rejected (don't suggest these again): ${rejectedPlans.join(' | ')}\n`;
    }
    p += '\n';

    // recent game state changes we've detected
    if (actionLog.length) {
      p += `RECENT CHANGES DETECTED:\n${actionLog.slice(-8).map(x => '- ' + x).join('\n')}\n\n`;
    }

    // last few messages for short-term memory
    if (chatHistory.length) {
      const recent = chatHistory.slice(-6)
        .map(m => `${m.role === 'user' ? 'User' : 'You'}: ${m.content.slice(0, 200)}`)
        .join('\n');
      p += `RECENT CONVERSATION:\n${recent}\n\n`;
    }

    const gc = gameContext?.gc;
    if (!gc) {
      p += 'NOTE: No live game data available. Answer carefully and note what data you\'re missing.\n';
      p += `User asked: ${userText}\n`;
      return p;
    }

    // page-specific reminders
    const pageType = gameContext.pageType;
    if (pageType === 'draft') {
      p += 'PAGE NOTE: Draft page. Only recommend players still visible/available on screen.\n\n';
    } else if (pageType === 'free_agents') {
      p += 'PAGE NOTE: Free agents page. Only recommend players in the provided FA pool.\n\n';
    } else if (pageType === 'trade' || pageType === 'trade_proposals') {
      p += 'PAGE NOTE: Trade page. Respect current roster counts. Check salary match and legality.\n\n';
    }

    const c = gc.cap;
    p += `TEAM: ${gc.teamName} (${gc.teamAbbrev}) | Season: ${gc.season} | Strategy: ${gc.strategy}\n`;
    p += `CAP: $${Math.round(c.salaryCap/1000)}M cap | $${Math.round(c.luxury/1000)}M luxury | $${Math.round(c.min/1000)}M min floor\n`;
    p += `PAYROLL: $${Math.round(c.payroll/1000)}M | space: $${Math.round(Math.max(0, c.salaryCap - c.payroll)/1000)}M | type: ${c.type}\n\n`;

    // full roster - top 12 shown with full detail, rest just listed
    const detailed = gc.roster.slice(0, 12);
    const rest = gc.roster.slice(12);
    p += `ROSTER (${gc.roster.length}/18 players):\n`;
    for (const pl of detailed) {
      const ct  = pl.contract ? `$${Math.round(pl.contract.amount/1000)}M/${pl.contract.yrs}yr` : 'no contract';
      const inj = pl.injury ? ` [INJURED: ${pl.injury}]` : '';
      const st  = pl.stats ? ` | ${pl.stats.pts ?? '-'} pts ${pl.stats.reb ?? '-'} reb ${pl.stats.ast ?? '-'} ast PER ${pl.stats.per ?? '-'}` : '';
      p += `${pl.name} | ${pl.pos} | Age ${pl.age} | OVR ${pl.ovr} POT ${pl.pot} | ${ct}${inj}${st}\n`;
    }
    if (rest.length) {
      p += `Also on roster: ${rest.map(pl => `${pl.name} (${pl.ovr}/${pl.pot}, $${Math.round((pl.contract?.amount||0)/1000)}M)`).join(', ')}\n`;
    }
    p += '\n';

    // draft picks
    p += 'DRAFT PICKS OWNED:\n';
    if (gc.myPicks.length) {
      const bySeason = {};
      for (const pk of gc.myPicks) (bySeason[pk.season] = bySeason[pk.season] || []).push(pk);
      for (const [yr, szn] of Object.entries(bySeason)) {
        const r1 = szn.filter(x => x.round === 1).map(x => x.isOwn ? 'OWN' : x.orig).join(', ');
        const r2 = szn.filter(x => x.round === 2).map(x => x.isOwn ? 'OWN' : x.orig).join(', ');
        p += `${yr}: ${r1 ? `R1(${r1}) ` : ''}${r2 ? `R2(${r2})` : ''}\n`;
      }
    } else {
      p += 'No picks currently owned.\n';
    }
    p += '\n';

    // top free agents
    p += 'TOP FREE AGENTS:\n';
    for (const pl of gc.freeAgents.slice(0, 15)) {
      const ask = pl.contract ? `$${Math.round(pl.contract.amount/1000)}M` : '?';
      p += `${pl.name} | ${pl.pos} | Age ${pl.age} | OVR ${pl.ovr} POT ${pl.pot} | asking ${ask}\n`;
    }
    p += '\n';

    // current page content (tables, alerts etc)
    const pg = gameContext.page;
    if (pg?.heading || pg?.alerts || pg?.tables) {
      p += `CURRENT PAGE (${pageType}):\n`;
      if (pg.heading) p += pg.heading + '\n';
      if (pg.alerts) p += 'Alerts: ' + pg.alerts + '\n';
      if (pg.tables) {
        const trimmed = pg.tables.slice(0, 2500);
        p += trimmed + (pg.tables.length > 2500 ? '\n[truncated]' : '') + '\n';
      }
      p += '\n';
    }

    // other teams context - scoped to what's useful for current situation
    const relevantTeams = pickRelevantTeams(gc, pageType);
    p += 'OTHER TEAMS (most relevant to current situation):\n';
    for (const t of relevantTeams) {
      const topStr = t.top.slice(0, 3).map(x => `${x.name} (${x.ovr}/${x.pot}, ${x.age})`).join(', ');
      const movStr = t.moveable.slice(0, 2).map(x => `${x.name} ($${Math.round((x.contract?.amount||0)/1000)}M)`).join(', ');
      p += `${t.abbrev} | ${t.strategy} | payroll $${Math.round(t.payroll/1000)}M | roster ${t.rosterCount}/18 | top: ${topStr || 'none'} | possibly moveable: ${movStr || 'none'}\n`;
    }

    p += `\nUser's question: ${userText}\n`;
    return p;
  }

  // ── caching ────────────────────────────────────────────

  // build a fingerprint to check if we have a cached reply
  // dynamic pages (trade, FA, draft) are never cached since the data changes fast
  function cacheKey(text) {
    const gc = gameContext?.gc;
    if (!gc) return null;

    const dynamicPages = new Set(['draft', 'free_agents', 'trade', 'trade_proposals']);
    if (dynamicPages.has(gameContext?.pageType)) return null;

    const rosterStamp = gc.roster.slice(0, 12)
      .map(p => `${p.pid}:${p.ovr}:${p.contract?.amount || 0}`).join(',');
    return [
      gc.userTid, gc.season, mode, learningMode ? 1 : 0,
      plan || '-',
      gameContext.pageType,
      rosterStamp,
      text.trim().toLowerCase()
    ].join('|');
  }

  // ── API call ───────────────────────────────────────────

  async function callOpenRouter(userText) {
    if (!apiKey) throw new Error('No API key — click ⚙ to add your OpenRouter key.');

    // system prompt + full history
    const messages = [
      { role: 'system', content: buildPrompt(userText) },
      ...chatHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    ];

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://play.basketball-gm.com',
        'X-OpenRouter-Title': 'BGM Assistant'
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: mode === 0 ? 0.25 : 0.4,
        max_tokens:  learningMode ? 900 : 600,
        stream: false
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || 'OpenRouter error ' + res.status);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenRouter');
    return text;
  }

  // ── plan candidate handling ────────────────────────────
  // the AI can suggest a new plan by appending PLAN_UPDATE_CANDIDATE: ...

  function extractPlanCandidate(text) {
    const m = text.match(/PLAN_UPDATE_CANDIDATE:\s*(.+)$/m);
    return m ? m[1].trim() : '';
  }

  function stripPlanMarker(text) {
    return text.replace(/\n?PLAN_UPDATE_CANDIDATE:.+$/m, '').trim();
  }

  function showPlanPrompt(candidate) {
    const wrap = document.createElement('div');
    wrap.className = 'bgm-message system';
    const bub = document.createElement('div');
    bub.className = 'bgm-bubble';
    bub.innerHTML = format(`**Suggested plan:** ${candidate}`);

    const actions = document.createElement('div');
    actions.className = 'bgm-plan-actions';

    const yes = document.createElement('button');
    yes.className = 'bgm-mini-btn';
    yes.textContent = 'Use this plan';
    yes.onclick = async () => {
      plan = candidate;
      goalInput.value = candidate;
      pendingPlan = '';
      await savePlan();
      addMsg('system', `Plan updated: ${candidate}`);
    };

    const no = document.createElement('button');
    no.className = 'bgm-mini-btn secondary';
    no.textContent = 'Keep current plan';
    no.onclick = async () => {
      rejectedPlans.push(candidate);
      pendingPlan = '';
      await saveRejected();
      addMsg('system', 'Kept current plan.');
    };

    actions.appendChild(yes);
    actions.appendChild(no);
    bub.appendChild(actions);
    wrap.appendChild(bub);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  // quick yes/no detection for when user responds to a plan prompt via text
  function isYes(text) { return /^(yes|yeah|yep|sure|ok|okay|do it)$/i.test(text.trim()); }
  function isNo(text)  { return /^(no|nah|nope|keep|don'?t)$/i.test(text.trim()); }

  // ── send ───────────────────────────────────────────────

  async function send() {
    const text = userInput.value.trim();
    if (!text) return;

    // cooldown check
    const now = Date.now();
    if (now - lastCallAt < COOLDOWN) {
      const wait = Math.ceil((COOLDOWN - (now - lastCallAt)) / 1000);
      addMsg('system', `Hang on ${wait}s before sending another — avoids burning through your credits.`);
      return;
    }

    userInput.value = '';
    userInput.style.height = 'auto';
    sendBtn.disabled = true;

    addMsg('user', text);
    chatHistory.push({ role: 'user', content: text });
    await saveChat();

    // handle yes/no responses to a pending plan suggestion
    if (pendingPlan) {
      if (isYes(text)) {
        plan = pendingPlan;
        goalInput.value = plan;
        const accepted = pendingPlan;
        pendingPlan = '';
        await savePlan();
        await streamReply(`Got it. **Plan updated:** ${accepted}`);
        chatHistory.push({ role: 'assistant', content: `Plan updated: ${accepted}` });
        await saveChat();
        sendBtn.disabled = false;
        userInput.focus();
        return;
      }
      if (isNo(text)) {
        rejectedPlans.push(pendingPlan);
        pendingPlan = '';
        await saveRejected();
        await streamReply('No problem, sticking with the current plan.');
        chatHistory.push({ role: 'assistant', content: 'Sticking with current plan.' });
        await saveChat();
        sendBtn.disabled = false;
        userInput.focus();
        return;
      }
    }

    showTyping();

    try {
      await refreshContext();

      // check cache first
      const ck = cacheKey(text);
      let rawReply;
      const cached = ck ? responseCache[ck] : null;

      if (cached && Date.now() - cached.ts < CACHE_TTL) {
        rawReply = cached.reply;
        cacheLabel.textContent = 'Cached';
        cacheLabel.className = 'ok';
      } else {
        cacheLabel.textContent = 'Live';
        cacheLabel.className = 'live';
        lastCallAt = Date.now();
        rawReply = await callOpenRouter(text);

        if (ck) {
          responseCache[ck] = { reply: rawReply, ts: Date.now() };
          await saveCache();
        }
      }

      hideTyping();

      // check if the AI is suggesting a plan change
      const candidate = extractPlanCandidate(rawReply);
      const cleanReply = stripPlanMarker(rawReply);

      if (candidate && !rejectedPlans.includes(candidate)) {
        pendingPlan = candidate;
      } else {
        pendingPlan = '';
      }

      await streamReply(cleanReply);
      chatHistory.push({ role: 'assistant', content: cleanReply });
      if (chatHistory.length > CHAT_KEEP) chatHistory = chatHistory.slice(-CHAT_KEEP);
      await saveChat();

      if (pendingPlan) showPlanPrompt(pendingPlan);
      cacheLabel.textContent = 'Ready';
      cacheLabel.className = '';

    } catch (e) {
      hideTyping();
      chatHistory.pop();
      await saveChat();
      cacheLabel.textContent = 'Error';
      cacheLabel.className = 'err';

      const wrap = document.createElement('div');
      wrap.className = 'bgm-message error';
      const bub = document.createElement('div');
      bub.className = 'bgm-bubble';
      bub.textContent = '✗ ' + e.message;
      wrap.appendChild(bub);
      chatArea.appendChild(wrap);
      chatArea.scrollTop = chatArea.scrollHeight;
    }

    sendBtn.disabled = false;
    userInput.focus();
  }

  // ── SPA navigation detection ───────────────────────────
  // BGM is a React SPA so we watch for URL changes rather than page loads

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      loadState();  // reload per-league state in case they switched leagues
      if (panelOpen) refreshContext();
    }
  }).observe(document.body || document.documentElement, { childList: true, subtree: true });

  // ── init ───────────────────────────────────────────────

  loadState();
  refreshContext();

})();
