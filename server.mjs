import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ROUND_MS = Math.max(5000, Number(process.env.ROUND_MS || 30000));
const REVEAL_MS = Math.max(1000, Number(process.env.REVEAL_MS || 5200));
const ROOM_TTL = 6 * 60 * 60 * 1000;
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 2;
const MAX_ROOMS = 100;

const rooms = new Map();
const rateBuckets = new Map();

const AVATARS = ['🦊', '🐼', '🐯', '🐸', '🐵', '🦄', '🐙', '🐳', '🦁', '🐰', '🐨', '🐹', '🦖', '🐲', '🦉', '🐺'];
const GRADIENTS = [
  ['#ffb86b', '#ff6b9d'],
  ['#7dd3fc', '#818cf8'],
  ['#6ee7b7', '#14b8a6'],
  ['#fda4af', '#c084fc'],
  ['#fde68a', '#f59e0b'],
  ['#a5b4fc', '#6366f1'],
  ['#f9a8d4', '#ec4899'],
  ['#93c5fd', '#3b82f6'],
  ['#bef264', '#65a30d'],
  ['#fdba74', '#ea580c'],
  ['#5eead4', '#0891b2'],
  ['#d8b4fe', '#9333ea'],
];
const REACTION_SET = new Set(['😂', '🍋', '🔥', '👑', '😭', '🤝', '🎉', '😎']);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const ROUND_COPY = [
  { name: '热身局', multiplier: 1 },
  { name: '加倍局', multiplier: 2 },
  { name: '决胜局', multiplier: 3 },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function randomInt(min, max) {
  return crypto.randomInt(min, max);
}

function randomCode() {
  let code = '';
  for (let i = 0; i < 5; i += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return rooms.has(code) ? randomCode() : code;
}

function token() {
  return crypto.randomBytes(18).toString('base64url');
}

function cleanName(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, 12).join('') || '神秘玩家';
}

function pickAvatar(room) {
  const used = new Set([...room.players.values()].map((player) => player.avatar));
  const available = AVATARS.filter((avatar) => !used.has(avatar));
  return available.length ? available[randomInt(0, available.length)] : AVATARS[randomInt(0, AVATARS.length)];
}

function pickGradient(room) {
  const used = new Set([...room.players.values()].map((player) => player.gradient));
  const available = GRADIENTS.filter((gradient) => !used.has(gradient));
  return (available.length ? available : GRADIENTS)[randomInt(0, available.length || GRADIENTS.length)];
}

function createPlayer(name) {
  return {
    id: crypto.randomUUID(),
    token: token(),
    name: cleanName(name),
    avatar: '',
    gradient: null,
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    score: 0,
    current: null,
    hasDrawn: false,
    lastReactionAt: 0,
    roundScores: [],
  };
}

function createRoom(hostName) {
  if (rooms.size >= MAX_ROOMS) {
    throw new ApiError(503, `当前房间太多（上限 ${MAX_ROOMS} 间），稍等几分钟再来`);
  }
  const room = {
    code: randomCode(),
    hostId: '',
    phase: 'lobby',
    roundIndex: 0,
    roundStartedAt: 0,
    readyToRevealAt: 0,
    revealUntil: 0,
    finishedAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    players: new Map(),
    reactions: [],
    reactionSeq: 0,
    gameId: '',
  };
  const host = createPlayer(hostName);
  host.avatar = pickAvatar(room);
  host.gradient = pickGradient(room);
  room.players.set(host.id, host);
  room.hostId = host.id;
  rooms.set(room.code, room);
  return { room, player: host };
}

function joinRoom(room, name) {
  if (room.phase !== 'lobby') {
    throw new ApiError(409, '这局已经开始了，等房主再开一局吧');
  }
  if (room.players.size >= MAX_PLAYERS) {
    throw new ApiError(409, `房间最多 ${MAX_PLAYERS} 人，挤不进来啦`);
  }
  const player = createPlayer(name);
  player.avatar = pickAvatar(room);
  player.gradient = pickGradient(room);
  room.players.set(player.id, player);
  room.updatedAt = Date.now();
  return player;
}

function findRoom(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) throw new ApiError(404, '房间不存在或已经过期');
  return room;
}

function authenticate(room, req) {
  const header = req.headers['x-player-token'];
  const supplied = Array.isArray(header) ? header[0] : header;
  if (!supplied) throw new ApiError(401, '请先加入房间');
  const player = [...room.players.values()].find((entry) => entry.token === supplied);
  if (!player) throw new ApiError(401, '身份已失效，请重新加入');
  player.lastSeen = Date.now();
  room.updatedAt = Date.now();
  return player;
}

