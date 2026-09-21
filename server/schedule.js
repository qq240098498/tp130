// 整季编排：按参赛球队单循环一键生成。轮转法保证每轮每队至多一场、整季任意两队恰好碰一次；
// 主客按最少断续轮换，没有队全主或全客；每轮隔一周，场地取主队主场，当天不可用顺延到最近可用日
const crypto = require('crypto');
const { load, save } = require('./store');
const { ApiError } = require('./errors');
const { checkDate } = require('./matches');

const DAY_MS = 24 * 60 * 60 * 1000;
// 同一块场地同一天的开赛时刻档，相邻两档都隔两小时以上，与单场校验的口径一致
const KICKOFF_SLOTS = ['15:30', '19:30', '11:30'];

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// 轮转法排对阵：最后一支固定不动，其余每轮旋转。奇数队时多算一个位置当轮空，
// 该位置的对阵直接跳过，对应的队那一轮休息
function buildPairings(count) {
  const size = count % 2 === 0 ? count : count + 1;
  const last = size - 1;
  const rounds = [];
  for (let round = 0; round < size - 1; round += 1) {
    const pairs = [];
    for (let i = 0; i < last; i += 1) {
      const j = (((round - i) % last) + last) % last;
      if (j === i) pairs.push([i, last]);
      else if (i < j) pairs.push([i, j]);
    }
    rounds.push(pairs);
  }
  return { rounds, size };
}

// 主客轮换：前半区球队双数轮主场、后半区单数轮主场，每队在自己的断续轮之后翻转相位，
// 这样整季没有队全主或全客，连续同主客的断续次数压到最少；同一对若再排一轮，主客自然互换
function pickHome(pair, round, size) {
  const half = size / 2;
  const homeAt = (t) => {
    let home = t < half ? round % 2 === 0 : round % 2 !== 0;
    if (round > 2 * (t % half)) home = !home;
    return home;
  };
  return homeAt(pair[0]) ? pair[0] : pair[1];
}

// 一场的落期与时刻：先按主场可用日顺延，再看同场地同天的时刻档排不排得下，排不下继续往后挪
function placeMatch(venue, baseDate, slotsUsed) {
  let date = baseDate;
  let shift = 0;
  let unavailable = false;
  let clash = false;
  let kickoff = KICKOFF_SLOTS[0];
  if (venue) {
    while (!venue.weekdays.includes(weekdayOf(date))) {
      date = addDays(date, 1);
      shift += 1;
      unavailable = true;
    }
    for (;;) {
      const key = `${venue.id}|${date}`;
      const used = slotsUsed.get(key) || 0;
      if (used < KICKOFF_SLOTS.length) {
        slotsUsed.set(key, used + 1);
        kickoff = KICKOFF_SLOTS[used];
        break;
      }
      date = addDays(date, 1);
      shift += 1;
      clash = true;
      while (!venue.weekdays.includes(weekdayOf(date))) {
        date = addDays(date, 1);
        shift += 1;
        unavailable = true;
      }
    }
  }
  const reasons = [];
  if (unavailable) reasons.push('主场当天不可用');
  if (clash) reasons.push('主场排期冲突');
  return {
    date,
    kickoff,
    shift,
    note: reasons.length ? `${reasons.join('、')}，顺延 ${shift} 天` : '',
  };
}

function generateSeason(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  let startDate;
  try {
    startDate = checkDate(source.startDate);
  } catch (err) {
    if (err instanceof ApiError) err.field = 'startDate';
    throw err;
  }
  const replace = source.replace === true;
  if (data.matches.length > 0 && !replace) {
    throw new ApiError(409, 'SCHEDULE_EXISTS', `已经有 ${data.matches.length} 场赛程，生成整季会把它们全部清空重排，确认后勾上覆盖再提交`, 'replace');
  }

  const teams = data.teams
    .filter((item) => item.status === '参赛')
    .sort((a, b) => a.seedRank - b.seedRank);
  if (teams.length < 2) {
    throw new ApiError(409, 'TEAMS_NOT_ENOUGH', '参赛球队不足两支，没法编排整季赛程', '');
  }

  const venueMap = new Map(data.venues.map((item) => [item.id, item]));
  const { rounds, size } = buildPairings(teams.length);
  const slotsUsed = new Map();
  const now = new Date().toISOString();
  const created = [];
  let shifted = 0;

  rounds.forEach((pairs, roundIndex) => {
    const baseDate = addDays(startDate, roundIndex * 7);
    pairs.forEach((pair) => {
      const homeIndex = pickHome(pair, roundIndex, size);
      const home = teams[homeIndex];
      const away = teams[pair[0] === homeIndex ? pair[1] : pair[0]];
      if (!home || !away) return; // 轮空的位置不产出场次
      const venue = venueMap.get(home.venueId) || null;
      const placed = placeMatch(venue, baseDate, slotsUsed);
      if (placed.shift > 0) shifted += 1;
      created.push({
        id: crypto.randomUUID(),
        round: roundIndex + 1,
        date: placed.date,
        kickoff: placed.kickoff,
        venueId: '', // 留空跟随主队主场，以后换主场不用改赛程
        homeTeamId: home.id,
        awayTeamId: away.id,
        status: '待赛',
        homeGoals: null,
        awayGoals: null,
        note: placed.note,
        createdAt: now,
        updatedAt: now,
      });
    });
  });

  data.matches = created;
  save(data);

  return {
    season: data.meta.season,
    teamCount: teams.length,
    rounds: rounds.length,
    matches: created.length,
    shifted,
    startDate,
    endDate: created.reduce((max, item) => (item.date > max ? item.date : max), startDate),
  };
}

module.exports = { generateSeason, buildPairings, pickHome, placeMatch, addDays, weekdayOf, KICKOFF_SLOTS };
