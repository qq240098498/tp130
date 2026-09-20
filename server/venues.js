const crypto = require('crypto');
const { load, save, MAX_VENUE_NAME, MAX_NOTE } = require('./store');
const { ApiError, pickText, isBlank } = require('./errors');

const WEEKDAY_TEXT = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function validatePayload(input, data, selfId) {
  const source = input && typeof input === 'object' ? input : {};

  const name = pickText(source.name);
  if (!name) throw new ApiError(400, 'NAME_REQUIRED', '请填写场地名称', 'name');
  if (name.length > MAX_VENUE_NAME) throw new ApiError(400, 'NAME_TOO_LONG', `场地名称不能超过 ${MAX_VENUE_NAME} 个字`, 'name');
  if (data.venues.some((item) => item.id !== selfId && item.name === name)) {
    throw new ApiError(409, 'NAME_DUPLICATED', `${name} 已经登记过了`, 'name');
  }

  const city = pickText(source.city);
  if (!city) throw new ApiError(400, 'CITY_REQUIRED', '请填写所在城市', 'city');

  const capacity = Number(source.capacity);
  if (!Number.isInteger(capacity) || capacity < 100 || capacity > 200000) {
    throw new ApiError(400, 'CAPACITY_INVALID', '容量要填 100 到 200000 之间的整数', 'capacity');
  }

  if (!Array.isArray(source.weekdays) || source.weekdays.length === 0) {
    throw new ApiError(400, 'WEEKDAYS_REQUIRED', '至少要选一个可用日', 'weekdays');
  }
  const weekdays = source.weekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (weekdays.length !== source.weekdays.length || new Set(weekdays).size !== weekdays.length) {
    throw new ApiError(400, 'WEEKDAYS_INVALID', '可用日只能各选一次，取值是周日到周六', 'weekdays');
  }

  if (!isBlank(source.note) && String(source.note).length > MAX_NOTE) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE} 个字`, 'note');
  }

  return { name, city, capacity, weekdays: weekdays.slice().sort((a, b) => a - b), note: pickText(source.note) };
}

function withExtras(venue, data) {
  const homeTeams = data.teams.filter((item) => item.venueId === venue.id);
  const matches = data.matches.filter((item) => item.venueId === venue.id).length;
  return {
    ...venue,
    weekdaysText: venue.weekdays.map((day) => WEEKDAY_TEXT[day]).join('、'),
    homeTeams: homeTeams.map((item) => item.name),
    homeTeamCount: homeTeams.length,
    matchCount: matches,
  };
}

function listVenues(options) {
  const input = options && typeof options === 'object' ? options : {};
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.venues.slice();
  if (keyword) {
    list = list.filter((item) => item.name.toLowerCase().includes(keyword) || item.city.toLowerCase().includes(keyword));
  }
  list.sort((a, b) => b.capacity - a.capacity);

  return {
    venues: list.map((item) => withExtras(item, data)),
    total: data.venues.length,
    weekdayText: WEEKDAY_TEXT,
  };
}

function createVenue(payload) {
  const data = load();
  const checked = validatePayload(payload, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.venues.push(created);
  save(data);
  return withExtras(created, data);
}

function updateVenue(id, payload) {
  const data = load();
  const found = data.venues.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'VENUE_NOT_FOUND', '这个场地不存在或已被删除', '');
  const merged = { ...found, ...(payload && typeof payload === 'object' ? payload : {}) };
  const checked = validatePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  return withExtras(found, data);
}

function deleteVenue(id) {
  const data = load();
  const index = data.venues.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'VENUE_NOT_FOUND', '这个场地不存在或已被删除', '');
  const homeCount = data.teams.filter((item) => item.venueId === id).length;
  const matchCount = data.matches.filter((item) => item.venueId === id).length;
  if (homeCount > 0 || matchCount > 0) {
    throw new ApiError(409, 'VENUE_IN_USE', `这个场地还被 ${homeCount} 支球队当主场、${matchCount} 场赛程在用，不能直接删`, '');
  }
  const [removed] = data.venues.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

module.exports = { listVenues, createVenue, updateVenue, deleteVenue, WEEKDAY_TEXT };
