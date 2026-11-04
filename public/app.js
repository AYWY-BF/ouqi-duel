const app = document.getElementById('app');
const fx = document.getElementById('fx');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');

const params = new URLSearchParams(window.location.search);
const SHARE_PARAM = 'sharecode';
const SHARE_STORAGE = 'luck:sharecode';

// 托管平台会给访问链接加一个访问码（?sharecode=xxx），缺了它新访客会被挡在门外。
// 记下它，拼邀请链接和切换地址时都带上，保证群里的人点开就能进。
function readShareCode() {
  const fromUrl = params.get(SHARE_PARAM) || params.get('shareCode') || '';
  if (fromUrl) {
    try {
      localStorage.setItem(SHARE_STORAGE, fromUrl);
    } catch {}
    return fromUrl;
  }
  return readStorage(SHARE_STORAGE) || '';
}

const shareCode = readShareCode();

function withShareCode(url) {
  if (!shareCode) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${SHARE_PARAM}=${encodeURIComponent(shareCode)}`;
}

const REACTIONS = ['😂', '🍋', '🔥', '👑', '😭', '🤝'];
const ROUND_THEMES = [
  { kicker: 'ROUND 01 · 热身局', line1: '随手一抽，', line2: '试试今天的手气' },
  { kicker: 'ROUND 02 · 加倍局', line1: '欧气翻倍，', line2: '要追分就现在' },
  { kicker: 'ROUND 03 · 决胜局', line1: '最后一抽，', line2: '欧皇还是非酋？' },
];

let roomCode = '';
let token = '';
let state = null;
let nickname = readStorage('luck:nickname') || '';
let serverOffset = 0;
let pollTimer = null;
let pollGeneration = 0;
let polling = false;
let lastPollAt = 0;
let interaction = false;
let interactionTimer = null;
let pendingRender = false;
let reactionReady = false;
let seenReactions = new Set();
let lastSig = '';
let lastRenderPhase = '';
let lastRenderRound = 0;
let lastMeDrawn = false;
let lastMeValue = 0;
let lastScreenKey = '';
let lastNetworkToast = 0;
let lastFocused = null;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function readStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return '';
  }
}

function writeStorage(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode can reject storage */
  }
}

function removeStorage(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function tokenKey(code) {
  return `luck:token:${code}`;
}

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
}

function codeFromLocation() {
  const match = window.location.pathname.match(/^\/r\/([^/]+)\/?$/);
  return normalizeCode(match?.[1] || params.get('room') || '');
}

function roomUrl() {
  return withShareCode(`${window.location.origin}/r/${roomCode}`);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

function gradientOf(player) {
  const colors = Array.isArray(player?.gradient) && player.gradient.length === 2
    ? player.gradient
    : ['#ffb86b', '#ff6b9d'];
  return `background:linear-gradient(135deg, ${esc(colors[0])}, ${esc(colors[1])})`;
}

function avatarOf(player, className = '') {
  return `<span class="${className}" style="${gradientOf(player)}">${esc(player?.avatar || '🦊')}</span>`;
}

async function api(path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth !== false && token) headers['x-player-token'] = token;

  // 没有超时的话，一个卡住的请求会把轮询循环永远挂起，界面就再也不刷新了。
  const controller = new AbortController();
  const timeoutMs = options.timeout || (options.method && options.method !== 'GET' ? 15000 : 10000);
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    window.clearTimeout(timer);
    const wrapped = new Error(error?.name === 'AbortError' ? '网络有点慢，正在重试…' : '网络开小差了，检查一下连接？');
    wrapped.status = 0;
    wrapped.aborted = error?.name === 'AbortError';
    throw wrapped;
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* non-json error */
  } finally {
    window.clearTimeout(timer);
  }

  if (!response.ok) {
    const error = new Error(data?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message, duration = 2400) {
  if (!message) return;
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  while (toastRoot.children.length >= 2) toastRoot.firstElementChild.remove();
  toastRoot.append(node);
  window.setTimeout(() => {
    node.classList.add('is-out');
    window.setTimeout(() => node.remove(), 240);
  }, duration);
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function setSubmitBusy(form, busy) {
  if (!form) return;
  if (busy) form.dataset.busy = '1';
  else delete form.dataset.busy;
  const button = form.querySelector('button[type="submit"]');
  if (button) {
    button.disabled = busy;
    button.classList.toggle('is-loading', busy);
  }
  form.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function saveSession(code, playerToken) {
  writeStorage(tokenKey(code), playerToken);
  writeStorage('luck:nickname', nickname);
}

function clearSession(code) {
  removeStorage(tokenKey(code));
}

function renderAuth(mode = 'create', code = '', error = '') {
  stopPolling();
  state = null;
  document.body.dataset.phase = 'auth';
  const isJoin = mode === 'join' && Boolean(code);
  const safeCode = esc(code);
  const safeName = esc(nickname);
  const safeError = error ? `<div class="form-error">${esc(error)}</div>` : '';

  app.innerHTML = `
    <div class="screen screen--auth">
      <div class="auth-brand">
        <div class="auth-badge"><span class="live-dot"></span> 群聊小游戏 · 无需登录</div>
        <img class="logo-hero" src="/icon.svg" alt="欧气对决">
        <h1 class="auth-title">欧气对决</h1>
        <p class="auth-sub">3 回合抽卡，倍率递增<br>看看群里谁才是天选之子</p>
      </div>

      <div class="auth-panel glass">
        ${isJoin ? `
          <div class="invite-banner">
            <span>你收到一张欧气邀请</span>
            <b>${safeCode}</b>
          </div>
        ` : ''}
        ${safeError}
        <form data-form="${isJoin ? 'join' : 'create'}" data-code="${safeCode}" novalidate>
          <div class="field">
            <label class="field-label" for="nickname">你的群昵称 <span>最多 12 个字</span></label>
            <input class="input" id="nickname" name="nickname" type="text" maxlength="12"
              autocomplete="nickname" enterkeyhint="done" placeholder="比如：锦鲤小王"
              value="${safeName}" aria-label="你的群昵称">
          </div>
          <button class="btn btn-primary btn-block" type="submit">
            ${isJoin ? '进入房间，开抽' : '创建房间，开抽'}
            <span class="btn-arrow">→</span>
          </button>
        </form>

        ${isJoin ? `
          <button class="switch-mode" data-action="switch-create">自己开一间房 <span>→</span></button>
        ` : `
          <div class="divider">或者加入朋友的房间</div>
          <form data-form="code-join" novalidate>
            <div class="join-row">
              <input class="input code-input" id="room-code" name="code" type="text" maxlength="5"
                inputmode="text" autocomplete="off" autocapitalize="characters" spellcheck="false"
                placeholder="5 位房间码" aria-label="房间码">
              <button class="btn btn-secondary" type="submit">加入</button>
            </div>
          </form>
        `}
      </div>

      <div class="auth-features">
        <div class="auth-feature"><b>3 回合</b><span>倍率递增</span></div>
        <div class="auth-feature"><b>纯随机</b><span>没有技巧</span></div>
        <div class="auth-feature"><b>点开即玩</b><span>群内对战</span></div>
      </div>
      <div class="auth-foot"><span class="live-dot"></span> 把链接丢进群里，点开就能玩</div>
    </div>
  `;
  window.scrollTo(0, 0);
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    window.setTimeout(() => document.getElementById('nickname')?.focus({ preventScroll: true }), 80);
  }
}

function progressDots(round) {
  return [1, 2, 3].map((index) => {
    const className = round === index ? 'is-active' : round > index ? 'is-done' : '';
    return `<span class="progress-dot ${className}"></span>`;
  }).join('');
}

function liveChips(currentState) {
  return currentState.players.map((player) => {
    const classes = [
      'live-chip',
      player.hasDrawn ? 'is-drawn' : '',
      player.id === currentState.meId ? 'is-me' : '',
      player.online === false ? 'is-offline' : '',
    ].filter(Boolean).join(' ');
    return `
      <div class="${classes}" title="${esc(player.name)}">
        ${avatarOf(player, 'mini-avatar')}
        <span class="mini-name">${esc(player.name)}${player.id === currentState.meId ? '（你）' : ''}</span>
        <span class="status-dot"></span>
      </div>
    `;
  }).join('');
}

function reactionBar() {
  return `
    <footer class="reaction-bar" aria-label="发送表情">
      ${REACTIONS.map((emoji) => `
        <button class="reaction-btn" data-action="reaction" data-emoji="${emoji}"
          aria-label="发送 ${emoji}">${emoji}</button>
      `).join('')}
    </footer>
  `;
}

function seatTemplate(player, currentState, index) {
  const tags = [];
  if (player.isHost) tags.push('房主');
  if (player.id === currentState.meId) tags.push('你');
  if (!player.online) tags.push('离线');
  else if (!player.isHost && player.id !== currentState.meId) tags.push('已就位');
  return `
    <div class="seat ${player.id === currentState.meId ? 'is-me' : ''}" style="animation-delay:${index * 35}ms">
      ${player.isHost ? '<span class="host-crown">房主</span>' : ''}
      ${avatarOf(player, 'avatar')}
      <span class="seat-name">${esc(player.name)}</span>
      <span class="seat-tag">${tags.join(' · ')}</span>
    </div>
  `;
}

function lobbyTemplate(currentState) {
  const host = currentState.players.find((player) => player.isHost);
  const count = currentState.players.length;
  const emptyCount = Math.min(3, Math.max(0, currentState.maxPlayers - count));
  const seats = currentState.players.map((player, index) => seatTemplate(player, currentState, index));
  for (let index = 0; index < emptyCount; index += 1) {
    seats.push(`
      <div class="seat is-empty">
        <span class="empty-plus">+</span>
        <small>虚位以待</small>
      </div>
    `);
  }

  const amHost = Boolean(currentState.hostId && currentState.hostId === currentState.meId);
  const short = Math.max(0, currentState.minPlayers - count);

  const startBlock = amHost
    ? `
      <button class="btn btn-primary btn-block" data-action="start" ${currentState.canStart ? '' : 'disabled'}>
        ${short > 0 ? `还差 ${short} 位玩家` : '开始对决 · 3 回合'}
        <span class="btn-arrow">→</span>
      </button>
      <p class="cta-note">${
        short > 0
          ? `你是房主 · 凑齐 ${currentState.minPlayers} 人后由你点击开局`
          : '抽卡顺序不影响结果，全看欧气'
      }</p>
    `
    : `
      <button class="btn btn-primary btn-block" disabled>
        ${short > 0 ? `还差 ${short} 位玩家` : '等待房主开始'}
      </button>
      <p class="cta-note cta-note--host">
        只有房主${host ? `（${esc(host.name)}）` : ''}能开始对决 · 房主点一下，3 回合自动进行
      </p>
    `;

  return `
    <div class="screen screen--lobby">
      <header class="topbar">
        <div class="topbar-left">
          <button class="icon-btn" data-action="leave-room" aria-label="离开房间">←</button>
          <div class="brand-mini">
            <img class="logo-mini" src="/icon.svg" alt="">
            <div>
              <div class="brand-name">欧气对决</div>
              <div class="room-chip">房间 <b>${esc(currentState.code)}</b></div>
            </div>
          </div>
        </div>
        <div class="topbar-actions">
          <button class="icon-btn" data-action="rules" aria-label="玩法说明">?</button>
          <button class="share-pill" data-action="share-room">↗ 邀请</button>
        </div>
      </header>

      <section class="lobby-hero">
        <div class="hero-kicker"><p class="eyebrow">FRIENDS ONLY · 纯运气竞技</p></div>
        <h1 class="hero-title">把<em>欧气</em>，<br>赌在这一抽</h1>
        <p class="hero-sub">3 回合抽卡，倍率 ×1 / ×2 / ×3。没有技巧，全看今天谁被幸运女神摸了头。</p>
      </section>

      <section class="invite-panel">
        <div class="invite-label">房间口令 · 邀请好友</div>
        <div class="room-code-line">
          <span class="room-code">${esc(currentState.code)}</span>
          <button class="copy-mini" data-action="copy-room" aria-label="复制邀请链接">⧉</button>
        </div>
        <div class="invite-actions">
          <button class="btn btn-secondary" data-action="copy-room">复制链接</button>
          <button class="btn btn-primary" data-action="share-room">分享到群里 <span class="btn-arrow">→</span></button>
        </div>
      </section>

      <section class="players-panel glass">
        <div class="section-head">
          <h2 class="section-title">已就位 <span>${count} / ${currentState.maxPlayers}</span></h2>
          <span class="section-note">${host ? `房主 ${esc(host.name)}` : ''}</span>
        </div>
        <div class="seat-grid">${seats.join('')}</div>
      </section>

      <div class="lobby-cta">
        ${startBlock}
      </div>
    </div>
  `;
}

function cardsTemplate(currentState) {
  const drawn = currentState.players.filter((player) => player.hasDrawn).length;
  const almost = drawn === currentState.players.length - 1;
  return `
    <div class="card-fan">
      ${[0, 1, 2].map((index) => `
        <button class="card" data-action="draw" data-index="${index}" type="button"
          aria-label="选择第 ${index + 1} 张命运卡">
          <span class="card-inner">
            <span class="card-brand">LUCK CARD</span>
            <img class="card-emblem" src="/icon.svg" alt="">
            <span class="card-caption">点 击 抽 取</span>
            <span class="card-num">NO.0${index + 1}</span>
          </span>
        </button>
      `).join('')}
    </div>
    <p class="draw-hint">${almost ? '就差你啦，选一张' : '三张命运卡，选一张'}</p>
  `;
}

function resultTemplate(result) {
  const stars = '✦'.repeat(clamp(result.rarity?.stars || 1, 1, 5));
  return `
    <div class="own-result" id="own-result">
      <div class="result-topline">
        <span class="result-label">你的欧气值</span>
        <span class="rarity rarity-${esc(result.rarity?.key || 'common')}">${stars} ${esc(result.rarity?.label || '')}</span>
      </div>
      <div class="result-score">
        <span class="plus">+</span>
        <span class="result-number">${Number(result.value) || 0}</span>
        <span class="result-unit">点</span>
      </div>
      ${result.crit ? `<div class="crit-chip">⚡ 欧气暴击 +${Number(result.bonus) || 0}</div>` : ''}
      <div class="points-line">
        本轮计入 <b>${Number(result.points) || 0}</b> 欧气值
        <span class="mult">×${Number(result.multiplier) || 1}</span>
      </div>
      <p class="locked-line">
        <span class="lock">▣</span>
        ${result.auto ? '超时自动代抽 · ' : ''}已锁定，等其他人抽完开奖
      </p>
    </div>
  `;
}

function gameTemplate(currentState) {
  const me = currentState.me;
  const theme = ROUND_THEMES[currentState.round - 1] || ROUND_THEMES[0];
  const drawn = currentState.players.filter((player) => player.hasDrawn).length;
  const remaining = Math.max(0, Math.ceil((currentState.deadline - currentState.serverNow) / 1000));
  const percent = clamp(
    ((currentState.deadline - currentState.serverNow) / Math.max(1000, currentState.roundMs)) * 100,
    0,
    100,
  );

  return `
    <div class="screen screen--game">
      <header class="game-top">
        <div class="round-pill">第 <b>${currentState.round}</b> / 3 回合</div>
        <div class="progress-dots">${progressDots(currentState.round)}</div>
        <button class="icon-btn" data-action="share-room" aria-label="分享房间">↗</button>
      </header>

      <section class="round-stage">
        <div class="round-heading">
          <div>
            <p class="round-kicker">${theme.kicker}</p>
            <h1 class="round-title"><span>${theme.line1}</span><em>${theme.line2}</em></h1>
          </div>
          <div class="timer" id="round-timer" style="--p:${percent.toFixed(2)}">
            <div class="timer-number"><span data-timer-number>${remaining}</span><small>秒</small></div>
          </div>
        </div>
        <p class="round-sub">本轮欧气值 <b>×${currentState.multiplier}</b> · 超时会自动帮你抽</p>
        <p class="auto-hint is-off" id="auto-hint">
          <span class="auto-hint-dot"></span>只剩 <b>10</b> 秒，不选将随机代抽
        </p>

        <div class="draw-zone">
          ${me.result ? resultTemplate(me.result) : cardsTemplate(currentState)}
        </div>

        <section class="live-panel">
          <div class="live-head">
            <span>本回合 <b data-live-count>${drawn}/${currentState.players.length}</b> 已抽</span>
            <span>${me.result ? '等待开奖…' : '轮到你啦'}</span>
          </div>
          <div class="live-scroll" id="live-strip">${liveChips(currentState)}</div>
        </section>
      </section>

      ${reactionBar()}
    </div>
  `;
}

function revealTemplate(currentState) {
  const results = currentState.roundResults || [];
  const me = currentState.me;
  const myRow = results.find((row) => row.id === currentState.meId);
  const totalRank = 1 + currentState.players.filter((player) => player.score > me.score).length;
  const nextText = currentState.round < 3
    ? `第 ${currentState.round + 1} 回合 <b id="reveal-countdown">5</b> 秒后开始`
    : `最终结果马上揭晓 · <b id="reveal-countdown">5</b>`;

  const rows = results.map((row, index) => {
    const result = row.result || {};
    const meta = [`${Number(result.value) || 0} 点`];
    if (result.crit) meta.push(`⚡ 暴击 +${Number(result.bonus) || 0}`);
    if (result.auto) meta.push('代抽');
    return `
      <div class="result-row ${row.rank === 1 ? 'is-first' : ''} ${row.id === currentState.meId ? 'is-me' : ''}"
        style="--i:${index}">
        <span class="rank-badge rank-${row.rank}">${pad2(row.rank)}</span>
        ${avatarOf(row, 'result-avatar')}
        <div class="result-name">
          <span class="name-text">${esc(row.name)}${row.id === currentState.meId ? ' <i>你</i>' : ''}</span>
          <span class="result-meta">${meta.join(' · ')}</span>
        </div>
        <div class="result-points">
          <b>+${Number(row.score) || 0}</b>
          <span>×${Number(result.multiplier) || currentState.multiplier}</span>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="screen screen--reveal">
      <header class="reveal-top">
        <div class="brand-mini">
          <img class="logo-mini" src="/icon.svg" alt="">
          <div>
            <div class="brand-name">本轮开奖</div>
            <div class="room-chip">房间 <b>${esc(currentState.code)}</b></div>
          </div>
        </div>
        <button class="share-pill" data-action="share-room">↗ 分享</button>
      </header>

      <section class="reveal-head">
        <p class="eyebrow">ROUND ${pad2(currentState.round)} · ${esc(currentState.roundName)}</p>
        <h1 class="reveal-title">欧气榜 <span class="spark">✦</span> <span class="mult-badge">倍率 ×${currentState.multiplier}</span></h1>
        <p class="reveal-sub">本轮结果已计入总分，${myRow?.rank === 1 ? '这一轮你最欧！' : '看看谁偷走了本轮的欧气。'}</p>
      </section>

      <div class="reveal-body">
        <div class="result-list">${rows}</div>
      </div>

      <div class="my-total">
        <div class="my-total-label">我的总分<b>稳住，还有机会</b></div>
        <div><span class="my-total-value">${Number(me.score) || 0}</span><span class="my-total-rank">第 ${totalRank} 名</span></div>
      </div>
      <p class="next-note">${nextText}</p>
    </div>
  `;
}

function podiumPlace(player, place) {
  if (!player) return '';
  return `
    <div class="podium-place place-${place}">
      <div class="podium-avatar" style="${gradientOf(player)}">${esc(player.avatar)}</div>
      <div class="podium-name">${esc(player.name)}</div>
      <div class="podium-score">${Number(player.score) || 0} 欧气</div>
      <div class="podium-block">${place}</div>
    </div>
  `;
}

function finalTemplate(currentState) {
  const standings = currentState.standings || [];
  const winners = standings.filter((player) => currentState.winnerIds.includes(player.id));
  const champion = winners[0] || standings[0];
  if (!champion) return lobbyTemplate(currentState);
  const top = standings.slice(0, 3);
  const championName = winners.length > 1
    ? winners.map((player) => player.name).join(' & ')
    : champion.name;
  const championLine = winners.length > 1
    ? '并列欧皇，建议一起买张彩票'
    : (champion.title?.line || '今天的欧气冠军');

  const ranking = standings.map((player, index) => `
    <div class="standing-row">
      <span class="standing-rank">${pad2(index + 1)}</span>
      ${avatarOf(player, 'standing-avatar')}
      <div class="standing-main">
        <div class="standing-name">${esc(player.name)}${player.id === currentState.meId ? ' · 你' : ''}</div>
        <div class="standing-title">${esc(player.title?.label || '气氛组')}</div>
      </div>
      <span class="standing-score">${Number(player.score) || 0}<small> 欧气</small></span>
    </div>
  `).join('');

  const actions = currentState.canReplay
    ? `
      <div class="final-actions is-pair">
        <button class="btn btn-primary" data-action="again">再来一局 <span class="btn-arrow">↻</span></button>
        <button class="btn btn-secondary" data-action="share-result">分享战绩</button>
      </div>
    `
    : `
      <div class="final-actions is-pair">
        <div class="final-wait"><span class="pulse-dot"></span> 等房主开新一局</div>
        <button class="btn btn-secondary" data-action="share-result">分享战绩</button>
      </div>
    `;

  return `
    <div class="screen screen--final">
      <header class="topbar">
        <div class="brand-mini">
          <img class="logo-mini" src="/icon.svg" alt="">
          <div>
            <div class="brand-name">本局结算</div>
            <div class="room-chip">房间 <b>${esc(currentState.code)}</b></div>
          </div>
        </div>
        <button class="share-pill" data-action="share-result">↗ 战绩</button>
      </header>

      <div class="final-scroll">
        <div class="final-head">
          <p class="eyebrow">FINAL RESULT · 欧气结算</p>
          <h1 class="final-title">今天的群聊欧皇是</h1>
        </div>

        <section class="champion">
          <div class="champion-halo"></div>
          <div class="crown">👑</div>
          <div class="champion-avatar" style="${gradientOf(champion)}">${esc(champion.avatar)}</div>
          <div class="champion-tag">${winners.length > 1 ? '并列欧皇' : '群聊欧皇'}</div>
          <h2 class="champion-name">${esc(championName)}</h2>
          <div class="champion-score">${Number(champion.score) || 0}<span>欧气值</span></div>
          <p class="champion-line">${esc(championLine)}</p>
        </section>

        <section class="podium" aria-label="前三名">
          ${podiumPlace(top[1], 2)}
          ${podiumPlace(top[0], 1)}
          ${podiumPlace(top[2], 3)}
        </section>

        <section class="standings">
          <div class="standings-head"><span>全员战力榜</span><span>纯运气，无副作用</span></div>
          ${ranking}
        </section>
      </div>

      ${actions}
    </div>
  `;
}

function signature(currentState) {
  const playerPart = currentState.players.map((player) => [
    player.id,
    player.hasDrawn ? 1 : 0,
    player.score,
    currentState.phase === 'lobby' || currentState.phase === 'round' ? (player.online ? 1 : 0) : 0,
    player.isHost ? 1 : 0,
  ].join(':')).join('|');
  return [
    currentState.phase,
    currentState.round,
    currentState.me?.hasDrawn ? 1 : 0,
    currentState.me?.result?.value || 0,
    currentState.hostId,
    playerPart,
    (currentState.roundResults || []).map((row) => `${row.id}:${row.rank}:${row.score}`).join('|'),
    (currentState.standings || []).map((row) => `${row.id}:${row.rank}:${row.score}`).join('|'),
    currentState.winnerIds.join(','),
  ].join('~');
}

function render(force = false) {
  if (!state?.me) return;
  const screenKey = `${state.phase}:${state.round}`;
  if (screenKey !== lastScreenKey) {
    lastScreenKey = screenKey;
    window.scrollTo(0, 0);
  }

  document.body.dataset.phase = state.phase;
  if (state.phase === 'lobby') app.innerHTML = lobbyTemplate(state);
  else if (state.phase === 'round') app.innerHTML = gameTemplate(state);
  else if (state.phase === 'reveal') app.innerHTML = revealTemplate(state);
  else app.innerHTML = finalTemplate(state);

  lastRenderPhase = state.phase;
  lastRenderRound = state.round;
  lastMeDrawn = Boolean(state.me.hasDrawn);
  lastMeValue = state.me.result?.value || 0;
  lastSig = signature(state);
  updateTimer();
}

function updateLivePane() {
  if (state?.phase !== 'round') return;
  const count = document.querySelector('[data-live-count]');
  if (count) {
    const drawn = state.players.filter((player) => player.hasDrawn).length;
    count.textContent = `${drawn}/${state.players.length}`;
  }
  const strip = document.getElementById('live-strip');
  if (strip) strip.innerHTML = liveChips(state);
}

function maybeRender(force = false) {
  if (!state?.me) return;
  const sig = signature(state);
  const sameRound = state.phase === 'round'
    && lastRenderPhase === 'round'
    && lastRenderRound === state.round
    && lastMeDrawn === Boolean(state.me.result)
    && lastMeValue === (state.me.result?.value || 0);

  if (sameRound) {
    if (sig !== lastSig) {
      updateLivePane();
      lastSig = sig;
    }
    return;
  }

  if (!force && sig === lastSig && lastRenderPhase === state.phase) return;
  render(force);
}

function updateTimer() {
  if (!state) return;
  const now = Date.now() + serverOffset;

  if (state.phase === 'round' && state.deadline) {
    const remainingMs = Math.max(0, state.deadline - now);
    const seconds = Math.ceil(remainingMs / 1000);

    const timer = document.getElementById('round-timer');
    if (timer) {
      const number = timer.querySelector('[data-timer-number]');
      if (number) number.textContent = seconds;
      const percent = clamp((remainingMs / Math.max(1000, state.roundMs)) * 100, 0, 100);
      timer.style.setProperty('--p', percent.toFixed(2));
      timer.classList.toggle('is-urgent', remainingMs > 0 && remainingMs <= 5000);
    }

    // 快结束时提醒还没抽的人：不点就随机代抽
    const hint = document.getElementById('auto-hint');
    if (hint) {
      const show = !state.me?.result && remainingMs > 0 && remainingMs <= 10000;
      hint.classList.toggle('is-off', !show);
      if (show) {
        const label = hint.querySelector('b');
        const text = String(Math.max(1, seconds));
        if (label && label.textContent !== text) label.textContent = text;
      }
    }
  }

  if (state.phase === 'reveal' && state.revealUntil) {
    const countdown = document.getElementById('reveal-countdown');
    if (countdown) {
      const seconds = Math.max(0, Math.ceil((state.revealUntil - now) / 1000));
      countdown.textContent = seconds;
    }
  }
}

function startPolling() {
  stopPolling();
  const generation = ++pollGeneration;
  polling = true;
  lastPollAt = Date.now();
  const loop = async () => {
    if (!polling || generation !== pollGeneration || !roomCode) return;
    try {
      const data = await api(`/api/rooms/${encodeURIComponent(roomCode)}`);
      if (!polling || generation !== pollGeneration) return;
      lastPollAt = Date.now();
      applyState(data.state);
    } catch (error) {
      if (!polling || generation !== pollGeneration) return;
      lastPollAt = Date.now();
      if (error.status === 401 || error.status === 404) {
        sessionLost(error.status);
        return;
      }
      if (Date.now() - lastNetworkToast > 9000) {
        lastNetworkToast = Date.now();
        toast(error.message || '网络有点慢，正在重试…');
      }
    } finally {
      // 无论成功、失败还是被中断，都要把下一拍排上，否则一次异常就让轮询彻底停摆。
      if (polling && generation === pollGeneration) {
        const delay = document.hidden ? 2600 : state?.phase === 'finished' ? 2000 : 1000;
        pollTimer = window.setTimeout(loop, delay);
      }
    }
  };
  pollTimer = window.setTimeout(loop, 80);
}

// 兜底看门狗：万一某个分支漏掉了重新排期，或者浏览器把定时器冻住了，
// 这里发现「太久没成功取过状态」就直接重启一次轮询，让画面自己追上来。
window.setInterval(() => {
  if (!polling || !roomCode || document.hidden) return;
  if (Date.now() - lastPollAt < 12000) return;
  lastPollAt = Date.now();
  startPolling();
}, 4000);

window.addEventListener('online', () => {
  if (polling && roomCode) startPolling();
});

function stopPolling() {
  polling = false;
  pollGeneration += 1;
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function markReactions(currentState, initial = false) {
  if (initial || !reactionReady) {
    currentState.reactions.forEach((reaction) => seenReactions.add(reaction.id));
    reactionReady = true;
    return;
  }
  for (const reaction of currentState.reactions) {
    if (seenReactions.has(reaction.id)) continue;
    seenReactions.add(reaction.id);
    if (reaction.playerId !== currentState.meId) floatEmoji(reaction.emoji);
  }
}

function onPhaseChange(previous, next) {
  if (!previous) return;

  if (next.phase === 'reveal' && previous.phase === 'round') {
    const myRow = (next.roundResults || []).find((row) => row.id === next.meId);
    if (myRow?.rank === 1) {
      rainConfetti(34);
      vibrate([18, 40, 18]);
    }
  }

  if (next.phase === 'finished' && previous.phase !== 'finished') {
    rainConfetti(100);
    vibrate([30, 40, 30, 40, 60]);
  }

  if (next.phase === 'lobby' && previous.phase === 'finished') {
    toast('新一局已就位，快喊人！');
  }
}

function applyState(next, options = {}) {
  if (!next?.me) return;
  serverOffset = next.serverNow - Date.now();
  const previous = state;
  markReactions(next, Boolean(options.initial));

  if (previous && previous.phase !== next.phase) onPhaseChange(previous, next);
  if (previous && previous.round !== next.round) updateTimer();

  state = next;

  if (interaction) {
    pendingRender = true;
    return;
  }

  maybeRender(Boolean(options.force));
  updateTimer();
}

function enterRoom(code, playerToken, nextState) {
  stopPolling();
  roomCode = code;
  token = playerToken;
  nickname = nextState.me?.name || nickname;
  saveSession(code, playerToken);
  window.history.replaceState({}, '', withShareCode(`/r/${code}`));
  state = null;
  reactionReady = false;
  seenReactions = new Set();
  lastSig = '';
  lastRenderPhase = '';
  lastRenderRound = 0;
  lastMeDrawn = false;
  lastMeValue = 0;
  lastScreenKey = '';
  applyState(nextState, { initial: true, force: true });
  startPolling();
}

function sessionLost(status) {
  const lostCode = roomCode;
  stopPolling();
  clearSession(lostCode);
  state = null;
  token = '';
  roomCode = '';
  window.history.replaceState({}, '', withShareCode('/'));
  const message = status === 404
    ? '这个房间已经过期了，开一间新的吧'
    : '身份失效了，重新加入一次就好';
  renderAuth(status === 404 ? 'create' : 'join', lostCode, message);
}

async function createRoom(form) {
  const input = document.getElementById('nickname');
  const name = String(input?.value || '').trim();
  if (!name) {
    toast('先给自己起个名字吧');
    input?.focus();
    return;
  }
  nickname = Array.from(name).slice(0, 12).join('');
  setSubmitBusy(form, true);
  try {
    const data = await api('/api/rooms', { method: 'POST', body: { name: nickname }, auth: false });
    vibrate(12);
    enterRoom(data.state.code, data.token, data.state);
  } catch (error) {
    toast(error.message);
    setSubmitBusy(form, false);
  }
}

async function joinRoom(code, form) {
  const normalized = normalizeCode(code);
  const input = document.getElementById('nickname');
  const name = String(input?.value || '').trim();
  if (!name) {
    toast('先给自己起个名字吧');
    input?.focus();
    return;
  }
  if (normalized.length < 4) {
    toast('请输入正确的房间码');
    document.getElementById('room-code')?.focus();
    return;
  }
  nickname = Array.from(name).slice(0, 12).join('');
  setSubmitBusy(form, true);
  const existingToken = readStorage(tokenKey(normalized));
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(normalized)}/join`, {
      method: 'POST',
      body: { name: nickname, token: existingToken || undefined },
      auth: false,
    });
    vibrate(12);
    enterRoom(data.state.code, data.token, data.state);
  } catch (error) {
    if (error.status === 404) {
      toast('房间码不对，或者房间已经过期');
    } else {
      toast(error.message);
    }
    setSubmitBusy(form, false);
  }
}

