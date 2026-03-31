(function () {
  if (document.getElementById('bgm-assistant-panel')) return;

  const STORAGE_PREFIX = 'bgmAssistant';
  const CHAT_LIMIT = 30;
  const PLAN_MARKER = 'PLAN_UPDATE_CANDIDATE:';
  const DEFAULT_MODEL = 'deepseek/deepseek-chat-v3-0324';
  const RESPONSE_CACHE_LIMIT = 18;
  const REQUEST_COOLDOWN_MS = 4500;

  const MODES = [
    {
      label: 'Scout',
      prompt: 'Speak only when the user asks. Be brief. Evaluate, do not coach. Do not proactively suggest trades unless directly asked.'
    },
    {
      label: 'Advisor',
      prompt: 'Give balanced advice with moderate detail. Offer occasional useful observations, but do not overwhelm the user.'
    },
    {
      label: 'Co-GM',
      prompt: 'Be proactive and directive. Flag issues early, state what you would do, and explain why in concrete terms.'
    },
    {
      label: 'Auto',
      prompt: 'Act like a daily operating guide. Tell the user the best action to take right now, why, backup options, and when to do nothing.'
    }
  ];

  const SYSTEM = `You are Assistant GM, a Basketball GM sidebar assistant.

IDENTITY AND TONE
- Friendly, serious, grounded, and blunt when needed.
- Sound like a smart basketball staff member, not a generic AI bot.
- Never roleplay taking actions yourself. You only advise the user.
- Never say that you are clicking buttons, sending offers, making signings, or changing lineups yourself.

DEEPSEEK RESPONSE DISCIPLINE
- Be concise first, detailed second.
- Do not ramble. Do not restate the full prompt.
- Prefer short sections with clear labels over long essays.
- If data is weak or legality is uncertain, say that plainly instead of guessing.

GAME RULES
- This assistant is for Basketball GM, not the real NBA.
- Maximum roster size is 18 players, not 15.
- Use Basketball GM rules and constraints whenever they differ from real NBA assumptions.
- There is no direct manual control over individual player development.

CORE LIMITS
- Use ONLY in-game information present in the prompt. Ignore real-world reputation if it conflicts with in-game data.
- Judge players mainly by in-game ratings, age, contract, recent stats, team direction, payroll, roster count, and fit.
- If a trade or signing cannot be verified as legal from the provided data, say so plainly.
- Never recommend signing a player who is already on the current roster.
- Do not invent cap exceptions, roster rules, or hidden mechanics you cannot verify.
- If there is no good move, say so clearly.

MODE RULES
- Scout: answer only the exact question, briefly, unless learning mode is enabled.
- Advisor: balanced detail, occasional observations.
- Co-GM: proactive, directive, flags issues before they become problems.
- Auto: give the best next action right now, not vague possibilities.

PLAN BOX RULES
- The user plan is the team's active goal.
- Every recommendation must be aligned to that plan first.
- If you believe the plan is poor, say so once, briefly explain why, and propose a replacement plan.
- When proposing a replacement plan, append a final line in EXACTLY this format:
PLAN_UPDATE_CANDIDATE: <replacement plan text>
- Only include that marker when you are actively proposing a new plan.
- After proposing an alternative once, do not nag. If the user rejects it, follow the active plan.

DECISION RULES
- Prefer concrete, game-legal, explainable advice.
- For trades, consider player value, age, OVR/POT, contract, team strategy, payroll pressure, roster count, and fit together.
- Do not suggest impossible trades if salary, roster count, or team direction obviously make them bad.
- If legality is uncertain, label it as legality uncertain.
- If you suggest a trade, include one realistic framework only, not five weak ideas.
- If there is no worthwhile trade, say do not trade right now.

OUTPUT RULES
- Never use markdown tables.
- Bold only the most important labels.
- In Auto mode, usually use this structure:
  **Best action**
  **Why**
  **Risk / legality**
  **Backup**
- In Scout mode, keep it tight.
- If LEARNING MODE is ON, add a final section called **What to learn** with 2-4 short bullets explaining the basketball logic behind the recommendation.`;

  let chatHistory = [];
  let gameContext = null;
  let apiKey = '';
  let involvementLevel = 1;
  let userGoal = '';
  let panelOpen = false;
  let pendingPlanCandidate = '';
  let rejectedPlanCandidates = [];
  let learningMode = false;
  let responseCache = {};
  let lastRequestAt = 0;

  const panel = document.createElement('div');
  panel.id = 'bgm-assistant-panel';
  panel.innerHTML = `
    <div id="bgm-panel-resizer"></div>
    <div id="bgm-panel-header">
      <div id="bgm-header-top">
        <div id="bgm-logo-area">
          <div id="bgm-logo-icon">GM</div>
          <div id="bgm-title-stack">
            <div id="bgm-title">Assistant GM</div>
            <div id="bgm-subtitle">No league loaded</div>
          </div>
        </div>
        <div id="bgm-header-actions">
          <button class="bgm-icon-btn" id="bgm-settings-toggle" title="API Settings">⚙</button>
          <button class="bgm-icon-btn" id="bgm-clear-btn" title="Clear chat">↺</button>
          <button class="bgm-icon-btn" id="bgm-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div id="bgm-info-strip">
        <div class="bgm-strip-cell"><span class="bgm-strip-label">Team</span><span class="bgm-strip-value" id="bgm-ctx-team">—</span></div>
        <div class="bgm-strip-cell"><span class="bgm-strip-label">Season</span><span class="bgm-strip-value accent" id="bgm-ctx-season">—</span></div>
        <div class="bgm-strip-cell"><span class="bgm-strip-label">Payroll</span><span class="bgm-strip-value" id="bgm-ctx-cap">—</span></div>
        <div class="bgm-strip-cell"><span class="bgm-strip-label">Page</span><span class="bgm-strip-value" id="bgm-ctx-page">—</span></div>
      </div>
      <div id="bgm-controls-row">
        <div id="bgm-mode-row">
          ${MODES.map((m,i)=>`<button class="bgm-mode-btn${i===1?' active':''}" data-mode="${i}" title="${m.prompt}">${m.label}</button>`).join('')}
        </div>
        <div id="bgm-goal-row">
          <span id="bgm-goal-label">Plan</span>
          <input type="text" id="bgm-goal-input" placeholder="e.g. rebuild through picks and cap space">
        </div>
        <div id="bgm-aux-row">
          <label class="bgm-switch" title="Explain the reasoning and what to learn from each move">
            <input type="checkbox" id="bgm-learning-toggle">
            <span class="bgm-switch-ui"></span>
            <span class="bgm-switch-label">Learning</span>
          </label>
          <div id="bgm-cache-status">Fresh</div>
        </div>
      </div>
      <div id="bgm-settings-panel">
        <label class="bgm-setting-label">OpenRouter API Key</label>
        <input type="password" id="bgm-api-key-input" placeholder="sk-or-…">
        <button id="bgm-save-settings">Save Key</button>
        <div id="bgm-api-status"></div>
      </div>
    </div>
    <div id="bgm-chat-area">
      <div class="bgm-message system"><div class="bgm-bubble">Load a league page, set a plan, and ask away. This version is tuned for OpenRouter + DeepSeek V3 0324, uses leaner prompts, and caches repeated questions.</div></div>
    </div>
    <div id="bgm-quick-actions">
      <button class="bgm-quick-btn" data-prompt="Give me a brief roster diagnosis based on our plan.">🏀 Roster check</button>
      <button class="bgm-quick-btn" data-prompt="What is the best action for today based on our plan and current page?">📍 Next move</button>
      <button class="bgm-quick-btn" data-prompt="What trade targets actually fit our plan, and how likely are they to be available?">🔄 Trade targets</button>
      <button class="bgm-quick-btn" data-prompt="Break down our cap situation, bad money, and flexibility.">💰 Cap outlook</button>
      <button class="bgm-quick-btn" data-prompt="Which free agents fit our plan right now, with exact contract suggestions?">🎯 Free agents</button>
      <button class="bgm-quick-btn" data-prompt="Tell me the biggest problems you see right now and what order I should fix them in.">🚨 Biggest issues</button>
    </div>
    <div id="bgm-input-area">
      <div id="bgm-input-row">
        <textarea id="bgm-user-input" placeholder="Ask your assistant GM…" rows="1"></textarea>
        <button id="bgm-send-btn">↑</button>
      </div>
      <div id="bgm-input-hint">Enter to send · Shift+Enter for new line</div>
    </div>`;

  const tab = document.createElement('button');
  tab.id = 'bgm-toggle-tab';
  tab.textContent = 'GM';

  document.body.appendChild(panel);
  document.body.appendChild(tab);

  const chatArea = panel.querySelector('#bgm-chat-area');
  const userInput = panel.querySelector('#bgm-user-input');
  const sendBtn = panel.querySelector('#bgm-send-btn');
  const goalInput = panel.querySelector('#bgm-goal-input');
  const settingsPanel = panel.querySelector('#bgm-settings-panel');
  const apiKeyInput = panel.querySelector('#bgm-api-key-input');
  const apiStatus = panel.querySelector('#bgm-api-status');
  const subtitle = panel.querySelector('#bgm-subtitle');
  const ctxTeam = panel.querySelector('#bgm-ctx-team');
  const ctxSeason = panel.querySelector('#bgm-ctx-season');
  const ctxCap = panel.querySelector('#bgm-ctx-cap');
  const ctxPage = panel.querySelector('#bgm-ctx-page');
  const learningToggle = panel.querySelector('#bgm-learning-toggle');
  const cacheStatus = panel.querySelector('#bgm-cache-status');

  function getLeagueId() {
    const m = location.pathname.match(/\/l\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function chatStorageKey(leagueId) {
    return `${STORAGE_PREFIX}:chat:${leagueId || 'global'}`;
  }

  function planStorageKey(leagueId) {
    return `${STORAGE_PREFIX}:plan:${leagueId || 'global'}`;
  }

  function rejectedPlansKey(leagueId) {
    return `${STORAGE_PREFIX}:rejectedPlans:${leagueId || 'global'}`;
  }

  function learningModeKey(leagueId) {
    return `${STORAGE_PREFIX}:learning:${leagueId || 'global'}`;
  }

  function responseCacheKey(leagueId) {
    return `${STORAGE_PREFIX}:cache:${leagueId || 'global'}`;
  }

  async function loadPersistentState() {
    const leagueId = getLeagueId();
    const keys = [
      'apiKey',
      'involvementLevel',
      chatStorageKey(leagueId),
      planStorageKey(leagueId),
      rejectedPlansKey(leagueId),
      learningModeKey(leagueId),
      responseCacheKey(leagueId)
    ];
    const result = await browser.storage.local.get(keys);

    if (result.apiKey) {
      apiKey = result.apiKey;
      apiKeyInput.value = result.apiKey;
      apiStatus.textContent = '✓ Key saved';
      apiStatus.className = 'ok';
    }
    if (result.involvementLevel != null) {
      involvementLevel = result.involvementLevel;
      updateModes();
    }

    const storedPlan = result[planStorageKey(leagueId)] || '';
    userGoal = storedPlan;
    goalInput.value = storedPlan;

    chatHistory = Array.isArray(result[chatStorageKey(leagueId)]) ? result[chatStorageKey(leagueId)] : [];
    rejectedPlanCandidates = Array.isArray(result[rejectedPlansKey(leagueId)]) ? result[rejectedPlansKey(leagueId)] : [];
    learningMode = !!result[learningModeKey(leagueId)];
    learningToggle.checked = learningMode;
    responseCache = result[responseCacheKey(leagueId)] || {};
    updateCacheStatus('Fresh');

    renderChatHistory();
  }

  function saveChatHistory() {
    const leagueId = getLeagueId();
    return browser.storage.local.set({ [chatStorageKey(leagueId)]: chatHistory.slice(-CHAT_LIMIT) });
  }

  function saveGoal() {
    const leagueId = getLeagueId();
    return browser.storage.local.set({ [planStorageKey(leagueId)]: userGoal });
  }

  function saveRejectedPlans() {
    const leagueId = getLeagueId();
    return browser.storage.local.set({ [rejectedPlansKey(leagueId)]: rejectedPlanCandidates.slice(-10) });
  }

  function saveLearningMode() {
    const leagueId = getLeagueId();
    return browser.storage.local.set({ [learningModeKey(leagueId)]: learningMode });
  }

  function saveResponseCache() {
    const leagueId = getLeagueId();
    const entries = Object.entries(responseCache).sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)).slice(0, RESPONSE_CACHE_LIMIT);
    responseCache = Object.fromEntries(entries);
    return browser.storage.local.set({ [responseCacheKey(leagueId)]: responseCache });
  }

  function updateCacheStatus(text, tone) {
    if (!cacheStatus) return;
    cacheStatus.textContent = text;
    cacheStatus.className = tone ? tone : '';
  }

  function togglePanel() {
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    const w = panel.offsetWidth || 340;
    tab.style.right = panelOpen ? w + 'px' : '0';
    if (panelOpen) {
      refreshContext();
      setTimeout(() => userInput.focus(), 100);
    }
  }

  tab.addEventListener('click', togglePanel);
  panel.querySelector('#bgm-close-btn').addEventListener('click', togglePanel);
  browser.runtime.onMessage.addListener(msg => {
    if (msg.type === 'TOGGLE_PANEL') togglePanel();
  });

  function updateModes() {
    panel.querySelectorAll('.bgm-mode-btn').forEach((b, i) => b.classList.toggle('active', i === involvementLevel));
  }

  panel.querySelectorAll('.bgm-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      involvementLevel = parseInt(btn.dataset.mode, 10);
      updateModes();
      browser.storage.local.set({ involvementLevel });
    });
  });

  panel.querySelector('#bgm-settings-toggle').addEventListener('click', () => settingsPanel.classList.toggle('open'));

  panel.querySelector('#bgm-save-settings').addEventListener('click', () => {
    const key = apiKeyInput.value.trim();
    if (!key) {
      apiStatus.textContent = '✗ Enter an OpenRouter key';
      apiStatus.className = 'err';
      return;
    }
    apiKey = key;
    browser.storage.local.set({ apiKey: key });
    apiStatus.textContent = '✓ Saved';
    apiStatus.className = 'ok';
    settingsPanel.classList.remove('open');
  });

  goalInput.addEventListener('change', async () => {
    userGoal = goalInput.value.trim();
    await saveGoal();
  });

  learningToggle.addEventListener('change', async () => {
    learningMode = !!learningToggle.checked;
    await saveLearningMode();
  });

  panel.querySelector('#bgm-clear-btn').addEventListener('click', async () => {
    chatHistory = [];
    chatArea.innerHTML = '';
    appendMsg('system', 'Chat cleared for this league.');
    await saveChatHistory();
  });

  panel.querySelectorAll('.bgm-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      userInput.value = btn.dataset.prompt;
      sendMessage();
    });
  });

  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 90) + 'px';
  });

  userInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sendBtn.addEventListener('click', sendMessage);

  const resizer = panel.querySelector('#bgm-panel-resizer');
  let resizing = false;
  resizer.addEventListener('mousedown', e => {
    resizing = true;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const w = window.innerWidth - e.clientX;
    if (w >= 260 && w <= 640) {
      panel.style.width = w + 'px';
      if (panelOpen) tab.style.right = w + 'px';
    }
  });
  document.addEventListener('mouseup', () => {
    resizing = false;
  });

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function formatMessageHtml(text) {
    const safe = escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\n)-\s+(.+?)(?=\n|$)/g, '$1• $2')
      .replace(/\n/g, '<br>');
    return safe;
  }

  function createMessageNode(role, text) {
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
    bub.innerHTML = formatMessageHtml(text);
    wrap.appendChild(bub);
    return { wrap, bubble: bub };
  }

  function appendMsg(role, text) {
    const { wrap, bubble } = createMessageNode(role, text);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
    return bubble;
  }

  function renderChatHistory() {
    chatArea.innerHTML = '';
    if (!chatHistory.length) {
      appendMsg('system', 'Load a league page, set a plan, and ask away. This version is tuned for OpenRouter + DeepSeek V3 0324, uses leaner prompts, and caches repeated questions.');
      return;
    }
    for (const msg of chatHistory) appendMsg(msg.role, msg.content);
  }

  function showTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'bgm-message assistant';
    wrap.id = 'bgm-typing';
    const lbl = document.createElement('div');
    lbl.className = 'bgm-msg-label';
    lbl.textContent = 'Assistant GM';
    const bub = document.createElement('div');
    bub.className = 'bgm-bubble';
    const ind = document.createElement('div');
    ind.className = 'bgm-typing';
    [0, 1, 2].forEach(() => {
      const d = document.createElement('div');
      d.className = 'bgm-dot';
      ind.appendChild(d);
    });
    bub.appendChild(ind);
    wrap.appendChild(lbl);
    wrap.appendChild(bub);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function hideTyping() {
    const el = document.getElementById('bgm-typing');
    if (el) el.remove();
  }

  async function streamAssistantMessage(text) {
    const { wrap, bubble } = createMessageNode('assistant', '');
    bubble.innerHTML = '';
    chatArea.appendChild(wrap);
    let visible = '';
    const parts = text.split(/(\s+)/);
    for (let i = 0; i < parts.length; i++) {
      visible += parts[i];
      bubble.innerHTML = formatMessageHtml(visible);
      chatArea.scrollTop = chatArea.scrollHeight;
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, 12));
    }
    return bubble;
  }

  function getPageType() {
    const p = location.pathname;
    if (p.includes('/trade_proposals')) return 'trade_proposals';
    if (p.includes('/trade')) return 'trade';
    if (p.includes('/roster')) return 'roster';
    if (p.includes('/finances')) return 'finances';
    if (p.includes('/draft')) return 'draft';
    if (p.includes('/free_agents')) return 'free_agents';
    if (p.includes('/standings')) return 'standings';
    if (p.includes('/schedule')) return 'schedule';
    if (p.includes('/player/')) return 'player';
    return 'other';
  }

  function getPageContent() {
    const tables = [...document.querySelectorAll('table')].map(t => {
      const h = [...t.querySelectorAll('th')].map(x => x.innerText.trim()).join(' | ');
      const r = [...t.querySelectorAll('tr')].slice(0, 35).map(row =>
        [...row.querySelectorAll('td')].map(c => c.innerText.trim()).join(' | ')
      ).filter(Boolean).join('\n');
      return h ? h + '\n' + r : r;
    }).filter(Boolean).join('\n\n');
    const alerts = [...document.querySelectorAll('.alert,.bg-danger,.bg-warning,.bg-success')]
      .map(a => a.innerText.trim())
      .filter(Boolean)
      .join('\n');
    const heading = document.querySelector('h1,h2')?.innerText?.trim() || '';
    return { tables, alerts, heading };
  }

  async function openDB(id) {
    return new Promise((res, rej) => {
      const req = indexedDB.open('league' + id);
      req.onsuccess = e => res(e.target.result);
      req.onerror = e => rej(e.target.error);
    });
  }

  async function dbGetAll(db, store) {
    return new Promise(res => {
      try {
        const req = db.transaction([store], 'readonly').objectStore(store).getAll();
        req.onsuccess = e => res(e.target.result);
        req.onerror = () => res([]);
      } catch {
        res([]);
      }
    });
  }

  function latestRatings(player, season) {
    if (!player.ratings?.length) return null;
    return [...player.ratings].sort((a, b) => b.season - a.season).find(r => r.season <= season) || player.ratings[player.ratings.length - 1];
  }

  function latestRegularSeasonStats(player, season) {
    if (!player.stats?.length) return null;
    const exact = [...player.stats].filter(s => s.season === season && !s.playoffs).pop();
    if (exact?.gp > 0) return exact;
    const prev = [...player.stats].filter(s => s.season === season - 1 && !s.playoffs).pop();
    return prev?.gp > 0 ? prev : null;
  }

  function summarise(player, season) {
    const r = latestRatings(player, season);
    if (!r) return null;
    const stat = latestRegularSeasonStats(player, season);
    return {
      pid: player.pid,
      tid: player.tid,
      name: player.firstName + ' ' + player.lastName,
      pos: r.pos || player.pos,
      age: season - player.born.year,
      ovr: r.ovr,
      pot: r.pot,
      skills: r.skills || [],
      contract: player.contract ? {
        amount: player.contract.amount,
        exp: player.contract.exp,
        yrs: Math.max(0, player.contract.exp - season + 1)
      } : null,
      injury: player.injury?.type && player.injury.type !== 'Healthy' ? player.injury.type : null,
      stats: stat ? {
        season: stat.season,
        gp: stat.gp,
        min: stat.min ? Number((stat.min / stat.gp).toFixed(1)) : null,
        pts: stat.pts ? Number((stat.pts / stat.gp).toFixed(1)) : null,
        reb: (stat.drb || stat.orb) ? Number((((stat.drb || 0) + (stat.orb || 0)) / stat.gp).toFixed(1)) : null,
        ast: stat.ast ? Number((stat.ast / stat.gp).toFixed(1)) : null,
        per: stat.per ? Number(stat.per.toFixed(1)) : null,
        ws: stat.ws ? Number(stat.ws.toFixed(1)) : null,
        ewa: stat.ewa ? Number(stat.ewa.toFixed(1)) : null
      } : null
    };
  }

  function scoreAsset(player) {
    const contractPenalty = player.contract ? (player.contract.amount / 2000) * Math.max(1, player.contract.yrs || 1) : 0;
    const youthBonus = Math.max(0, 25 - player.age) * 0.9;
    const potentialBonus = Math.max(0, player.pot - player.ovr) * 0.7;
    const productionBonus = player.stats?.per ? Math.max(0, player.stats.per - 12) * 0.9 : 0;
    return Number((player.ovr * 1.5 + youthBonus + potentialBonus + productionBonus - contractPenalty).toFixed(1));
  }

  function summarizeTeamWindow(teamPlayers) {
    if (!teamPlayers.length) return 'unknown';
    const avgAge = teamPlayers.reduce((s, p) => s + p.age, 0) / teamPlayers.length;
    const avgOvrTop5 = teamPlayers.slice(0, 5).reduce((s, p) => s + p.ovr, 0) / Math.max(1, Math.min(5, teamPlayers.length));
    if (avgOvrTop5 >= 63 && avgAge >= 27) return 'win-now';
    if (avgAge <= 24.5) return 'youth';
    return 'mixed';
  }

  async function buildContext(leagueId) {
    const db = await openDB(leagueId);
    const [attrs, players, teams, picks] = await Promise.all([
      dbGetAll(db, 'gameAttributes'),
      dbGetAll(db, 'players'),
      dbGetAll(db, 'teams'),
      dbGetAll(db, 'draftPicks')
    ]);

    const ga = Object.fromEntries(attrs.map(a => [a.key, a.value]));
    const season = ga.season || new Date().getFullYear();
    const userTid = Array.isArray(ga.userTid) ? ga.userTid[ga.userTid.length - 1].value : ga.userTid;
    const activeTeams = teams.filter(t => !t.disabled);
    const teamMap = new Map(activeTeams.map(t => [t.tid, t]));
    const myTeam = teamMap.get(userTid);

    const allPlayers = players
      .filter(p => p.tid !== -3 && p.tid !== -2)
      .map(p => summarise(p, season))
      .filter(Boolean);

    const playersByTid = new Map();
    for (const p of allPlayers) {
      if (!playersByTid.has(p.tid)) playersByTid.set(p.tid, []);
      playersByTid.get(p.tid).push(p);
    }
    for (const list of playersByTid.values()) list.sort((a, b) => b.ovr - a.ovr || b.pot - a.pot);

    const roster = (playersByTid.get(userTid) || []).slice().sort((a, b) => b.ovr - a.ovr);
    const fas = (playersByTid.get(-1) || []).slice().sort((a, b) => b.ovr - a.ovr).slice(0, 30);

    const myPicks = picks.filter(p => p.tid === userTid).map(p => ({
      season: p.season,
      round: p.round,
      isOwn: p.originalTid === userTid,
      orig: p.originalTid === userTid ? (myTeam?.abbrev || 'OWN') : (teamMap.get(p.originalTid)?.abbrev || 'T' + p.originalTid)
    })).sort((a, b) => a.season - b.season || a.round - b.round);

    const teamSummaries = activeTeams.map(team => {
      const teamPlayers = (playersByTid.get(team.tid) || []).slice().sort((a, b) => b.ovr - a.ovr);
      const payroll = teamPlayers.reduce((s, p) => s + (p.contract?.amount || 0), 0);
      const topPlayers = teamPlayers.slice(0, 6).map(p => ({
        name: p.name,
        pos: p.pos,
        age: p.age,
        ovr: p.ovr,
        pot: p.pot,
        contract: p.contract,
        stats: p.stats,
        assetScore: scoreAsset(p)
      }));
      const tradeTargets = teamPlayers
        .filter(p => p.contract && p.ovr >= 45)
        .map(p => ({ ...p, assetScore: scoreAsset(p) }))
        .sort((a, b) => a.assetScore - b.assetScore)
        .slice(0, 6);
      return {
        tid: team.tid,
        abbrev: team.abbrev,
        name: team.region + ' ' + team.name,
        strategy: team.strategy || 'unknown',
        payroll,
        rosterCount: teamPlayers.length,
        topPlayers,
        tradeTargets,
        teamWindow: summarizeTeamWindow(teamPlayers)
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const payroll = roster.reduce((s, p) => s + (p.contract?.amount || 0), 0);

    return {
      season,
      userTid,
      teamName: myTeam ? myTeam.region + ' ' + myTeam.name : 'Unknown',
      teamAbbrev: myTeam?.abbrev || '???',
      strategy: myTeam?.strategy || 'unknown',
      cap: {
        salaryCap: ga.salaryCap,
        luxury: ga.luxuryPayroll,
        min: ga.minPayroll,
        type: ga.salaryCapType,
        payroll
      },
      roster,
      fas,
      myPicks,
      teamSummaries
    };
  }

  function updateBar(gc, pageType) {
    if (!gc) return;
    subtitle.textContent = gc.teamName;
    ctxTeam.textContent = gc.teamAbbrev;
    ctxSeason.textContent = gc.season;
    ctxPage.textContent = pageType;
    if (gc.cap) {
      ctxCap.textContent = '$' + Math.round(gc.cap.payroll / 1000) + 'M';
      ctxCap.className = gc.cap.payroll > gc.cap.luxury ? 'bgm-strip-value danger' : 'bgm-strip-value';
    }
  }

  async function refreshContext() {
    const id = getLeagueId();
    if (!id) return;
    try {
      const gc = await buildContext(id);
      gameContext = { gc, pageType: getPageType(), page: getPageContent() };
      updateBar(gc, getPageType());
    } catch (e) {
      console.warn('BGM Assistant context error:', e);
    }
  }

  function topRosterSlice(roster) {
    const core = roster.slice(0, 10);
    const badMoney = roster.filter(p => (p.contract?.amount || 0) >= 18000 && !core.find(c => c.pid === p.pid)).slice(0, 3);
    const injured = roster.filter(p => p.injury && !core.find(c => c.pid === p.pid) && !badMoney.find(c => c.pid === p.pid)).slice(0, 2);
    return [...core, ...badMoney, ...injured].slice(0, 14);
  }

  function inferPlanDirection(text) {
    const t = (text || '').toLowerCase();
    if (/rebuild|young|picks|tank|future/.test(t)) return 'rebuild';
    if (/contend|win now|title|championship|playoff/.test(t)) return 'contend';
    if (/dump salary|cap space|flexibility/.test(t)) return 'flex';
    return 'balanced';
  }

  function shortlistLeagueTeams(gc) {
    const direction = inferPlanDirection(userGoal);
    const teams = gc.teamSummaries.filter(t => t.tid !== gc.userTid);
    const scored = teams.map(team => {
      let score = 0;
      if (gameContext?.pageType?.includes('trade')) score += 8;
      if (direction === 'rebuild' && (team.teamWindow === 'win-now' || team.strategy === 'contending')) score += 6;
      if (direction === 'contend' && (team.teamWindow === 'youth' || team.strategy === 'rebuilding')) score += 6;
      if (direction === 'flex' && team.payroll > gc.cap.salaryCap) score += 5;
      score += Math.max(0, 16 - Math.abs(team.payroll - gc.cap.payroll) / 4000);
      return { team, score };
    }).sort((a, b) => b.score - a.score);
    return scored.slice(0, 10).map(x => x.team);
  }

  function buildCacheFingerprint(question) {
    const gc = gameContext?.gc;
    if (!gc) return `nogame|${involvementLevel}|${learningMode}|${userGoal}|${question}`;
    const rosterStamp = gc.roster.slice(0, 8).map(p => `${p.pid}:${p.ovr}:${p.pot}:${p.contract?.amount || 0}`).join(',');
    const pageStamp = `${gameContext.pageType}|${(gameContext.page?.heading || '').slice(0, 80)}|${(gameContext.page?.alerts || '').slice(0, 120)}`;
    return [gc.userTid, gc.season, involvementLevel, learningMode ? 1 : 0, userGoal || '-', pageStamp, rosterStamp, question.trim().toLowerCase()].join('|');
  }
  function buildRecentConversationBlock() {
    const recent = chatHistory.slice(-8);
    if (!recent.length) return '=== RECENT CHAT ===\n- none\n';
    const lines = recent.map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
    return `=== RECENT CHAT ===\n${lines.join('\n')}\n`;
  }

  function buildPlanStateBlock() {
    const activePlan = userGoal ? userGoal : 'No active plan set.';
    const rejected = rejectedPlanCandidates.length ? rejectedPlanCandidates.map(p => `- ${p}`).join('\n') : '- none';
    return `=== ACTIVE PLAN ===\n${activePlan}\n\n=== PLAN GOVERNANCE ===\nRejected replacement plans (do not repeat these unless the user asks):\n${rejected}\n`;
  }

  function buildLeagueContextBlock(gc) {
    const lines = [];
    for (const team of shortlistLeagueTeams(gc)) {
      const top = team.topPlayers.slice(0, 3).map(p => `${p.name} (${p.ovr}/${p.pot}, ${p.age})`).join(', ');
      const targets = team.tradeTargets.slice(0, 2).map(p => `${p.name} (${p.ovr}/${p.pot}, $${Math.round((p.contract?.amount || 0) / 1000)}M)`).join(', ');
      lines.push(`${team.abbrev} | ${team.strategy} | ${team.teamWindow} | payroll $${Math.round(team.payroll / 1000)}M | roster ${team.rosterCount}/18 | top ${top || 'none'} | cheaper targets ${targets || 'none'}`);
    }
    return lines.join('\n');
  }

  function buildFullRosterNamesBlock(gc) {
    if (!gc?.roster?.length) return '=== FULL ROSTER NAMES ===\n- none\n';
    const names = gc.roster
      .map(p => `${p.name} (${p.pos}, ${p.ovr}/${p.pot}, $${Math.round((p.contract?.amount || 0) / 1000)}M)`)
      .join('\n');
    return `=== FULL ROSTER NAMES (${gc.roster.length}/18) ===\n${names}\n`;
  }

  function buildPrompt(lastUserText) {
    const mode = MODES[involvementLevel];
    let p = `${SYSTEM}\n\n`;
    p += `CURRENT MODE: ${mode.label}\nMODE BEHAVIOR: ${mode.prompt}\nLEARNING MODE: ${learningMode ? 'ON' : 'OFF'}\n\n`;
    p += buildPlanStateBlock() + '\n';
    p += buildRecentConversationBlock() + '\n';

    const gc = gameContext?.gc;
    if (!gc) {
      p += 'No live data available. Be cautious and state limits clearly.\n';
      return p;
    }

    p += '=== GAME STATE ===\n';
    p += `Team: ${gc.teamName} (${gc.teamAbbrev}) | Season: ${gc.season} | Strategy: ${gc.strategy}\n`;
    p += `Page: ${gameContext.pageType}\n\n`;

    const c = gc.cap;
    p += '=== CAP ===\n';
    p += `Cap: $${Math.round(c.salaryCap / 1000)}M | Luxury: $${Math.round(c.luxury / 1000)}M | Min: $${Math.round(c.min / 1000)}M\n`;
    p += `Payroll: $${Math.round(c.payroll / 1000)}M | Space under cap: $${Math.round(Math.max(0, c.salaryCap - c.payroll) / 1000)}M | Type: ${c.type}\n\n`;

    const rosterSlice = topRosterSlice(gc.roster);
    p += `=== MY ROSTER (${gc.roster.length}/18 players, showing ${rosterSlice.length}) ===\n`;
    for (const pl of rosterSlice) {
      const ct = pl.contract ? `$${Math.round(pl.contract.amount / 1000)}M/${pl.contract.yrs}yr` : 'no contract';
      const inj = pl.injury ? ` [${pl.injury}]` : '';
      const st = pl.stats ? ` | ${pl.stats.pts ?? '-'} pts ${pl.stats.reb ?? '-'} reb ${pl.stats.ast ?? '-'} ast PER ${pl.stats.per ?? '-'}` : '';
      p += `${pl.name} | ${pl.pos} | Age ${pl.age} | OVR ${pl.ovr} POT ${pl.pot} | ${ct}${inj}${st}\n`;
    }

    p += '\n' + buildFullRosterNamesBlock(gc) + '\n';

    p += '=== MY PICKS ===\n';
    if (!gc.myPicks.length) {
      p += 'No picks currently tracked.\n';
    } else {
      const bySeason = {};
      for (const pk of gc.myPicks) (bySeason[pk.season] = bySeason[pk.season] || []).push(pk);
      for (const [yr, seasonPicks] of Object.entries(bySeason)) {
        const r1 = seasonPicks.filter(x => x.round === 1).map(x => x.isOwn ? 'OWN' : x.orig).join(', ');
        const r2 = seasonPicks.filter(x => x.round === 2).map(x => x.isOwn ? 'OWN' : x.orig).join(', ');
        p += `${yr}: ${(r1 ? `R1(${r1}) ` : '')}${(r2 ? `R2(${r2})` : '')}\n`;
      }
    }

    p += '\n=== TOP FREE AGENTS ===\n';
    for (const pl of gc.fas.slice(0, 10)) {
      const ask = pl.contract ? `$${Math.round(pl.contract.amount / 1000)}M` : '?';
      p += `${pl.name} | ${pl.pos} | Age ${pl.age} | OVR ${pl.ovr} POT ${pl.pot} | asking ${ask}\n`;
    }

    const pg = gameContext.page;
    if (pg?.tables || pg?.alerts || pg?.heading) {
      p += `\n=== CURRENT PAGE (${gameContext.pageType}) ===\n`;
      if (pg.heading) p += pg.heading + '\n';
      if (pg.alerts) p += 'Alerts: ' + pg.alerts + '\n';
      if (pg.tables) p += pg.tables.slice(0, 2200) + (pg.tables.length > 2200 ? '\n[truncated]' : '') + '\n';
    }

    p += '\n=== LEAGUE SNAPSHOT ===\n';
    p += buildLeagueContextBlock(gc) + '\n';

    p += '\n=== RESPONSE PRIORITIES ===\n';
    p += '- Respect the active plan first.\n';
    p += '- Basketball GM roster limit is 18 players.\n';
    p += '- If discussing trades, use payroll, roster count, team strategy, and player value together.\n';
    p += '- If a specific legal conclusion cannot be confirmed, say legality uncertain.\n';
    p += '- Avoid repeating the full context back to the user.\n';
    p += '- If you propose a trade, prefer one clean framework with likely logic, not multiple lottery tickets.\n';
    p += '- When learning mode is ON, explain the basketball principle briefly at the end.\n';
    p += `- User just asked: ${lastUserText}\n`;

    return p;
  }

  async function callOpenRouter(lastUserText) {
    if (!apiKey) throw new Error('No API key — click ⚙ to add your OpenRouter key.');
    const messages = [
      { role: 'system', content: buildPrompt(lastUserText) },
      ...chatHistory.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
    ];
    const body = {
      model: DEFAULT_MODEL,
      messages,
      temperature: involvementLevel === 0 ? 0.25 : 0.4,
      max_tokens: learningMode ? 850 : 575,
      stream: false
    };
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://play.basketball-gm.com',
        'X-OpenRouter-Title': 'BGM Assistant'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error?.message || 'API error ' + res.status);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty response from OpenRouter');
    return text;
  }

  function parsePlanCandidate(text) {
    const match = text.match(new RegExp(`${PLAN_MARKER}\\s*(.+)$`, 'm'));
    return match ? match[1].trim() : '';
  }

  function stripPlanMarker(text) {
    return text.replace(new RegExp(`\\n?${PLAN_MARKER}\\s*.+$`, 'm'), '').trim();
  }

  function addPlanDecisionUI(candidate) {
    const wrap = document.createElement('div');
    wrap.className = 'bgm-message system';
    const bubble = document.createElement('div');
    bubble.className = 'bgm-bubble bgm-plan-prompt';
    bubble.innerHTML = `${formatMessageHtml(`**Suggested plan change:** ${candidate}`)}<br><br>`;

    const actions = document.createElement('div');
    actions.className = 'bgm-plan-actions';

    const yesBtn = document.createElement('button');
    yesBtn.className = 'bgm-mini-btn';
    yesBtn.textContent = 'Use this plan';
    yesBtn.addEventListener('click', async () => {
      userGoal = candidate;
      goalInput.value = candidate;
      pendingPlanCandidate = '';
      await saveGoal();
      appendMsg('system', `Plan updated to: **${candidate}**`);
    });

    const noBtn = document.createElement('button');
    noBtn.className = 'bgm-mini-btn secondary';
    noBtn.textContent = 'Keep current plan';
    noBtn.addEventListener('click', async () => {
      pendingPlanCandidate = '';
      rejectedPlanCandidates.push(candidate);
      await saveRejectedPlans();
      appendMsg('system', 'Kept the current plan. The assistant will follow it and stop pushing that replacement.');
    });

    actions.appendChild(yesBtn);
    actions.appendChild(noBtn);
    bubble.appendChild(actions);
    wrap.appendChild(bubble);
    chatArea.appendChild(wrap);
    chatArea.scrollTop = chatArea.scrollHeight;
  }

  function isYes(text) {
    return /^(yes|yep|yeah|sure|do it|okay|ok)$/i.test(text.trim());
  }

  function isNo(text) {
    return /^(no|nah|nope|keep it|don'?t|do not)$/i.test(text.trim());
  }

  async function sendMessage() {
    const text = userInput.value.trim();
    if (!text) return;

    const now = Date.now();
    if (now - lastRequestAt < REQUEST_COOLDOWN_MS) {
      appendMsg('system', `Give it a second — cooldown is ${Math.ceil((REQUEST_COOLDOWN_MS - (now - lastRequestAt)) / 1000)}s so you do not burn requests by accident.`);
      return;
    }

    userInput.value = '';
    userInput.style.height = 'auto';
    sendBtn.disabled = true;

    appendMsg('user', text);
    chatHistory.push({ role: 'user', content: text });
    await saveChatHistory();

    if (pendingPlanCandidate && isYes(text)) {
      userGoal = pendingPlanCandidate;
      goalInput.value = pendingPlanCandidate;
      const accepted = pendingPlanCandidate;
      pendingPlanCandidate = '';
      await saveGoal();
      const reply = `Got it. **Active plan updated:** ${accepted}`;
      await streamAssistantMessage(reply);
      chatHistory.push({ role: 'assistant', content: reply });
      await saveChatHistory();
      sendBtn.disabled = false;
      userInput.focus();
      return;
    }

    if (pendingPlanCandidate && isNo(text)) {
      rejectedPlanCandidates.push(pendingPlanCandidate);
      await saveRejectedPlans();
      pendingPlanCandidate = '';
      const reply = 'Understood. I will follow the current plan and stop pushing that replacement unless you ask.';
      await streamAssistantMessage(reply);
      chatHistory.push({ role: 'assistant', content: reply });
      await saveChatHistory();
      sendBtn.disabled = false;
      userInput.focus();
      return;
    }

    showTyping();
    let cached = null;
    try {
      await refreshContext();
      const cacheKey = buildCacheFingerprint(text);
      cached = responseCache[cacheKey];
      let rawReply;
      if (cached) {
        updateCacheStatus('Cached reply', 'ok');
        rawReply = cached.reply;
      } else {
        updateCacheStatus('Live call', 'live');
        lastRequestAt = Date.now();
        rawReply = await callOpenRouter(text);
        responseCache[cacheKey] = { reply: rawReply, ts: Date.now() };
        await saveResponseCache();
      }
      hideTyping();
      const candidate = parsePlanCandidate(rawReply);
      const reply = stripPlanMarker(rawReply);
      if (candidate && !rejectedPlanCandidates.includes(candidate)) {
        pendingPlanCandidate = candidate;
      } else {
        pendingPlanCandidate = '';
      }
      await streamAssistantMessage(reply);
      chatHistory.push({ role: 'assistant', content: reply });
      if (chatHistory.length > CHAT_LIMIT) chatHistory = chatHistory.slice(-CHAT_LIMIT);
      await saveChatHistory();
      if (pendingPlanCandidate) addPlanDecisionUI(pendingPlanCandidate);
      if (!cached) updateCacheStatus('Fresh', 'ok');
    } catch (e) {
      hideTyping();
      chatHistory.pop();
      await saveChatHistory();
      updateCacheStatus('Error', 'err');
      const wrap = document.createElement('div');
      wrap.className = 'bgm-message error';
      const b = document.createElement('div');
      b.className = 'bgm-bubble';
      b.textContent = '✗ ' + e.message;
      wrap.appendChild(b);
      chatArea.appendChild(wrap);
      chatArea.scrollTop = chatArea.scrollHeight;
    }
    sendBtn.disabled = false;
    userInput.focus();
  }

  refreshContext();
  loadPersistentState();

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (panelOpen) refreshContext();
      loadPersistentState();
    }
  }).observe(document.body, { childList: true, subtree: true });
})();
