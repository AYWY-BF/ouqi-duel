#!/usr/bin/env node
// 演示机器人：给指定房间塞几个"路人玩家"，它们会自动抽卡，
// 让一个人录屏时也能拍出多人对局的画面。
//
// 用法：
//   node tools/demo-bots.mjs --room=ABC12 --bots=4
//   node tools/demo-bots.mjs --room=ABC12 --bots=4 --base=http://127.0.0.1:3000
//   node tools/demo-bots.mjs --room=ABC12 --sharecode=XXXX --base=https://xxx.app.workbuddy.host
//
// 参数：
//   --room      房间码（必填，房主已经在游戏里开好的那个）
//   --bots      机器人数量，默认 4
//   --base      服务地址，默认 http://127.0.0.1:3000
//   --sharecode 托管平台的访问码（线上地址需要）
//   --fast      固定 800ms 内抽卡，节奏更紧凑（默认随机 1.5~4 秒）
//
// 注意：机器人只负责抽卡，不会点「开始对决」——开局节奏还是由你控制。

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const match = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) return [raw, true];
    return [match[1], match[2] === undefined ? true : match[2]];
  }),
);

const roomCode = String(args.room || '').trim().toUpperCase();
if (!roomCode) {
  console.error('缺少房间码。用法：node tools/demo-bots.mjs --room=ABC12 --bots=4');
  process.exit(1);
}

const botCount = Math.max(1, Number(args.bots || 4));
const base = String(args.base || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const shareCode = args.sharecode ? String(args.sharecode) : '';
const fastMode = Boolean(args.fast);

// 可爱的路人名字，避免录出来一片「玩家1 玩家2」
const NAME_POOL = [
  '锦鲤附体',
  '非酋本酋',
  '隔壁老王',
  '摸鱼选手',
  '欧皇降临',
  '手气不错',
  '今天必赢',
  '老板本板',
  '熬夜冠军',
  '玄学大师',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withShareCode(path) {
  if (!shareCode) return `${base}${path}`;
  return `${base}${path}${path.includes('?') ? '&' : '?'}sharecode=${encodeURIComponent(shareCode)}`;
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['x-player-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(withShareCode(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!response.ok) {
    const error = new Error(data?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function drawDelay() {
  if (fastMode) return 400 + Math.floor(Math.random() * 400);
  return 1500 + Math.floor(Math.random() * 2500);
}

async function runBot(name, index) {
  const tag = `[${name}]`;

  let joined = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      joined = await request(`/api/rooms/${roomCode}/join`, {
        method: 'POST',
        body: { name },
      });
      break;
    } catch (error) {
      if (error.status === 409 || error.status === 404) {
        console.log(`${tag} 进不去：${error.message}`);
        return;
      }
      if (attempt === 3) {
        console.log(`${tag} 连不上服务（${error.message}），放弃`);
        return;
      }
      await sleep(1200);
    }
  }
  if (!joined) return;

  const token = joined.token;
  console.log(`${tag} 已进房，当前 ${joined.state.players.length} 人`);

  let lastRound = 0;
  let stopped = false;

  while (!stopped) {
    let state;
    try {
      state = (await request(`/api/rooms/${roomCode}`, { token })).state;
    } catch (error) {
      if (error.status === 401 || error.status === 404) {
        console.log(`${tag} 房间没了或身份失效，退出`);
        return;
      }
      await sleep(1500);
      continue;
    }

    if (state.phase === 'finished') {
      console.log(`${tag} 本局结束`);
      return;
    }

    if (state.phase === 'round' && state.canDraw && !state.me.result) {
      if (state.round !== lastRound) lastRound = state.round;
      await sleep(drawDelay());
      try {
        const picked = Math.floor(Math.random() * 3);
        const after = await request(`/api/rooms/${roomCode}/draw`, {
          method: 'POST',
          token,
          body: { index: picked },
        });
        const value = after.state?.me?.result?.value;
        console.log(`${tag} 第 ${state.round} 回合抽了第 ${picked + 1} 张 → ${value ?? '?'} 点`);
      } catch (error) {
        if (error.status === 401 || error.status === 404) return;
        // 房间已进入开奖等状态，忽略
      }
    }

    await sleep(600 + index * 90);
  }
}

const names = NAME_POOL.slice(0, botCount);
// 名字不够时补编号
while (names.length < botCount) names.push(`路人${names.length + 1}`);

console.log(`准备往房间 ${roomCode} 塞 ${botCount} 个机器人（${base}）`);
if (fastMode) console.log('快速模式：抽卡延迟 0.4~0.8 秒');

for (let index = 0; index < names.length; index += 1) {
  runBot(names[index], index).catch((error) => {
    console.log(`[${names[index]}] 异常退出：${error.message}`);
  });
  await sleep(450);
}

console.log('机器人已就位，按 Ctrl+C 结束\n');
