export function matchIdFromPathname(pathname) {
  const match = /^\/matches\/(\d+)\/?$/.exec(pathname);
  if (!match) return null;
  const matchId = Number(match[1]);
  return Number.isSafeInteger(matchId) && matchId > 0 ? matchId : null;
}

export function candidateMonths(manifest, matchId) {
  if (!manifest || !Array.isArray(manifest.ranges)) {
    throw new TypeError('historical manifest must contain ranges');
  }
  return manifest.ranges.filter(
    (range) => matchId >= range.min_match_id && matchId <= range.max_match_id,
  );
}

export async function resolveHistoricalMatch(matchId, { manifest, loadMonth }) {
  if (!Number.isSafeInteger(matchId) || matchId <= 0) {
    throw new TypeError('historical match id must be a positive safe integer');
  }
  if (typeof loadMonth !== 'function') {
    throw new TypeError('historical route requires a month loader');
  }

  const candidates = candidateMonths(manifest, matchId);
  const payloads = await Promise.all(candidates.map(async (range) => ({
    month: range.month,
    payload: await loadMonth(range.month),
  })));
  const matches = payloads.flatMap(({ month, payload }) => {
    if (!payload || !Array.isArray(payload.matches)) {
      throw new TypeError(`historical payload ${month} must contain matches`);
    }
    return payload.matches.filter((match) => match.match_id === matchId);
  });

  return Object.freeze({
    status: matches.length > 0 ? 'found' : 'not-found',
    match: matches[0] ?? null,
    candidateMonths: Object.freeze(candidates.map((range) => range.month)),
    checkedMonths: Object.freeze(payloads.map(({ month }) => month)),
  });
}

export function historicalRouteView(matchId, resolved, references) {
  if (resolved.status === 'not-found') {
    return Object.freeze({
      status: 'not-found',
      title: 'Match not found',
      markup: `<p>Match ${matchId} is not present in the committed archive.</p>`,
      summary: null,
    });
  }
  if (resolved.status !== 'found' || !resolved.match) {
    throw new TypeError('historical route view requires a found or not-found result');
  }

  const summary = createMatchSummary(resolved.match, references);
  return Object.freeze({
    status: 'found',
    title: `Match ${matchId}`,
    markup: '<section class="match-card historical-summary" '
      + `data-historical-match-id="${matchId}">`
      + renderMatchSummaryMarkup(summary, {
        headingId: 'historical-match-heading',
        headingLevel: 'h2',
        showPatch: true,
      })
      + '</section>',
    summary,
  });
}
import { createMatchSummary } from './match-summary.mjs';
import { renderMatchSummaryMarkup } from './match-summary-markup.mjs';
