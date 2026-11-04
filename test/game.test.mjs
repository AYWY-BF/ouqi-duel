import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let roomCode;

async function api(pathname, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['x-player-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function createPlayer(name) {
  return api('/api/rooms', { method: 'POST', body: { name } });
}

async function joinPlayer(code, name) {
  return api(`/api/rooms/${code}/join`, { method: 'POST', body: { name } });
}

async function waitFor(check, { timeout = 12000, interval = 100 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`waitFor timed out: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

async function fetchState(token) {
  return (await api(`/api/rooms/${roomCode}`, { token })).state;
}

async function drawBoth(hostToken, guestToken) {
  await api(`/api/rooms/${roomCode}/draw`, { method: 'POST', token: hostToken, body: { index: 1 } });
  await api(`/api/rooms/${roomCode}/draw`, { method: 'POST', token: guestToken, body: { index: 2 } });
  return waitFor(async () => {
    const current = await fetchState(hostToken);
    return current.phase === 'reveal' ? current : null;
  }, { timeout: 8000, interval: 120 });
}

before(async () => {
  process.env.PORT = String(PORT);
  process.env.ROUND_MS = '2500';
  process.env.REVEAL_MS = '300';
  process.env.QUIET = '1';
  ({ server } = await import(pathToFileURL(path.join(ROOT, 'server.mjs')).href));

  await waitFor(async () => {
    try {
      const response = await fetch(`${BASE}/api/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, { timeout: 10000, interval: 120 });
});

after(async () => {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
});

test('完整三回合对局：隐藏结果、开奖、结算、再来一局与超时代抽', async () => {
  const host = await createPlayer('锦鲤阿豪');
  roomCode = host.state.code;
  assert.equal(host.state.phase, 'lobby');
  assert.equal(host.state.players.length, 1);
  assert.equal(host.state.canStart, false);

  const guest = await joinPlayer(roomCode, '柠檬精');
  assert.equal(guest.state.players.length, 2);

  await assert.rejects(
    api(`/api/rooms/${roomCode}/start`, { method: 'POST', token: guest.token }),
    (error) => error.status === 403,
  );

  const started = await api(`/api/rooms/${roomCode}/start`, { method: 'POST', token: host.token });
  assert.equal(started.state.phase, 'round');
  assert.equal(started.state.round, 1);
  assert.equal(started.state.multiplier, 1);
  assert.equal(started.state.canDraw, true);

  const first = await api(`/api/rooms/${roomCode}/draw`, {
    method: 'POST',
    token: host.token,
    body: { index: 0 },
  });
  assert.equal(first.state.phase, 'round');
  assert.equal(first.state.me.result.value, first.result.value);
  assert.ok(first.result.value >= 1 && first.result.value <= 135);
  assert.equal(first.result.points, first.result.value * 1);

  const guestView = await fetchState(guest.token);
  const hiddenHost = guestView.players.find((player) => player.id === host.playerId);
  assert.equal(hiddenHost.hasDrawn, true);
  assert.equal(hiddenHost.result, null, '开奖前不能泄露其他玩家的结果');

  await assert.rejects(
    api(`/api/rooms/${roomCode}/draw`, { method: 'POST', token: host.token, body: { index: 1 } }),
    (error) => error.status === 409,
  );

  await api(`/api/rooms/${roomCode}/reaction`, {
    method: 'POST',
    token: guest.token,
    body: { emoji: '🍋' },
  });

  await api(`/api/rooms/${roomCode}/draw`, {
    method: 'POST',
    token: guest.token,
    body: { index: 1 },
  });

  const reveal1 = await waitFor(async () => {
    const current = await fetchState(host.token);
    return current.phase === 'reveal' ? current : null;
  });
  assert.equal(reveal1.roundResults.length, 2);
  assert.ok(reveal1.roundResults.every((row) => row.result && row.result.value >= 1));
  assert.ok(reveal1.players.every((player) => player.result));
  assert.equal(
    reveal1.players.reduce((sum, player) => sum + player.score, 0),
    reveal1.roundResults.reduce((sum, row) => sum + row.score, 0),
  );

  const round2 = await waitFor(async () => {
    const current = await fetchState(host.token);
    return current.phase === 'round' && current.round === 2 ? current : null;
  });
  assert.equal(round2.multiplier, 2);
  assert.ok(round2.players.every((player) => player.result === null));

  await assert.rejects(
    api(`/api/rooms/${roomCode}/join`, { method: 'POST', body: { name: '迟到的人' } }),
    (error) => error.status === 409,
  );

  const reveal2 = await drawBoth(host.token, guest.token);
  assert.equal(reveal2.roundResults.length, 2);
  assert.ok(reveal2.roundResults.every((row) => row.result.multiplier === 2));

  await waitFor(async () => {
    const current = await fetchState(host.token);
    return current.phase === 'round' && current.round === 3 ? current : null;
  });
  const reveal3 = await drawBoth(host.token, guest.token);
  assert.ok(reveal3.roundResults.every((row) => row.result.multiplier === 3));

  const finished = await waitFor(async () => {
    const current = await fetchState(host.token);
    return current.phase === 'finished' ? current : null;
  }, { timeout: 10000 });
  assert.equal(finished.standings.length, 2);
  assert.equal(finished.winnerIds.length >= 1, true);
  const maxScore = Math.max(...finished.standings.map((player) => player.score));
  assert.equal(Math.max(...finished.players.map((player) => player.score)), maxScore);
  assert.ok(finished.standings.every((player) => player.title.label));
  assert.equal(finished.canReplay, true);

  const replay = await api(`/api/rooms/${roomCode}/again`, { method: 'POST', token: host.token });
  assert.equal(replay.state.phase, 'lobby');
  assert.ok(replay.state.players.every((player) => player.score === 0));

  const secondGame = await api(`/api/rooms/${roomCode}/start`, { method: 'POST', token: host.token });
  assert.equal(secondGame.state.phase, 'round');
  await api(`/api/rooms/${roomCode}/draw`, {
    method: 'POST',
    token: host.token,
    body: { index: 0 },
  });

  const autoReveal = await waitFor(async () => {
    const current = await fetchState(host.token);
    return current.phase === 'reveal' ? current : null;
  }, { timeout: 7000 });
  const autoPlayer = autoReveal.roundResults.find((row) => row.id === guest.playerId);
  assert.equal(autoPlayer.result.auto, true, '超时玩家应被自动代抽');
});
