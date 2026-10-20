import { parseSearchTerms } from "./search.js?v=phrase-map-2";
import { escapeHtml, highlightMarkup, termStyle, termStroke } from "./search-matches.js?v=phrase-map-2";

import { initialPreviewPosition, rememberPreviewPosition } from "./preview-position.js?v=navigation-focus-1";

let layoutObserver;

export function matchingPages(documentItem) {
  const entries = documentItem.matchedPages || (documentItem.page ? [{ page: documentItem.page, excerpt: documentItem.excerpt }] : []);
  return [...new Map(entries.filter((entry) => Number.isSafeInteger(entry.page) && entry.page > 0)
    .map((entry) => [entry.page, entry])).values()].sort((a, b) => a.page - b.page);
}

export function adjacentMatchPages(matches, page) {
  return { previous: matches.filter((entry) => entry.page < page).at(-1)?.page,
    next: matches.find((entry) => entry.page > page)?.page };
}

export function clearPreviewNavigation() {
  layoutObserver?.disconnect();
  layoutObserver = undefined;
  const host = document.querySelector("#preview-controls");
  if (host) { host.hidden = true; host.replaceChildren(); }
  const map = document.querySelector("#preview-map");
  if (map) { map.hidden = true; map.replaceChildren(); }
}

export function matchingLocations(entries) {
  return entries.flatMap((entry) => (entry.ranges?.length ? entry.ranges : [{ matchIndex: 0, termIndex: 0 }])
    .map((range, index) => ({ ...range, page: entry.page, matchIndex: range.matchIndex ?? index })));
}

export function groupMapPages(entries, total, slots = 48) {
  const groups = new Map();
  for (const entry of entries) {
    const slot = Math.min(slots - 1, Math.floor((entry.page - 1) / total * slots));
    if (!groups.has(slot)) groups.set(slot, []);
    groups.get(slot).push(entry);
  }
  return [...groups.values()];
}

export function filterMatchLocations(locations, termIndex = -1) {
  return termIndex < 0 ? locations : locations.filter((entry) => (entry.termIndex ?? 0) === termIndex);
}

