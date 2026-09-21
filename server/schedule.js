// 整季单循环编排：固定队轮转法出对阵，按周排日期，场地取主队主场并按可用日顺延
const crypto = require('crypto');
const { load, save } = require('./store');
const { ApiError, pickText } = require('./errors');
const { nameMaps } = require('./standings');
const { checkDate, decorate } = require('./matches');

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MIN_GAP_MINUTES = 120;
const DEFAULT_KICKOFF = '15:30';
const SECOND_KICKOFF = '19:30';
const MIN_TEAMS = 4;

function minutesOf(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// 固定队轮转法：排序后第一支球队不动，其余每轮顺时针转一位。
// n 支队共 n-1 轮、每轮 n/2 场，任意两支队恰好碰上一次
function buildPairings(teamIds) {
  const order = teamIds.slice();
  const rounds = [];
  for (let round = 0; round < order.length - 1; round += 1) {
    const games = [];
    for (let i = 0; i < order.length / 2; i += 1) {
      const left = order[i];
      const right = order[order.length - 1 - i];
      // 主客分配：首尾位按轮次换边，其余位按位置奇偶换边。
      // 这样每支队主客只差一场（n/2 或 n/2-1），不会全挤在一边
      const homeIsLeft = i === 0 ? round % 2 === 0 : i % 2 === 0;
      games.push(homeIsLeft ? { homeTeamId: left, awayTeamId: right } : { homeTeamId: right, awayTeamId: left });
    }
    rounds.push(games);
    const fixed = order[0];
    const rest = order.slice(1);
    rest.unshift(rest.pop());
    order.splice(0, order.length, fixed, ...rest);
  }
  return rounds;
}

// 主队主场当天不是可用日就逐日向后找最近的可用日；同一块场地同一天排两场时，
// 两场至少隔两小时（15:30 之后再排 19:30），排不下就继续顺延一天
function resolveSlot(base, venue, kickoff, booked) {
  const usableTimes = kickoff === DEFAULT_KICKOFF
    ? [DEFAULT_KICKOFF, SECOND_KICKOFF]
    : [kickoff];
  let cursor = new Date(base.getTime());
  for (let guard = 0; guard < 366; guard += 1) {
    if (venue.weekdays.includes(cursor.getUTCDay())) {
      const date = formatDate(cursor);
      const taken = booked.get(`${venue.id}|${date}`) || [];
      const time = usableTimes.find((candidate) => taken.every((used) => Math.abs(minutesOf(used) - minutesOf(candidate)) >= MIN_GAP_MINUTES));
      if (time) {
        booked.set(`${venue.id}|${date}`, taken.concat(time));
        return { date, kickoff: time, shift: Math.round((cursor.getTime() - base.getTime()) / 86400000) };
      }
    }
    cursor = addDays(cursor, 1);
  }
  throw new ApiError(400, 'VENUE_NO_AVAILABLE_DAY', `${venue.name} 往后一整年都排不下，请检查它的可用日`, '');
}

// 一键生成整季赛程：已有赛果时拒绝整季重排，其余旧场次全部被新编排替换
function generateSchedule(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const data = load();

  const locked = data.matches.filter((item) => item.status === '已赛');
  if (locked.length > 0) {
    throw new ApiError(409, 'SEASON_STARTED', `已有 ${locked.length} 场打完并登记了比分，整季重排会丢掉赛果；请先清空这些场次再生成`, '');
  }
  const replaced = data.matches.length;
  const removedPostponed = data.matches.filter((item) => item.status === '延期').length;

  const teams = data.teams
    .filter((item) => item.status === '参赛')
    .sort((a, b) => (a.seedRank - b.seedRank) || (a.id < b.id ? -1 : 1));
  if (teams.length < MIN_TEAMS || teams.length % 2 !== 0) {
    throw new ApiError(400, 'TEAM_COUNT_INVALID', `单循环编排至少要有 ${MIN_TEAMS} 支参赛球队且队数成双，现在是 ${teams.length} 支`, '');
  }

  const startDateText = checkDate(source.startDate);
  const startDate = new Date(`${startDateText}T00:00:00.000Z`);
  const kickoff = pickText(source.kickoff) || DEFAULT_KICKOFF;
  if (!TIME_PATTERN.test(kickoff)) {
    throw new ApiError(400, 'KICKOFF_INVALID', '开赛时刻要写成两位小时加冒号加两位分钟，例如 15:30', 'kickoff');
  }

  const venueById = new Map(data.venues.map((item) => [item.id, item]));
  const homeVenueOf = new Map();
  teams.forEach((team) => {
    const venue = venueById.get(team.venueId);
    if (!venue) {
      throw new ApiError(400, 'HOME_VENUE_MISSING', `${team.name} 没有登记主场场地，没法按主队主场排日期`, '');
    }
    if (!venue.weekdays || venue.weekdays.length === 0) {
      throw new ApiError(400, 'VENUE_WEEKDAYS_MISSING', `${venue.name} 没有登记可用日，没法把 ${team.name} 的主场排进去`, '');
    }
    homeVenueOf.set(team.id, venue);
  });

  const rounds = buildPairings(teams.map((team) => team.id));
  const now = new Date().toISOString();
  const created = [];
  const roundPlan = [];
  rounds.forEach((games, roundIndex) => {
    const round = roundIndex + 1;
    const base = addDays(startDate, roundIndex * 7);
    const baseText = formatDate(base);
    // 场地占用只需要在本轮内登记：每轮跨度最多六天，下一轮从第七天起，区间不相交
    const booked = new Map();
    const dates = [];
    games.forEach((game) => {
      const venue = homeVenueOf.get(game.homeTeamId);
      const slot = resolveSlot(base, venue, kickoff, booked);
      dates.push(slot.date);
      const note = slot.shift > 0
        ? `原计划 ${baseText}，${venue.name} 当天不是可用日，顺延 ${slot.shift} 天至 ${slot.date}`
        : '';
      created.push({
        id: crypto.randomUUID(),
        round,
        date: slot.date,
        kickoff: slot.kickoff,
        venueId: '',
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        status: '待赛',
        homeGoals: null,
        awayGoals: null,
        note,
        createdAt: now,
        updatedAt: now,
      });
    });
    roundPlan.push({ round, date: baseText, earliestDate: dates.slice().sort()[0], latestDate: dates.slice().sort().reverse()[0] });
  });

  data.matches = created;
  save(data);

  const { teams: teamMap, venues } = nameMaps();
  return {
    generated: created.length,
    rounds: roundPlan,
    teamCount: teams.length,
    replaced,
    removedPostponed,
    startDate: startDateText,
    kickoff,
    matches: created.map((item) => decorate(item, teamMap, venues)),
  };
}

module.exports = { generateSchedule, buildPairings };