function isHost(room, player) {
  return room.hostId === player.id;
}

function roundMultiplier(room) {
  return Math.min(3, room.roundIndex + 1);
}

function generateResult(room, cardIndex) {
  const a = randomInt(1, 101);
  const b = randomInt(1, 101);
  const base = Math.round((a + b) / 2);
  const crit = randomInt(0, 100) < 14;
  const bonus = crit ? 15 + Math.round(base * 0.25) : 0;
  const value = base + bonus;
  let rarity;
  if (value >= 118) rarity = { key: 'mythic', label: '天命之子', stars: 5 };
  else if (value >= 96) rarity = { key: 'legend', label: '欧皇附体', stars: 4 };
  else if (value >= 76) rarity = { key: 'epic', label: '欧气爆棚', stars: 3 };
  else if (value >= 55) rarity = { key: 'rare', label: '运气在线', stars: 2 };
  else if (value >= 35) rarity = { key: 'common', label: '普普通通', stars: 1 };
  else rarity = { key: 'unlucky', label: '非酋警报', stars: 1 };

  return {
    cardIndex,
    base,
    bonus,
    crit,
    value,
    rarity,
    multiplier: roundMultiplier(room),
    points: value * roundMultiplier(room),
    auto: false,
  };
}

function takeCard(room, player, cardIndex, auto = false) {
  if (room.phase !== 'round') throw new ApiError(409, '现在还不能抽卡');
  if (player.current) throw new ApiError(409, '你这一轮已经抽过啦');
  const result = generateResult(room, cardIndex);
  result.auto = auto;
  player.current = result;
  player.hasDrawn = true;
  room.updatedAt = Date.now();
  const allDrawn = [...room.players.values()].every((entry) => entry.current);
  if (allDrawn && !room.readyToRevealAt) {
    room.readyToRevealAt = Date.now() + 1600;
  }
  return result;
}

function beginRound(room, at = Date.now()) {
  room.phase = 'round';
  room.roundStartedAt = at;
  room.readyToRevealAt = 0;
  room.revealUntil = 0;
  for (const player of room.players.values()) {
    player.current = null;
    player.hasDrawn = false;
  }
  room.updatedAt = at;
}

function finalizeRound(room, at = Date.now()) {
  if (room.phase !== 'round') return;
  for (const player of room.players.values()) {
    if (!player.current) {
      takeCard(room, player, randomInt(0, 3), true);
    }
    player.score += player.current.points;
    player.roundScores[room.roundIndex] = player.current;
    player.hasDrawn = true;
  }
  room.phase = 'reveal';
  room.revealUntil = at + REVEAL_MS;
  room.readyToRevealAt = 0;
  room.updatedAt = at;
}

function startGame(room, at = Date.now()) {
  if (room.players.size < MIN_PLAYERS) {
    throw new ApiError(409, `至少 ${MIN_PLAYERS} 人才能开局`);
  }
  for (const player of room.players.values()) {
    player.score = 0;
    player.roundScores = [];
    player.current = null;
    player.hasDrawn = false;
  }
  room.roundIndex = 0;
  room.finishedAt = 0;
  room.reactions = [];
  room.gameId = crypto.randomUUID();
  beginRound(room, at);
}

function ensureHost(room, at = Date.now()) {
  if (room.players.size === 0) return;
  const current = room.players.get(room.hostId);
  if (current && at - current.lastSeen < 60000) return;
  const candidates = [...room.players.values()].sort((a, b) => {
    const aOnline = at - a.lastSeen < 12000 ? 1 : 0;
    const bOnline = at - b.lastSeen < 12000 ? 1 : 0;
    return bOnline - aOnline || a.joinedAt - b.joinedAt;
  });
  if (candidates[0] && candidates[0].id !== room.hostId) {
    room.hostId = candidates[0].id;
    room.updatedAt = at;
  }
}

function advanceRoom(room, at = Date.now()) {
  ensureHost(room, at);

  if (room.phase === 'round') {
    const players = [...room.players.values()];
    const allDrawn = players.length > 0 && players.every((player) => player.current);
    const deadline = room.roundStartedAt + ROUND_MS;
    if (allDrawn && room.readyToRevealAt && at >= room.readyToRevealAt) {
      finalizeRound(room, at);
    } else if (at >= deadline) {
      for (const player of players) {
        if (!player.current) takeCard(room, player, randomInt(0, 3), true);
      }
      finalizeRound(room, at);
    }
  } else if (room.phase === 'reveal' && at >= room.revealUntil) {
    if (room.roundIndex < 2) {
      room.roundIndex += 1;
      beginRound(room, at);
    } else {
      room.phase = 'finished';
      room.finishedAt = at;
      room.updatedAt = at;
    }
  }
}