export function createPreviewNavigation(documentItem, query) {
  layoutObserver?.disconnect();
  const host = document.querySelector("#preview-controls");
  const map = document.querySelector("#preview-map");
  const matches = query.trim() ? matchingPages(documentItem).map((entry) => ({ ...entry })) : [];
  const initial = initialPreviewPosition(documentItem, query);
  if (!host || !matches.length) {
    clearPreviewNavigation();
    return { setPage() {}, setMatch() {}, setMatches() {}, bind() {}, note() {},
      ...(query.trim() ? { selection: () => ({ page: initial.page, matchIndex: initial.matchIndex, termIndex: initial.termIndex }) } : {}) };
  }
  const terms = parseSearchTerms(query);
  let locations = matchingLocations(matches);
  let termIndex = initial.termIndex >= 0 && initial.termIndex < terms.length ? initial.termIndex : -1;
  let matchPage = initial.page;
  let matchIndex = initial.matchIndex;
  let page = initial.anchor?.page || matchPage;
  let total = 0;
  let navigate;
  const notes = new Map();
  const arrow = (direction) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="${direction === "previous" ? 'M8 13V3M4 7l4-4 4 4' : 'M8 3v10m-4-4 4 4 4-4'}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  host.hidden = false;
  host.innerHTML = `<div class="preview-search-toolbar" role="group" aria-label="이 문서의 검색 위치 이동">
    <span class="preview-match-count" role="status"></span><span class="preview-current-page"></span>
    <div class="preview-match-buttons"><button type="button" data-match-direction="previous" disabled>${arrow("previous")}이전 검색 위치</button>
    <button type="button" data-match-direction="next" disabled>${arrow("next")}다음 검색 위치</button></div>
    <details class="preview-match-list"><summary>검색된 쪽 ${matches.length}</summary><div class="preview-match-options">
      ${matches.map((entry) => `<button type="button" data-match-page="${entry.page}"><strong>${entry.page}쪽</strong><span>${highlightMarkup(entry.excerpt || "", query)}</span></button>`).join("")}
    </div></details></div><div class="preview-term-legend" role="group" aria-label="이 문서에서 이동할 검색어">${terms.length > 1 ? '<span class="preview-filter-label">이동 대상</span><button type="button" data-match-term="-1">전체 검색어</button>' : ''}${terms.map((term, index) =>
      terms.length > 1 ? `<button type="button" data-match-term="${index}" style="${termStyle(index)}"><i>${index + 1}</i>${escapeHtml(term)}</button>` : `<span style="${termStyle(index)}"><i>${index + 1}</i>${escapeHtml(term)}</span>`).join("")}<span class="preview-keyboard-help">↑↓ 검색 위치 · ← 문서 목록</span></div><p class="preview-match-note" hidden></p>`;
  const current = host.querySelector(".preview-current-page");
  const counter = host.querySelector(".preview-match-count");
  const list = host.querySelector("details");
  const previous = host.querySelector('[data-match-direction="previous"]');
  const next = host.querySelector('[data-match-direction="next"]');
  let lastUpdate = "";
  const filtered = () => filterMatchLocations(locations, termIndex);
  const position = () => filtered().findIndex((entry) => entry.page === matchPage && entry.matchIndex === matchIndex);
  const selection = () => ({ page: matchPage, matchIndex, termIndex });
  function showNote() {
    const note = host.querySelector(".preview-match-note");
    const match = matches.find((entry) => entry.page === page);
    const message = notes.get(page);
    note.hidden = !message || !match;
    note.innerHTML = message && match ? `${escapeHtml(message)} ${highlightMarkup(match.excerpt || "", query)}` : "";
  }
  function update() {
    const choices = filtered();
    const key = `${page}:${matchPage}:${matchIndex}:${termIndex}:${total}:${choices.length}:${Boolean(navigate)}:${notes.get(page) || ""}`;
    if (key === lastUpdate) return;
    lastUpdate = key;
    const index = position();
    current.textContent = `현재 ${page}쪽 / 전체 ${total || "–"}쪽`;
    counter.textContent = `이 문서의 검색 위치 ${index < 0 ? "–" : index + 1} / ${choices.length}곳`;
    previous.disabled = !navigate || index <= 0;
    next.disabled = !navigate || index < 0 || index === choices.length - 1;
    host.querySelectorAll("[data-match-page]").forEach((button) => button.setAttribute("aria-current", Number(button.dataset.matchPage) === matchPage ? "page" : "false"));
    host.querySelectorAll("[data-match-term]").forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.matchTerm) === termIndex)));
    const thumb = map?.querySelector(".preview-map-current");
    if (thumb && total) { thumb.style.top = `${(page - 1) / total * 100}%`; thumb.style.height = `${Math.max(1.5, 100 / total)}%`; }
    showNote();
  }
  function drawMap() {
    if (!map || !total) return;
    map.hidden = false;
    lastUpdate = "";
    map.style.top = `${host.offsetTop + host.offsetHeight + 4}px`;
    const groups = groupMapPages(matches, total, Math.max(2, Math.min(48, Math.floor((map.clientHeight || 500) / 14))));
    map.innerHTML = `<span class="preview-map-label">1</span><div class="preview-map-track" style="--page-count:${total}">
      <span class="preview-map-current" aria-hidden="true"></span>${groups.map((group, index) => {
        const indices = [...new Set(group.flatMap((entry) => entry.termIndices || entry.ranges?.map((range) => range.termIndex ?? 0) || [0]))];
        const count = group.reduce((sum, entry) => sum + (entry.ranges?.length || 1), 0);
        const label = `${group.map((entry) => entry.page).join(", ")}쪽 · ${count}곳 · ${indices.map((i) => terms[i]).join(", ")}`;
        return `<button type="button" data-map-group="${index}" style="top:${(group[0].page - .5) / total * 100}%" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${indices.map((i) => `<i style="${termStyle(i)}"></i>`).join("")}</button>`;
      }).join("")}</div><span class="preview-map-label">${total}</span>`;
    map.onclick = (event) => {
      const index = event.target.closest("[data-map-group]")?.dataset.mapGroup;
      if (index === undefined || !navigate) return;
      const group = groups[Number(index)];
      if (group.length === 1) goToListedPage(group[0].page);
      else {
        const pages = new Set(group.map((entry) => entry.page));
        host.querySelectorAll("[data-match-page]").forEach((button) => { button.hidden = !pages.has(Number(button.dataset.matchPage)); });
        list.open = true;
        host.querySelector('[data-match-page]:not([hidden])')?.focus();
      }
    };
  }
  function go(destination) {
    if (!destination || !navigate) return;
    list.open = false;
    matchPage = destination.page;
    matchIndex = destination.matchIndex;
    page = matchPage;
    rememberPreviewPosition(documentItem, query, { ...selection(), anchor: null });
    navigate(matchPage, matchIndex);
    update();
  }
  function goToListedPage(destination) {
    let match = filtered().find((entry) => entry.page === destination);
    if (!match) { termIndex = -1; match = locations.find((entry) => entry.page === destination); }
    go(match);
  }
  function setPage(value, pageCount) {
    const changedTotal = pageCount && pageCount !== total;
    page = value;
    total = pageCount || total;
    if (changedTotal) drawMap();
    update();
  }
  list.ontoggle = () => { if (!list.open) host.querySelectorAll("[data-match-page]").forEach((button) => { button.hidden = false; }); };
  host.onclick = (event) => {
    if (!navigate) return;
    const term = event.target.closest("[data-match-term]")?.dataset.matchTerm;
    if (term !== undefined) {
      termIndex = Number(term);
      const choices = filtered();
      go(choices.find((entry) => entry.page === matchPage && entry.matchIndex === matchIndex) || choices.find((entry) => entry.page >= page) || choices[0]);
      update();
      return;
    }
    const target = event.target.closest("[data-match-page]")?.dataset.matchPage;
    if (target) return goToListedPage(Number(target));
    const direction = event.target.closest("[data-match-direction]")?.dataset.matchDirection;
    if (direction) go(filtered()[position() + (direction === "previous" ? -1 : 1)]);
  };
  host.onkeydown = (event) => {
    if (event.key === "Escape" && list.open) { list.open = false; list.querySelector("summary").focus(); event.stopPropagation(); }
  };
  update();
  if (map && typeof ResizeObserver === "function") {
    layoutObserver = new ResizeObserver(() => { drawMap(); update(); });
    layoutObserver.observe(host);
    layoutObserver.observe(map);
  }
  return {
    setPage, selection,
    setMatch(value, index) { matchPage = value; matchIndex = index; rememberPreviewPosition(documentItem, query, selection()); update(); },
    setMatches(value, ranges) {
      const entry = matches.find((entry) => entry.page === value);
      if (!entry) return;
      entry.ranges = ranges;
      entry.termIndices = [...new Set(ranges.map((range) => range.termIndex))];
      locations = matchingLocations(matches);
      drawMap(); update();
    },
    bind(callback) { navigate = callback; update(); },
    note(value, message) { notes.set(value, message); showNote(); }
  };
}

export function focusPageMatch(scrollRoot, pageNode, matchIndex = 0) {
  const marks = [...pageNode.querySelectorAll(".source-highlight")];
  const ids = (node) => (node.dataset.matchIndices || node.dataset.matchIndex || "0").split(" ").map(Number);
  const group = marks.filter((node) => ids(node).includes(matchIndex));
  const match = group[0];
  if (!match) return false;
  scrollRoot.querySelectorAll(".is-current-match").forEach((node) => node.classList.remove("is-current-match"));
  group.forEach((node) => {
    node.classList.add("is-current-match");
    const terms = (node.dataset.termIndices || node.dataset.termIndex || "0").split(" ").map(Number);
    node.style.setProperty("--match-stroke", termStroke(terms[ids(node).indexOf(matchIndex)]));
  });
  const top = scrollRoot.scrollTop + match.getBoundingClientRect().top - scrollRoot.getBoundingClientRect().top;
  scrollRoot.scrollTo({ top: Math.max(0, top - scrollRoot.clientHeight * .3), behavior: "instant" });
  return true;
}