// 交互（开局 / 抽卡 / 再来一局）期间先压住重绘，免得把正在播的动画顶掉。
// 但如果那个请求一直不回来，这个标志位会把界面永久钉死在旧画面上——
// 所以给它配一个自动解锁：到点还没结束就放开封锁，强制按最新状态重绘一次。
function beginInteraction() {
  interaction = true;
  pendingRender = false;
  if (interactionTimer) window.clearTimeout(interactionTimer);
  interactionTimer = window.setTimeout(() => {
    interactionTimer = null;
    if (!interaction) return;
    interaction = false;
    pendingRender = false;
    if (state) render(true);
  }, 9000);
}

function endInteraction() {
  interaction = false;
  if (interactionTimer) {
    window.clearTimeout(interactionTimer);
    interactionTimer = null;
  }
}

async function startGame(button) {
  if (!state?.canStart || interaction) return;
  beginInteraction();
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
  }
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomCode)}/start`, { method: 'POST' });
    endInteraction();
    pendingRender = false;
    vibrate(18);
    applyState(data.state, { force: true });
  } catch (error) {
    endInteraction();
    pendingRender = false;
    toast(error.message);
    if (button) {
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }
}

async function replayGame(button) {
  if (!state?.canReplay || interaction) return;
  beginInteraction();
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
  }
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomCode)}/again`, { method: 'POST' });
    endInteraction();
    pendingRender = false;
    vibrate([12, 30, 12]);
    applyState(data.state, { force: true });
  } catch (error) {
    endInteraction();
    pendingRender = false;
    toast(error.message);
    if (button) {
      button.disabled = false;
      button.classList.remove('is-loading');
    }
  }
}