function competitionRanks(players) {
  let previousScore = null;
  let previousRank = 0;
  return players.map((player, index) => {
    const rank = player.score === previousScore ? previousRank : index + 1;
    previousScore = player.score;
    previousRank = rank;
    return { ...player, rank };
  });
}

function rankedPlayers(room) {
  const sorted = [...room.players.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aBest = Math.max(0, ...a.roundScores.map((entry) => entry?.points || 0));
    const bBest = Math.max(0, ...b.roundScores.map((entry) => entry?.points || 0));
    if (bBest !== aBest) return bBest - aBest;
    return a.joinedAt - b.joinedAt;
  });
  return competitionRanks(sorted);
}

function titleFor(rank, total) {
  if (rank === 1) return { label: '群聊欧皇', line: '建议立刻去买张彩票' };
  if (rank === 2) return { label: '欧气亚军', line: '就差一点偷走欧气' };
  if (rank === 3) return { label: '幸运季军', line: '稳稳站上领奖台' };
  if (rank === total && total > 3) return { label: '非酋保护协会', line: '今天适合躺平' };
  return { label: '气氛组组长', line: '快乐才是第一' };
}

function roundResults(room) {
  const sorted = [...room.players.values()].sort((a, b) => {
    const ap = a.current?.points || 0;
    const bp = b.current?.points || 0;
    if (bp !== ap) return bp - ap;
    const av = a.current?.value || 0;
    const bv = b.current?.value || 0;
    if (bv !== av) return bv - av;
    return a.joinedAt - b.joinedAt;
  });
  const ranked = competitionRanks(sorted.map((player) => ({
    ...player,
    score: player.current?.points || 0,
  })));
  return ranked.map((player) => ({
    rank: player.rank,
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    gradient: player.gradient,
    result: player.current,
    score: player.score,
  }));
}

function publicState(room, viewer) {
  const at = Date.now();
  const revealed = room.phase === 'reveal' || room.phase === 'finished';
  const ranked = room.phase === 'finished' ? rankedPlayers(room) : [];
  const rankMap = new Map(ranked.map((entry) => [entry.id, entry.rank]));
  const players = [...room.players.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((player) => {
      const showResult = revealed || player.id === viewer.id;
      return {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        gradient: player.gradient,
        score: player.score,
        hasDrawn: Boolean(player.current),
        online: at - player.lastSeen < 12000,
        isHost: room.hostId === player.id,
        result: showResult ? player.current : null,
        rank: rankMap.get(player.id) || null,
      };
    });

  const me = players.find((player) => player.id === viewer.id);
  const maxScore = Math.max(0, ...players.map((player) => player.score));
  const winnerIds = room.phase === 'finished'
    ? players.filter((player) => player.score === maxScore).map((player) => player.id)
    : [];

  const reactions = room.reactions
    .filter((entry) => at - entry.at < 9000)
    .map((entry) => ({ id: entry.id, emoji: entry.emoji, playerId: entry.playerId }));

  const total = players.length;
  const finalStandings = ranked.map((player) => ({
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    gradient: player.gradient,
    score: player.score,
    rank: player.rank,
    title: titleFor(player.rank, total),
    best: Math.max(0, ...player.roundScores.map((entry) => entry?.points || 0)),
  }));

  return {
    code: room.code,
    phase: room.phase,
    round: room.roundIndex + 1,
    totalRounds: 3,
    roundName: ROUND_COPY[room.roundIndex]?.name || '',
    multiplier: roundMultiplier(room),
    hostId: room.hostId,
    meId: viewer.id,
    me,
    players,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    canStart: room.phase === 'lobby' && isHost(room, viewer) && players.length >= MIN_PLAYERS,
    canDraw: room.phase === 'round' && !me?.hasDrawn,
    canReplay: room.phase === 'finished' && isHost(room, viewer),
    deadline: room.phase === 'round' ? room.roundStartedAt + ROUND_MS : null,
    revealUntil: room.phase === 'reveal' ? room.revealUntil : null,
    roundMs: ROUND_MS,
    revealMs: REVEAL_MS,
    roundResults: revealed ? roundResults(room) : null,
    standings: room.phase === 'finished' ? finalStandings : null,
    winnerIds,
    reactions,
    serverNow: at,
  };
}

function resetToLobby(room) {
  room.phase = 'lobby';
  room.roundIndex = 0;
  room.roundStartedAt = 0;
  room.readyToRevealAt = 0;
  room.revealUntil = 0;
  room.finishedAt = 0;
  room.reactions = [];
  room.gameId = '';
  for (const player of room.players.values()) {
    player.score = 0;
    player.current = null;
    player.hasDrawn = false;
    player.roundScores = [];
  }
  room.updatedAt = Date.now();
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new ApiError(413, '请求内容太大了');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, '请求格式不正确');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function firstHeader(req, name) {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw || '').trim();
}

