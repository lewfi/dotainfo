const INDEX_PATH = '/data/search-index.json';
const RESULT_LIMIT = 20;

let indexPromise;
let searchablePromise;

function loadIndex() {
  indexPromise ??= fetch(INDEX_PATH).then((response) => {
    if (!response.ok) throw new Error(`Search index request failed: ${response.status}`);
    return response.json();
  });
  return indexPromise;
}

function rows(type, columns, href, typeLabel) {
  const discriminators = new Map(columns.c?.i.map((rowIndex, index) => [
    rowIndex,
    `(${columns.c.y[index] || columns.i[rowIndex]})`,
  ]) ?? []);
  return columns.i.map((id, index) => Object.freeze({
    id,
    type,
    typeLabel,
    name: columns.n[index],
    tag: columns.g?.[index] ?? '',
    discriminator: type === 'hero' ? 'hero' : (discriminators.get(index) ?? ''),
    weight: columns.w?.[index] ?? 0,
    href: href(id),
  }));
}

function searchableIndex() {
  searchablePromise ??= loadIndex().then((index) => {
    const entries = [
      ...rows('team', index.t, (id) => `/teams/${id}/`, 'Team'),
      ...rows('tournament', index.l, (id) => `/tournaments/${id}/`, 'Tournament'),
      ...rows('hero', index.h, (id) => `/heroes/${id}/`, 'Hero'),
    ];
    const nameCounts = new Map();
    for (const entry of entries) {
      const key = entry.name.toLocaleLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    return entries.map((entry) => Object.freeze({
      ...entry,
      normalizedName: entry.name.toLocaleLowerCase(),
      normalizedTag: entry.tag.toLocaleLowerCase(),
      sharedName: nameCounts.get(entry.name.toLocaleLowerCase()) > 1,
    }));
  });
  return searchablePromise;
}

function matches(query, entries) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];
  return entries.filter((entry) => entry.normalizedName.includes(normalized)
    || entry.normalizedTag.includes(normalized))
    .sort((left, right) => {
      const leftExact = left.normalizedName === normalized || left.normalizedTag === normalized;
      const rightExact = right.normalizedName === normalized || right.normalizedTag === normalized;
      if (leftExact !== rightExact) return rightExact - leftExact;
      const leftPrefix = left.normalizedName.startsWith(normalized) || left.normalizedTag.startsWith(normalized);
      const rightPrefix = right.normalizedName.startsWith(normalized) || right.normalizedTag.startsWith(normalized);
      return rightPrefix - leftPrefix || right.weight - left.weight
        || left.name.localeCompare(right.name) || left.id - right.id;
    }).slice(0, RESULT_LIMIT);
}

function appendResult(list, entry, index) {
  const item = document.createElement('li');
  item.setAttribute('role', 'presentation');
  const link = document.createElement('a');
  link.id = `${list.id}-option-${index}`;
  link.href = entry.href;
  link.setAttribute('role', 'option');
  link.dataset.searchResultId = String(entry.id);
  link.dataset.searchResultType = entry.type;
  link.dataset.searchDiscriminator = entry.sharedName ? entry.discriminator : '';
  const name = document.createElement('strong');
  name.textContent = entry.name;
  const detail = document.createElement('span');
  detail.className = 'search-result-detail';
  const parts = [entry.typeLabel];
  if (entry.sharedName && entry.discriminator) parts.push(entry.discriminator);
  if (entry.tag) parts.push(entry.tag);
  detail.textContent = parts.join(' · ');
  link.append(name, detail);
  item.append(link);
  list.append(item);
  return link;
}

function enhance(root) {
  if (root.dataset.searchReady === 'true') return;
  root.dataset.searchReady = 'true';
  const input = root.querySelector('input[type="search"]');
  const panel = root.querySelector('[data-search-results]');
  const status = root.querySelector('[data-search-status]');
  const list = root.querySelector('[data-search-list]');
  let options = [];
  let active = -1;

  function select(index) {
    active = options.length === 0 ? -1 : (index + options.length) % options.length;
    options.forEach((option, optionIndex) => option.setAttribute('aria-selected', String(optionIndex === active)));
    if (active < 0) input.removeAttribute('aria-activedescendant');
    else {
      input.setAttribute('aria-activedescendant', options[active].id);
      options[active].scrollIntoView({ block: 'nearest' });
    }
  }

  async function update() {
    panel.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    status.textContent = 'Loading search index…';
    try {
      const found = matches(input.value, await searchableIndex());
      list.replaceChildren();
      options = found.map((entry, index) => appendResult(list, entry, index));
      select(-1);
      status.textContent = input.value.trim()
        ? `${found.length} ${found.length === 1 ? 'result' : 'results'} shown.`
        : 'Enter a name or team tag.';
    } catch {
      list.replaceChildren();
      options = [];
      status.textContent = 'Search is unavailable. Use the browse links on the search page.';
    }
  }

  input.addEventListener('focus', () => { void loadIndex().catch(() => {}); });
  input.addEventListener('input', () => { void update(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); select(active + 1); }
    if (event.key === 'ArrowUp') { event.preventDefault(); select(active - 1); }
    if (event.key === 'Escape') {
      panel.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      select(-1);
    }
    if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      options[active].click();
    }
  });
  root.addEventListener('submit', (event) => {
    event.preventDefault();
    void update();
  });
}

export function enhanceSearchControls() {
  for (const root of document.querySelectorAll('[data-search-root]')) enhance(root);
}
