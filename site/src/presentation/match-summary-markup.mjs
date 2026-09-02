function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function durationLabel(duration) {
  if (duration.status !== 'available') return 'Duration unavailable';
  const minutes = Math.floor(duration.value / 60);
  const seconds = duration.value % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function scoreLabel(score) {
  return score.status === 'available'
    ? `${score.radiant}–${score.dire}`
    : 'Score unavailable';
}

function resultLabel(result) {
  if (result.status !== 'available') return 'Result unavailable';
  return result.winner === 'radiant' ? 'Radiant won' : 'Dire won';
}

function teamStateLabel(team, showLogoState) {
  const states = [];
  if (team.teamId === null) states.push('Team ID unavailable');
  if (team.name.source === 'reference-tag') states.push('Tag fallback');
  if (team.name.status === 'missing') states.push('No resolved name');
  if (showLogoState && team.logo.status === 'missing') states.push('Logo unavailable');
  return states.join(' · ');
}

const ABSOLUTE_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
});

function dateMarkup(date, display) {
  if (date.status !== 'available') return '<span>Time unavailable</span>';
  const datetime = escapeHtml(date.isoUtc);
  if (display === 'absolute') {
    const label = ABSOLUTE_DATE_FORMATTER.format(new Date(date.isoUtc));
    return `<time datetime="${datetime}" data-date-display="absolute">`
      + `${escapeHtml(label)}</time>`;
  }
  return `<time datetime="${datetime}" data-relative-time>${datetime}</time>`;
}

function teamMarkup(team, score, winner, showLogoState) {
  const winnerMarkup = winner ? '<small class="winner-label">Winner</small>' : '';
  const state = teamStateLabel(team, showLogoState);
  const stateMarkup = state
    ? `<small class="team-state">${escapeHtml(state)}</small>`
    : '';
  const idAttribute = team.teamId === null ? '' : ` data-team-id="${team.teamId}"`;
  return `<p class="${winner ? 'winner' : ''}"${idAttribute}`
    + `${team.teamId === null ? ' data-team-id-state="missing"' : ''}`
    + `${team.name.source === 'reference-tag' ? ' data-team-name-source="reference-tag"' : ''}`
    + `${showLogoState && team.logo.status === 'missing' ? ' data-logo-state="missing"' : ''}`
    + `${score === null ? ' data-score-state="missing"' : ''}`
    + ` data-team-display="${escapeHtml(team.name.display)}">`
    + `<span>${escapeHtml(team.name.display)}${winnerMarkup}${stateMarkup}</span>`
    + `<strong${score === null ? ' aria-label="Score unavailable"' : ''}>`
    + `${score ?? '&#8212;'}</strong></p>`;
}

export function renderMatchSummaryMarkup(summary, {
  dateDisplay = 'relative',
  headingId,
  headingLevel = 'h2',
  showLogoState = true,
  showPatch = false,
} = {}) {
  if (!summary || typeof summary !== 'object') {
    throw new TypeError('match summary markup requires a summary');
  }
  if (!/^h[1-6]$/.test(headingLevel)) {
    throw new TypeError('headingLevel must be h1 through h6');
  }
  if (!['absolute', 'relative'].includes(dateDisplay)) {
    throw new TypeError('dateDisplay must be absolute or relative');
  }

  const headingAttribute = headingId ? ` id="${escapeHtml(headingId)}"` : '';
  const result = resultLabel(summary.result);
  const resultState = summary.result.status;
  const patch = showPatch ? `<span>${escapeHtml(summary.patch.display)}</span>` : '';
  const date = dateMarkup(summary.date, dateDisplay);

  return `<header class="match-heading">`
    + `<${headingLevel}${headingAttribute}>${escapeHtml(summary.league.name.display)}</${headingLevel}>`
    + `<span>${escapeHtml(summary.league.tier.display)}</span></header>`
    + '<div class="teams">'
    + teamMarkup(
      summary.teams.radiant,
      summary.score.radiant,
      summary.result.winner === 'radiant',
      showLogoState,
    )
    + teamMarkup(
      summary.teams.dire,
      summary.score.dire,
      summary.result.winner === 'dire',
      showLogoState,
    )
    + '</div>'
    + '<footer class="match-meta">'
    + `<span data-score-state="${summary.score.status}">${escapeHtml(scoreLabel(summary.score))}</span>`
    + `<span data-result-state="${resultState}">${escapeHtml(result)}</span>`
    + `<span>${escapeHtml(durationLabel(summary.duration))}</span>${patch}${date}</footer>`;
}