async function drawCard(index, button) {
  if (!state?.canDraw || interaction) return;
  beginInteraction();
  pendingRender = false;
  vibrate(10);

  const cards = [...document.querySelectorAll('.card')];
  cards.forEach((card, cardIndex) => {
    card.classList.toggle('is-picked', cardIndex === index);
    card.classList.toggle('is-dim', cardIndex !== index);
    card.disabled = true;
  });

  const note = document.createElement('div');
  note.className = 'drawing-note';
  note.textContent = '欧气注入中…';
  document.body.append(note);

  try {
    const [data] = await Promise.all([
      api(`/api/rooms/${encodeURIComponent(roomCode)}/draw`, {
        method: 'POST',
        body: { index },
      }),
      sleep(720),
    ]);
    note.remove();
    endInteraction();
    state = data.state;
    serverOffset = data.state.serverNow - Date.now();
    vibrate([14, 30, 42]);
    render(true);
    window.setTimeout(() => burstFromResult(), 60);
  } catch (error) {
    note.remove();
    endInteraction();
    pendingRender = false;
    toast(error.status === 409 ? '这一轮已经开奖啦，看结果吧' : error.message);
    render(true);
    if (error.status !== 409) {
      // Let the next poll repair the screen if the request actually timed out.
    }
  }
}

