const crypto = require('crypto');
const { load, save, MAX_TEAM_NAME, MAX_SHORT_NAME, MAX_NOTE, MAX_TEAMS, TEAM_STATUS } = require('./store');
const { ApiError, pickText, isBlank } = require('./errors');

const SHORT_PATTERN = /^[A-Z]{2,4}$/;

function validatePayload(input, data, selfId) {
  const source = input && typeof input === 'object' ? input : {};

  const name = pickText(source.name);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写球队名称', 'name');
  if (name.length > MAX_TEAM_NAME) throw new ApiError(400, 'NAME_TOO_LONG', `球队名称不能超过 ${MAX_TEAM_NAME} 个字`, 'name');
  if (data.teams.some((item) => item.id !== selfId && item.name === name)) {
    throw new ApiError(409, 'NAME_DUPLICATED', `${name} 已经登记过了`, 'name');
  }

  const shortName = pickText(source.shortName).toUpperCase();
  if (!shortName) throw new ApiError(400, 'SHORT_REQUIRED', '请填写球队简称', 'shortName');
  if (!SHORT_PATTERN.test(shortName)) {
    throw new ApiError(400, 'SHORT_INVALID', '球队简称用两到四个大写字母，例如 JCTM', 'shortName');
  }
  if (data.teams.some((item) => item.id !== selfId && item.shortName === shortName)) {
    throw new ApiError(409, 'SHORT_DUPLICATED', `简称 ${shortName} 已经有人用了`, 'shortName');
  }

  const city = pickText(source.city);
  if (!city) throw new ApiError(400, 'CITY_REQUIRED', '请填写所属城市', 'city');

  const venueId = pickText(source.venueId);
  if (!venueId) throw new ApiError(400, 'VENUE_REQUIRED', '请指定主场场地', 'venueId');
  if (!data.venues.some((item) => item.id === venueId)) {
    throw new ApiError(404, 'VENUE_NOT_FOUND', '这个场地没有登记过', 'venueId');
  }

  const seedRank = Number(source.seedRank);
  if (!Number.isInteger(seedRank) || seedRank < 1 || seedRank > MAX_TEAMS) {
    throw new ApiError(400, 'SEED_RANK_INVALID', `档位要填 1 到 ${MAX_TEAMS} 之间的整数`, 'seedRank');
  }
  if (data.teams.some((item) => item.id !== selfId && item.seedRank === seedRank)) {
    throw new ApiError(409, 'SEED_RANK_DUPLICATED', `第 ${seedRank} 档已经有人占着了`, 'seedRank');
  }

  const status = pickText(source.status) || '参赛';
  if (!TEAM_STATUS.includes(status)) {
    throw new ApiError(400, 'STATUS_INVALID', '状态只能填参赛或者退赛', 'status');
  }

  if (!isBlank(source.note) && String(source.note).length > MAX_NOTE) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE} 个字`, 'note');
  }

  return { name, shortName, city, venueId, seedRank, status, note: pickText(source.note) };
}

function listTeams(options) {
  const input = options && typeof options === 'object' ? options : {};
  const keyword = pickText(input.keyword).toLowerCase();
  const status = pickText(input.status);
  const data = load();

  let list = data.teams.slice();
  if (status) list = list.filter((item) => item.status === status);
  if (keyword) {
    list = list.filter((item) => item.name.toLowerCase().includes(keyword)
      || item.shortName.toLowerCase().includes(keyword)
      || item.city.toLowerCase().includes(keyword));
  }
  list.sort((a, b) => a.seedRank - b.seedRank);

  const venueMap = new Map(data.venues.map((item) => [item.id, item]));
  return {
    teams: list.map((item) => ({
      ...item,
      venueName: venueMap.has(item.venueId) ? venueMap.get(item.venueId).name : '未指定',
      matchCount: data.matches.filter((m) => m.homeTeamId === item.id || m.awayTeamId === item.id).length,
    })),
    total: data.teams.length,
    activeCount: data.teams.filter((item) => item.status === '参赛').length,
    venueCount: data.venues.length,
    limit: MAX_TEAMS,
  };
}

function createTeam(payload) {
  const data = load();
  const active = data.teams.filter((item) => item.status === '参赛').length;
  if (active >= MAX_TEAMS) {
    throw new ApiError(409, 'TEAM_LIMIT_REACHED', `本赛季最多 ${MAX_TEAMS} 支参赛球队，先让别的队退赛再加`, 'name');
  }
  const checked = validatePayload(payload, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.teams.push(created);
  save(data);
  return created;
}

function updateTeam(id, payload) {
  const data = load();
  const found = data.teams.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'TEAM_NOT_FOUND', '这支球队不存在或已被删除', '');
  const merged = { ...found, ...(payload && typeof payload === 'object' ? payload : {}) };
  const checked = validatePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  return found;
}

function deleteTeam(id) {
  const data = load();
  const index = data.teams.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'TEAM_NOT_FOUND', '这支球队不存在或已被删除', '');
  const related = data.matches.filter((m) => m.homeTeamId === id || m.awayTeamId === id).length;
  if (related > 0) {
    throw new ApiError(409, 'TEAM_IN_USE', `这支球队还有 ${related} 场赛程挂着，要退出赛季请把状态改成退赛`, '');
  }
  const [removed] = data.teams.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

module.exports = { listTeams, createTeam, updateTeam, deleteTeam };
