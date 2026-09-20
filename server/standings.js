// 积分表的算法：只统计已经打完的场次，按积分、净胜球、进球三项依次比较
const { load } = require('./store');

function emptyRow(team) {
  return {
    teamId: team.id,
    name: team.name,
    shortName: team.shortName,
    city: team.city,
    status: team.status,
    played: 0,
    win: 0,
    draw: 0,
    loss: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    goalDiff: 0,
    points: 0,
    latestRound: 0,
  };
}

// 把一轮比赛的结果累加到两支队身上
function applyMatch(rows, match) {
  const home = rows.get(match.homeTeamId);
  const away = rows.get(match.awayTeamId);
  if (!home || !away) return;
  const homeGoals = Number(match.homeGoals);
  const awayGoals = Number(match.awayGoals);
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return;

  const points = load().meta.points;
  home.played += 1;
  away.played += 1;
  home.goalsFor += homeGoals;
  home.goalsAgainst += awayGoals;
  away.goalsFor += awayGoals;
  away.goalsAgainst += homeGoals;

  if (homeGoals > awayGoals) {
    home.win += 1;
    away.loss += 1;
    home.points += points.win;
    away.points += points.loss;
  } else if (homeGoals === awayGoals) {
    home.draw += 1;
    away.draw += 1;
    home.points += points.draw;
    away.points += points.draw;
  } else {
    away.win += 1;
    home.loss += 1;
    away.points += points.win;
    home.points += points.loss;
  }

  home.goalDiff = home.goalsFor - home.goalsAgainst;
  away.goalDiff = away.goalsFor - away.goalsAgainst;
  home.latestRound = Math.max(home.latestRound, match.round);
  away.latestRound = Math.max(away.latestRound, match.round);
}

// 排序口径：积分高的在前，积分相同看净胜球，再看进球数，最后按名称排
function compareRows(a, b) {
  if (b.points !== a.points) return b.points - a.points;
  if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
  if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
  return a.name < b.name ? -1 : 1;
}

function computeTable(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const rows = new Map();
  data.teams.forEach((team) => rows.set(team.id, emptyRow(team)));

  data.matches
    .filter((match) => match.status === '已赛')
    .forEach((match) => applyMatch(rows, match));

  const list = Array.from(rows.values()).sort(compareRows);
  list.forEach((row, index) => { row.rank = index + 1; });

  const keyword = typeof input.keyword === 'string' ? input.keyword.trim().toLowerCase() : '';
  const filtered = keyword
    ? list.filter((row) => row.name.toLowerCase().includes(keyword) || row.city.toLowerCase().includes(keyword))
    : list;

  return {
    season: data.meta.season,
    points: data.meta.points,
    playedRounds: new Set(data.matches.filter((m) => m.status === '已赛').map((m) => m.round)).size,
    totalRounds: Math.max(...data.matches.map((m) => m.round), 0),
    playedMatches: data.matches.filter((m) => m.status === '已赛').length,
    pendingMatches: data.matches.filter((m) => m.status === '待赛').length,
    postponedMatches: data.matches.filter((m) => m.status === '延期').length,
    table: filtered,
    computedAt: new Date().toISOString(),
  };
}

// 队伍与场地名称的速查表，供赛程清单展示用
function nameMaps() {
  const data = load();
  const teams = new Map(data.teams.map((item) => [item.id, item]));
  const venues = new Map(data.venues.map((item) => [item.id, item]));
  return { teams, venues };
}

module.exports = { computeTable, compareRows, nameMaps };