async function sendReaction(emoji) {
  if (!state || state.phase !== 'round') return;
  vibrate(5);
  floatEmoji(emoji);
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomCode)}/reaction`, {
      method: 'POST',
      body: { emoji },
    });
    if (data.reaction?.id) seenReactions.add(data.reaction.id);
  } catch {
    /* reactions are decorative; never interrupt the game for one */
  }
}

async function shareRoom() {
  const url = roomUrl();
  const text = `🍀 欧气对决｜3 回合抽卡，看看群里谁最欧！房间 ${roomCode}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: '欧气对决', text, url });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  const copied = await copyText(`${text}\n${url}`);
  toast(copied ? '邀请文案已复制，去群里粘贴吧' : '复制失败，请手动复制链接');
}

async function shareResult() {
  if (!state) return;
  const me = state.standings?.find((player) => player.id === state.meId);
  const url = roomUrl();
  const text = me
    ? `我在「欧气对决」拿了 ${me.score} 欧气值，第 ${me.rank} 名，称号「${me.title?.label || '气氛组'}」。来比比谁更欧：`
    : `来「欧气对决」比比谁更欧：`;
  if (navigator.share) {
    try {
      await navigator.share({ title: '我的欧气战绩', text: `${text}${url}`, url });
      return;
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  const copied = await copyText(`${text}${url}`);
  toast(copied ? '战绩文案已复制，去群里晒晒' : '复制失败，请手动复制链接');
}

async function copyRoomLink() {
  const copied = await copyText(roomUrl());
  toast(copied ? '邀请链接已复制' : '复制失败，请手动复制');
}

function openModal({ title, body, actions }) {
  lastFocused = document.activeElement;
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="modal-backdrop">
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <h2 class="modal-title" id="modal-title">${esc(title)}</h2>
          <button class="modal-close" data-action="modal-close" aria-label="关闭">✕</button>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">${actions}</div>
      </section>
    </div>
  `;
  document.body.classList.add('modal-open');
  window.setTimeout(() => modalRoot.querySelector('.modal-close')?.focus({ preventScroll: true }), 60);
}

function closeModal() {
  modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
  if (lastFocused?.focus) lastFocused.focus({ preventScroll: true });
  lastFocused = null;
}

function openRules() {
  openModal({
    title: '欧气对决 · 玩法',
    body: `
      <p>每人每回合从 3 张命运卡里选 1 张，揭晓 <strong>1–140</strong> 的欧气值。</p>
      <ol>
        <li>第 1 / 2 / 3 回合分别按 <strong>×1 / ×2 / ×3</strong> 计入总分。</li>
        <li>有 14% 概率触发<strong>欧气暴击</strong>，额外加分。</li>
        <li>30 秒内没抽会自动帮你抽；全员抽完会提前开奖。</li>
        <li>三轮总分最高的人，就是本局「群聊欧皇」。</li>
      </ol>
      <p class="modal-tip">没有技巧，输了就怪运气。建议把链接丢进群里，让朋友一起接受命运的安排。</p>
    `,
    actions: `<button class="btn btn-primary" data-action="modal-close">知道了，开抽</button>`,
  });
}

function openLeaveConfirm() {
  openModal({
    title: '要离开房间吗？',
    body: '<p>离开后会清掉这台设备上的入房身份。房间还在，重新点邀请链接可以再进来。</p>',
    actions: `
      <button class="btn btn-secondary" data-action="modal-close">再等等</button>
      <button class="btn btn-primary" data-action="confirm-leave">离开房间</button>
    `,
  });
}

async function leaveRoom(button) {
  if (!roomCode) {
    closeModal();
    renderAuth('create');
    return;
  }
  if (button) {
    button.disabled = true;
    button.classList.add('is-loading');
  }
  try {
    await api(`/api/rooms/${encodeURIComponent(roomCode)}/leave`, { method: 'POST' });
  } catch (error) {
    if (error.status !== 409) toast(error.message);
  }
  const oldCode = roomCode;
  closeModal();
  stopPolling();
  clearSession(oldCode);
  roomCode = '';
  token = '';
  state = null;
  window.history.replaceState({}, '', withShareCode('/'));
  renderAuth('create');
  toast('已离开房间');
}

function floatEmoji(emoji) {
  const node = document.createElement('span');
  node.className = 'floating-emoji';
  node.textContent = emoji;
  node.style.left = `${12 + Math.random() * 76}vw`;
  node.style.setProperty('--drift', `${Math.round((Math.random() - 0.5) * 90)}px`);
  node.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 36)}deg`);
  fx.append(node);
  window.setTimeout(() => node.remove(), 1900);
}

function rainConfetti(count = 60) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#ffd166', '#ff74b8', '#5eead4', '#c4b5fd', '#fff3bf', '#ff9f43'];
  for (let index = 0; index < count; index += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.background = colors[index % colors.length];
    piece.style.width = `${5 + Math.random() * 5}px`;
    piece.style.height = `${8 + Math.random() * 8}px`;
    piece.style.setProperty('--dur', `${2.2 + Math.random() * 2.2}s`);
    piece.style.setProperty('--delay', `${Math.random() * 0.55}s`);
    piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 160}px`);
    piece.style.setProperty('--rot', `${360 + Math.random() * 620}deg`);
    fx.append(piece);
    window.setTimeout(() => piece.remove(), 5200);
  }
}

function burstFromResult() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const result = document.getElementById('own-result');
  if (!result) return;
  const rect = result.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + Math.min(90, rect.height * 0.4);
  for (let index = 0; index < 20; index += 1) {
    const angle = (Math.PI * 2 * index) / 20 + Math.random() * 0.25;
    const distance = 44 + Math.random() * 92;
    const spark = document.createElement('span');
    spark.className = 'spark';
    spark.style.left = `${x}px`;
    spark.style.top = `${y}px`;
    spark.style.background = index % 3 === 0 ? '#ff74b8' : index % 3 === 1 ? '#ffd166' : '#5eead4';
    spark.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    spark.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    fx.append(spark);
    window.setTimeout(() => spark.remove(), 900);
  }
}

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.busy === '1') return;
  const type = form.dataset.form;
  if (type === 'create') {
    createRoom(form);
  } else if (type === 'join') {
    joinRoom(form.dataset.code, form);
  } else if (type === 'code-join') {
    joinRoom(document.getElementById('room-code')?.value || '', form);
  }
});

document.addEventListener('click', (event) => {
  const backdrop = event.target.closest('[data-action="modal-backdrop"]');
  if (backdrop && event.target === backdrop) {
    closeModal();
    return;
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  if (action === 'create') return;
  if (action === 'modal-close' || action === 'modal-backdrop') {
    if (action === 'modal-close') closeModal();
    return;
  }
  if (action === 'rules') {
    openRules();
  } else if (action === 'leave-room') {
    openLeaveConfirm();
  } else if (action === 'confirm-leave') {
    leaveRoom(target);
  } else if (action === 'switch-create') {
    window.history.replaceState({}, '', withShareCode('/'));
    renderAuth('create');
  } else if (action === 'copy-room') {
    copyRoomLink();
  } else if (action === 'share-room') {
    shareRoom();
  } else if (action === 'start') {
    startGame(target);
  } else if (action === 'draw') {
    drawCard(Number(target.dataset.index), target);
  } else if (action === 'reaction') {
    sendReaction(target.dataset.emoji);
  } else if (action === 'again') {
    replayGame(target);
  } else if (action === 'share-result') {
    shareResult();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modalRoot.children.length) closeModal();
});

document.addEventListener('visibilitychange', () => {
  // 切回前台立刻补一次状态：手机后台时定时器会被节流甚至暂停，回来必须马上追上。
  if (!document.hidden && polling && roomCode) startPolling();
});

window.setInterval(updateTimer, 200);

async function bootstrap() {
  const code = codeFromLocation();
  if (!code) {
    renderAuth('create');
    return;
  }

  const savedToken = readStorage(tokenKey(code));
  if (!savedToken) {
    renderAuth('join', code);
    return;
  }

  token = savedToken;
  roomCode = code;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(code)}`);
    if (data.state?.me) {
      enterRoom(code, savedToken, data.state);
      return;
    }
    throw new Error('房间状态不完整');
  } catch (error) {
    token = '';
    roomCode = '';
    clearSession(code);
    if (error.status === 404) {
      renderAuth('create', '', '这个房间已经不存在了，开一间新的吧');
    } else if (error.status === 401) {
      renderAuth('join', code, '入房身份已失效，再进一次就好');
    } else {
      renderAuth('join', code, '暂时连不上房间，再试一次吧');
    }
  }
}

bootstrap();