function isPrivateIp(ip) {
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:|fc00:|fd00:)/i.test(ip);
}

// 部署在反向代理后面时，socket 地址是代理的地址。只在这种「直连方是内网地址」的
// 情况下才信任转发头，避免公网直连时被伪造请求头绕过限流。
function clientIp(req) {
  const direct = (req.socket.remoteAddress || '').replace(/^::ffff:/i, '');
  const trustProxy = process.env.TRUST_PROXY === '1' || isPrivateIp(direct);
  if (!trustProxy) return direct || 'unknown';

  const cloudflare = firstHeader(req, 'cf-connecting-ip');
  if (cloudflare) return cloudflare;

  const forwarded = firstHeader(req, 'x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',').map((entry) => entry.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1].replace(/^::ffff:/i, '');
  }
  return direct || 'unknown';
}

function originFor(req) {
  const proto = firstHeader(req, 'x-forwarded-proto').split(',')[0].trim() === 'https' ? 'https' : 'http';
  const host = firstHeader(req, 'x-forwarded-host').split(',')[0].trim() || firstHeader(req, 'host');
  if (!host || !/^[A-Za-z0-9.\-:\[\]]{1,255}$/.test(host)) return '';
  return `${proto}://${host}`;
}

// 群聊里抓取预览图的爬虫不一定会解析相对地址，这里补成绝对地址。
function absolutizeIndex(html, origin, pagePath = '/') {
  if (!origin) return html;
  const canonical = `${origin}${pagePath}`;
  return html
    .replace(/(<meta property="og:image" content=")\/og\.png(")/, `$1${origin}/og.png$2`)
    .replace(/(<meta name="twitter:image" content=")\/og\.png(")/, `$1${origin}/og.png$2`)
    .replace(
      /(<meta property="og:type" content="website">)/,
      `$1\n  <meta property="og:url" content="${canonical}">\n  <link rel="canonical" href="${canonical}">`,
    );
}

