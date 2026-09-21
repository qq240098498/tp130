const crypto = require('crypto');
const { load, save, MAX_NOTE, MATCH_STATUS } = require('./store');
const { ApiError, pickText } = require('./errors');
const { nameMaps } = require('./standings');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_GAP_MINUTES = 120;

function minutesOf(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function checkDate(value) {
  const date = pickText(value);
  if (!DATE_PATTERN.test(date)) {
    throw new ApiError(400, 'DATE_INVALID', '日期要写成四位年加短横线加两位月日，例如 2026-03-14', 'date');
  }
  const [year, month, day] = date.split('-').map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new ApiError(400, 'DATE_INVALID', '这个日期不存在，请检查月份与日', 'date');
  }
  return date;
}

// 主场场地没填时按主队的主场算，用这块场地去判同日时间冲突
function resolveVenueId(match, data) {
  if (match.venueId) return match.venueId;
  const home = data.teams.find((item) => item.id === match.homeTeamId);
  return home ? home.venueId : '';
}

function validatePayload(input, data, selfId) {
  const source = input && typeof input === 'object' ? input : {};

  const round = Number(source.round);
  if (!Number.isInteger(round) || round < 1 || round > 40) {
    throw new ApiError(400, 'ROUND_INVALID', '轮次要填 1 到 40 之间的整数', 'round');
  }

  const date = checkDate(source.date);

  const kickoff = pickText(source.kickoff);
  if (!TIME_PATTERN.test(kickoff)) {
    throw new ApiError(400, 'KICKOFF_INVALID', '开赛时刻要写成两位小时加冒号加两位分钟，例如 19:30', 'kickoff');
  }

  const homeTeamId = pickText(source.homeTeamId);
  const awayTeamId = pickText(source.awayTeamId);
  if (!data.teams.some((item) => item.id === homeTeamId)) {
    throw new ApiError(404, 'HOME_TEAM_NOT_FOUND', '主队没有登记过', 'homeTeamId');
  }
  if (!data.teams.some((item) => item.id === awayTeamId)) {
    throw new ApiError(404, 'AWAY_TEAM_NOT_FOUND', '客队没有登记过', 'awayTeamId');
  }
  if (homeTeamId === awayTeamId) {
    throw new ApiError(400, 'TEAM_SAME', '主队与客队不能是同一支球队', 'awayTeamId');
  }

  const venueId = pickText(source.venueId);
  if (venueId && !data.venues.some((item) => item.id === venueId)) {
    throw new ApiError(404, 'VENUE_NOT_FOUND', '这个场地没有登记过', 'venueId');
  }

  const status = pickText(source.status) || '待赛';
  if (!MATCH_STATUS.includes(status)) {
    throw new ApiError(400, 'STATUS_INVALID', '状态只能填待赛、已赛、延期或者取消', 'status');
  }

  let homeGoals = null;
  let awayGoals = null;
  if (status === '已赛') {
    homeGoals = Number(source.homeGoals);
    awayGoals = Number(source.awayGoals);
    if (!Number.isInteger(homeGoals) || homeGoals < 0 || homeGoals > 99) {
      throw new ApiError(400, 'GOALS_INVALID', '主队进球数要填 0 到 99 之间的整数', 'homeGoals');
    }
    if (!Number.isInteger(awayGoals) || awayGoals < 0 || awayGoals > 99) {
      throw new ApiError(400, 'GOALS_INVALID', '客队进球数要填 0 到 99 之间的整数', 'awayGoals');
    }
  } else if (source.homeGoals !== undefined && source.homeGoals !== null && source.homeGoals !== '') {
    throw new ApiError(400, 'GOALS_NOT_ALLOWED', '还没打完的场次不能填比分，先把状态改成已赛', 'homeGoals');
  }

  if (source.note !== undefined && source.note !== null && String(source.note).length > MAX_NOTE) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE} 个字`, 'note');
  }

  const candidate = { round, date, kickoff, venueId, homeTeamId, awayTeamId };

  // 同一轮里一支球队只能出现一次
  const sameRound = data.matches.filter((item) => item.id !== selfId && item.round === round
    && (item.homeTeamId === homeTeamId || item.awayTeamId === homeTeamId
      || item.homeTeamId === awayTeamId || item.awayTeamId === awayTeamId));
  if (sameRound.length > 0) {
    throw new ApiError(409, 'ROUND_CONFLICT', `第 ${round} 轮里这两支球队已经各有一场了，同一轮不能重复出场`, 'round');
  }

  // 同一天同一块场地不能挨得太近
  const resolved = resolveVenueId(candidate, data);
  if (resolved) {
    const sameDay = data.matches.filter((item) => item.id !== selfId && item.date === date
      && resolveVenueId(item, data) === resolved && item.status !== '取消');
    const clash = sameDay.find((item) => Math.abs(minutesOf(item.kickoff) - minutesOf(kickoff)) < MIN_GAP_MINUTES);
    if (clash) {
      const venue = data.venues.find((item) => item.id === resolved);
      throw new ApiError(409, 'VENUE_TIME_CONFLICT', `${date} 这天 ${venue ? venue.name : '这块场地'} 的 ${clash.kickoff} 已经有一场了，两场之间至少隔两小时`, 'kickoff');
    }
  }

  return {
    round,
    date,
    kickoff,
    venueId,
    homeTeamId,
    awayTeamId,
    status,
    homeGoals,
    awayGoals,
    note: pickText(source.note),
  };
}

function decorate(match, teams, venues) {
  const home = teams.get(match.homeTeamId);
  const away = teams.get(match.awayTeamId);
  const venue = venues.get(resolveVenueId(match, { teams: Array.from(teams.values()), venues: Array.from(venues.values()) }));
  const scoreText = match.status === '已赛' ? `${match.homeGoals} : ${match.awayGoals}` : '';
  let winner = '';
  if (match.status === '已赛') {
    if (match.homeGoals > match.awayGoals) winner = home ? home.name : '';
    else if (match.homeGoals < match.awayGoals) winner = away ? away.name : '';
    else winner = '平局';
  }
  return {
    ...match,
    homeName: home ? home.name : '未知球队',
    awayName: away ? away.name : '未知球队',
    homeShort: home ? home.shortName : '',
    awayShort: away ? away.shortName : '',
    venueName: venue ? venue.name : '未指定',
    scoreText,
    winner,
  };
}

function listMatches(options) {
  const input = options && typeof options === 'object' ? options : {};
  const round = Number(pickText(input.round));
  const status = pickText(input.status);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();
  const { teams, venues } = nameMaps();

  let list = data.matches.slice();
  if (Number.isInteger(round) && round > 0) list = list.filter((item) => item.round === round);
  if (status) list = list.filter((item) => item.status === status);
  if (keyword) {
    list = list.filter((item) => {
      const home = teams.get(item.homeTeamId);
      const away = teams.get(item.awayTeamId);
      const text = `${home ? home.name + home.shortName + home.city : ''}${away ? away.name + away.shortName + away.city : ''}`;
      return text.toLowerCase().includes(keyword);
    });
  }

  list.sort((a, b) => (a.round - b.round) || (a.date < b.date ? -1 : 1) || (a.kickoff < b.kickoff ? -1 : 1));

  const rounds = Array.from(new Set(data.matches.map((item) => item.round))).sort((a, b) => a - b);
  const roundSummaries = rounds.map((item) => ({
    round: item,
    total: data.matches.filter((m) => m.round === item).length,
    played: data.matches.filter((m) => m.round === item && m.status === '已赛').length,
    pending: data.matches.filter((m) => m.round === item && m.status === '待赛').length,
    postponed: data.matches.filter((m) => m.round === item && m.status === '延期').length,
  }));

  return {
    matches: list.map((item) => decorate(item, teams, venues)),
    total: data.matches.length,
    filtered: list.length,
    rounds: roundSummaries,
    season: data.meta.season,
  };
}

function createMatch(payload) {
  const data = load();
  const checked = validatePayload(payload, data, '');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...checked, createdAt: now, updatedAt: now };
  data.matches.push(created);
  save(data);
  const { teams, venues } = nameMaps();
  return decorate(created, teams, venues);
}

function updateMatch(id, payload) {
  const data = load();
  const found = data.matches.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'MATCH_NOT_FOUND', '这场赛程不存在或已被删除', '');
  const patch = payload && typeof payload === 'object' ? { ...payload } : {};
  // 状态改回没打完时把比分一并清掉，否则这场会卡在带比分又不能改的状态里
  if (patch.status && patch.status !== '已赛' && patch.homeGoals === undefined && patch.awayGoals === undefined) {
    patch.homeGoals = null;
    patch.awayGoals = null;
  }
  const merged = { ...found, ...patch };
  const checked = validatePayload(merged, data, found.id);
  Object.assign(found, checked);
  found.updatedAt = new Date().toISOString();
  save(data);
  const { teams, venues } = nameMaps();
  return decorate(found, teams, venues);
}

// 单独登记比分：登记完自动把这场标成已赛
function recordResult(id, payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return updateMatch(id, {
    status: '已赛',
    homeGoals: source.homeGoals,
    awayGoals: source.awayGoals,
  });
}

function deleteMatch(id) {
  const data = load();
  const index = data.matches.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'MATCH_NOT_FOUND', '这场赛程不存在或已被删除', '');
  const [removed] = data.matches.splice(index, 1);
  save(data);
  return { id: removed.id, round: removed.round };
}

module.exports = {
  listMatches,
  createMatch,
  updateMatch,
  recordResult,
  deleteMatch,
  resolveVenueId,
  decorate,
  checkDate,
};
