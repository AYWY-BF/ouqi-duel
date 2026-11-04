// 前端渲染回归测试：在最小化 DOM mock 里加载 public/app.js，
// 校验大厅的房主/访客分支，以及回合倒计时尾声的代抽提醒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    className: '',
    dataset: {},
    style: { setProperty() {} },
    classList: {
      _set: new Set(),
      add(value) { this._set.add(value); },
      remove(value) { this._set.delete(value); },
      toggle(value, on) { if (on) this._set.add(value); else this._set.delete(value); },
      contains(value) { return this._set.has(value); },
    },
    addEventListener() {},
    appendChild() {},
    remove() {},
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function createContext() {
  const documentMock = {
    getElementById: () => makeEl(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    createElement: () => makeEl(),
    body: makeEl(),
    documentElement: makeEl(),
    hidden: false,
  };

  const windowMock = {
    location: { search: '', pathname: '/', origin: 'http://localhost', href: 'http://localhost/' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {}, pushState() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    navigator: { userAgent: 'node' },
    requestAnimationFrame: () => 0,
    scrollTo() {},
    document: documentMock,
  };

  const context = {
    window: windowMock,
    document: documentMock,
    navigator: windowMock.navigator,
    location: windowMock.location,
    localStorage: windowMock.localStorage,
    history: windowMock.history,
    console,
    setTimeout: windowMock.setTimeout,
    clearTimeout: windowMock.clearTimeout,
    setInterval: windowMock.setInterval,
    clearInterval: windowMock.clearInterval,
    requestAnimationFrame: windowMock.requestAnimationFrame,
    fetch: async () => { throw new Error('offline'); },
    URLSearchParams,
    Date,
    Math,
    JSON,
    encodeURIComponent,
    Intl,
    AbortController,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'public/app.js' });
  return context;
}

const players = [
  { id: 'host-id', name: '真房主', score: 0, isHost: true, hasDrawn: false },
  { id: 'guest-id', name: '锦鲤小王', score: 0, isHost: false, hasDrawn: false },
  { id: 'other-id', name: '路人甲', score: 0, isHost: false, hasDrawn: false },
];

function makeState(overrides = {}) {
  return {
    code: 'TEST01',
    phase: 'lobby',
    round: 1,
    totalRounds: 3,
    roundName: '热身局',
    multiplier: 1,
    hostId: 'host-id',
    meId: 'guest-id',
    me: { id: 'guest-id', name: '锦鲤小王', score: 0, result: null },
    players,
    minPlayers: 3,
    maxPlayers: 12,
    canStart: false,
    canDraw: false,
    canReplay: false,
    deadline: 0,
    revealUntil: 0,
    roundMs: 28000,
    revealMs: 5000,
    roundResults: [],
    standings: [],
    winnerIds: [],
    reactions: [],
    serverNow: Date.now(),
    ...overrides,
  };
}

test('访客在人数够时看到「等待房主开始」，而不是可点击的开局按钮', () => {
  const context = createContext();
  const html = context.lobbyTemplate(makeState());
  assert.match(html, /等待房主开始/);
  assert.doesNotMatch(html, /data-action="start"/, '访客不应拿到开局按钮');
  assert.match(html, /只有房主/);
  assert.match(html, /能开始对决/);
});

test('访客在人数不足时看到还差几人，并知道只有房主能开', () => {
  const context = createContext();
  const html = context.lobbyTemplate(makeState({ players: players.slice(0, 2) }));
  assert.match(html, /还差 1 位玩家/);
  assert.match(html, /只有房主/);
});

test('房主在人数够时拿到可点击的开局按钮', () => {
  const context = createContext();
  const html = context.lobbyTemplate(
    makeState({
      meId: 'host-id',
      canStart: true,
      me: { id: 'host-id', name: '真房主', score: 0, result: null },
    }),
  );
  assert.match(html, /data-action="start"/);
  assert.doesNotMatch(html, /data-action="start"\s+disabled/);
  assert.match(html, /开始对决 · 3 回合/);
});

test('房主在人数不足时看到「凑齐 N 人后由你点击开局」', () => {
  const context = createContext();
  const html = context.lobbyTemplate(
    makeState({
      meId: 'host-id',
      canStart: false,
      players: players.slice(0, 2),
      me: { id: 'host-id', name: '真房主', score: 0, result: null },
    }),
  );
  assert.match(html, /还差 1 位玩家/);
  assert.match(html, /凑齐 3 人后由你点击开局/);
});

function runTimer(context, remainingMs, { hasResult = false } = {}) {
  const hintEl = makeEl();
  const labelEl = makeEl();
  labelEl.textContent = '10';
  hintEl.querySelector = (selector) => (selector === 'b' ? labelEl : null);

  const timerEl = makeEl();
  timerEl.querySelector = () => makeEl();

  const documentMock = {
    getElementById: (id) => {
      if (id === 'auto-hint') return hintEl;
      if (id === 'round-timer') return timerEl;
      return null;
    },
  };

  const previousDocument = context.document;
  const previousWindowDocument = context.window.document;
  context.document = documentMock;
  context.window.document = documentMock;

  const fakeState = makeState({
    phase: 'round',
    deadline: Date.now() + remainingMs,
    me: { id: 'guest-id', name: '锦鲤小王', score: 0, result: hasResult ? { value: 50 } : null },
  });

  // app.js 里的 state / serverOffset 是 let 声明，必须在同一词法环境里赋值
  vm.runInContext(
    `state = ${JSON.stringify(fakeState)}; serverOffset = 0; updateTimer();`,
    context,
    { filename: 'updateTimer.js' },
  );

  context.document = previousDocument;
  context.window.document = previousWindowDocument;

  return {
    hidden: hintEl.classList.contains('is-off'),
    seconds: labelEl.textContent,
  };
}

test('回合界面始终带代抽提醒元素，且默认隐藏', () => {
  const context = createContext();
  const html = context.gameTemplate(makeState({ phase: 'round', deadline: Date.now() + 20000 }));
  assert.match(html, /id="auto-hint"/);
  assert.match(html, /随机代抽/);
  assert.match(html, /class="auto-hint is-off"/);
});

test('倒计时剩 10 秒内、还没抽：提醒出现并显示剩余秒数', () => {
  const context = createContext();
  const { hidden, seconds } = runTimer(context, 8000);
  assert.equal(hidden, false, '快结束时应显示提醒');
  assert.equal(seconds, '8');
});

test('倒计时还早：提醒保持隐藏', () => {
  const context = createContext();
  const { hidden } = runTimer(context, 20000);
  assert.equal(hidden, true);
});

test('已经抽过：提醒不再打扰', () => {
  const context = createContext();
  const { hidden } = runTimer(context, 6000, { hasResult: true });
  assert.equal(hidden, true);
});

test('时间走完：提醒隐藏，交给代抽流程', () => {
  const context = createContext();
  const { hidden } = runTimer(context, 0);
  assert.equal(hidden, true);
});