function rateLimit(req, action, limit, windowMs) {
  const ip = clientIp(req);
  const key = `${action}:${ip}`;
  const at = Date.now();
  const bucket = (rateBuckets.get(key) || []).filter((entry) => at - entry < windowMs);
  if (bucket.length >= limit) throw new ApiError(429, '操作有点频繁，稍等一下');
  bucket.push(at);
  rateBuckets.set(key, bucket);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[1] === 'health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
    });
  }

  if (parts[1] !== 'rooms') throw new ApiError(404, '接口不存在');

  if (req.method === 'POST' && parts.length === 2) {
    rateLimit(req, 'create', 12, 60_000);
    const body = await readJson(req);
    const { room, player } = createRoom(body.name);
    return sendJson(res, 201, {
      ok: true,
      token: player.token,
      playerId: player.id,
      state: publicState(room, player),
    });
  }

  const room = findRoom(parts[2]);
  advanceRoom(room);

  if (req.method === 'POST' && parts[3] === 'join' && parts.length === 4) {
    rateLimit(req, 'join', 30, 60_000);
    const body = await readJson(req);
    const supplied = String(body.token || req.headers['x-player-token'] || '');
    let player = supplied
      ? [...room.players.values()].find((entry) => entry.token === supplied)
      : null;

    if (player) {
      player.lastSeen = Date.now();
      if (body.name) player.name = cleanName(body.name);
    } else {
      player = joinRoom(room, body.name);
    }
    return sendJson(res, 200, {
      ok: true,
      token: player.token,
      playerId: player.id,
      state: publicState(room, player),
    });
  }

  const player = authenticate(room, req);

  if (req.method === 'GET' && parts.length === 3) {
    return sendJson(res, 200, { ok: true, state: publicState(room, player) });
  }

  if (req.method === 'POST' && parts[3] === 'start' && parts.length === 4) {
    if (!isHost(room, player)) throw new ApiError(403, '只有房主能开局');
    if (room.phase !== 'lobby') throw new ApiError(409, '对局已经开始了');
    startGame(room);
    return sendJson(res, 200, { ok: true, state: publicState(room, player) });
  }

  if (req.method === 'POST' && parts[3] === 'draw' && parts.length === 4) {
    if (room.phase !== 'round') throw new ApiError(409, '现在还不能抽卡');
    const body = await readJson(req);
    const index = Number(body.index);
    if (!Number.isInteger(index) || index < 0 || index > 2) {
      throw new ApiError(400, '请选择一张命运卡');
    }
    const result = takeCard(room, player, index);
    return sendJson(res, 200, {
      ok: true,
      result,
      state: publicState(room, player),
    });
  }

  if (req.method === 'POST' && parts[3] === 'reaction' && parts.length === 4) {
    const body = await readJson(req);
    const emoji = String(body.emoji || '');
    if (!REACTION_SET.has(emoji)) throw new ApiError(400, '不支持这个表情');
    const at = Date.now();
    if (at - player.lastReactionAt < 700) throw new ApiError(429, '慢一点，欧气要溢出了');
    player.lastReactionAt = at;
    room.reactionSeq += 1;
    const reaction = {
      id: `${room.reactionSeq}-${crypto.randomBytes(3).toString('hex')}`,
      emoji,
      playerId: player.id,
      at,
    };
    room.reactions.push(reaction);
    room.reactions = room.reactions.slice(-30);
    room.updatedAt = at;
    return sendJson(res, 200, { ok: true, reaction });
  }

  if (req.method === 'POST' && parts[3] === 'again' && parts.length === 4) {
    if (!isHost(room, player)) throw new ApiError(403, '只有房主能再开一局');
    if (room.phase !== 'finished') throw new ApiError(409, '这一局还没结束');
    resetToLobby(room);
    return sendJson(res, 200, { ok: true, state: publicState(room, player) });
  }

  if (req.method === 'POST' && parts[3] === 'leave' && parts.length === 4) {
    if (room.phase === 'round' || room.phase === 'reveal') {
      throw new ApiError(409, '对局进行中，抽完这一局再走吧');
    }
    room.players.delete(player.id);
    if (room.players.size === 0) {
      rooms.delete(room.code);
    } else if (room.hostId === player.id) {
      ensureHost(room, Date.now() + 120000);
    }
    return sendJson(res, 200, { ok: true });
  }

  throw new ApiError(404, '接口不存在');
}

async function serveStatic(req, res, pathname) {
  let relative;
  if (pathname === '/' || /^\/r\/[A-Za-z0-9]{4,8}\/?$/.test(pathname)) {
    relative = 'index.html';
  } else {
    relative = pathname.replace(/^\/+/, '');
  }

  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const ext = path.extname(filePath).toLowerCase();
    let body = await readFile(filePath);
    if (relative === 'index.html') {
      const pagePath = /^\/r\/[A-Za-z0-9]{4,8}\/?$/.test(pathname) ? pathname : '/';
      body = Buffer.from(absolutizeIndex(body.toString('utf8'), originFor(req), pagePath), 'utf8');
    }
    const isHtml = ext === '.html';
    const isCode = isHtml || ['.css', '.js', '.mjs', '.webmanifest'].includes(ext);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': isCode ? 'no-store, max-age=0' : 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'self'",
      ].join('; '),
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>404</title><body style="background:#0b0720;color:#fff;font-family:sans-serif;display:grid;place-items:center;height:100vh">页面不存在 <a style="color:#ffd166" href="/">回首页</a></body>');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      return res.end();
    }
    await serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(res, error.status, { ok: false, error: error.message });
    } else {
      console.error('[error]', error);
      sendJson(res, 500, { ok: false, error: '服务器打了个喷嚏，稍后再试' });
    }
  }
});

const cleanup = setInterval(() => {
  const at = Date.now();
  for (const [code, room] of rooms) {
    if (at - room.updatedAt > ROOM_TTL) rooms.delete(code);
  }
  for (const [key, bucket] of rateBuckets) {
    const fresh = bucket.filter((entry) => at - entry < 120_000);
    if (fresh.length) rateBuckets.set(key, fresh);
    else rateBuckets.delete(key);
  }
}, 5 * 60 * 1000);
cleanup.unref();

server.listen(PORT, HOST, () => {
  if (process.env.QUIET === '1') return;
  console.log('');
  console.log('  ✦ 欧气对决已启动');
  console.log(`    本机   http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`    局域网 http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});

export { server };

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
