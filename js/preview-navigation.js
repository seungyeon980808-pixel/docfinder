import { parseSearchTerms } from "./search.js?v=phrase-map-2";
import { escapeHtml, highlightMarkup, termStyle, termStroke } from "./search-matches.js?v=phrase-map-2";

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

export function createPreviewNavigation(documentItem, query) {
  layoutObserver?.disconnect();
  const host = document.querySelector("#preview-controls");
  const map = document.querySelector("#preview-map");
  const matches = query.trim() ? matchingPages(documentItem).map((entry) => ({ ...entry })) : [];
  if (!host || !matches.length) { clearPreviewNavigation(); return { setPage() {}, setMatch() {}, setMatches() {}, bind() {}, note() {} }; }
  const terms = parseSearchTerms(query);
  let locations = matchingLocations(matches);
  host.hidden = false;
  host.innerHTML = `<div class="preview-search-toolbar" role="group" aria-label="검색 일치 위치 이동">
    <span class="preview-match-count" role="status"></span><span class="preview-current-page"></span>
    <button type="button" data-match-direction="previous" aria-label="이전 일치 위치" disabled>← 이전</button>
    <button type="button" data-match-direction="next" aria-label="다음 일치 위치" disabled>다음 →</button>
    <details class="preview-match-list"><summary>쪽 목록 ${matches.length}</summary><div class="preview-match-options">
      ${matches.map((entry) => `<button type="button" data-match-page="${entry.page}"><strong>${entry.page}쪽</strong><span>${highlightMarkup(entry.excerpt || "", query)}</span></button>`).join("")}
    </div></details></div><div class="preview-term-legend" aria-label="검색어별 색상">${terms.map((term, index) =>
      `<span style="${termStyle(index)}"><i>${index + 1}</i>${escapeHtml(term)}</span>`).join("")}</div><p class="preview-match-note" hidden></p>`;
  const current = host.querySelector(".preview-current-page");
  const counter = host.querySelector(".preview-match-count");
  const list = host.querySelector("details");
  const previous = host.querySelector('[data-match-direction="previous"]');
  const next = host.querySelector('[data-match-direction="next"]');
  let page = documentItem.page || matches[0].page;
  let matchIndex = 0;
  let total = 0;
  let navigate;
  const notes = new Map();
  let lastUpdate = "";
  function position() { return locations.findIndex((entry) => entry.page === page && entry.matchIndex === matchIndex); }
  function showNote() {
    const note = host.querySelector(".preview-match-note");
    const match = matches.find((entry) => entry.page === page);
    const message = notes.get(page);
    note.hidden = !message || !match;
    note.innerHTML = message && match ? `${escapeHtml(message)} ${highlightMarkup(match.excerpt || "", query)}` : "";
  }
  function update() {
    const key = `${page}:${matchIndex}:${total}:${locations.length}:${Boolean(navigate)}:${notes.get(page) || ""}`;
    if (key === lastUpdate) return;
    lastUpdate = key;
    const index = position();
    current.textContent = `${page} / ${total || "–"}쪽`;
    counter.textContent = `일치 위치 ${index < 0 ? "–" : index + 1} / ${locations.length}`;
    previous.disabled = !navigate || (index >= 0 ? index === 0 : !locations.some((entry) => entry.page < page));
    next.disabled = !navigate || (index >= 0 ? index === locations.length - 1 : !locations.some((entry) => entry.page >= page));
    host.querySelectorAll("[data-match-page]").forEach((button) => button.setAttribute("aria-current", Number(button.dataset.matchPage) === page ? "page" : "false"));
    const thumb = map?.querySelector(".preview-map-current");
    if (thumb) { thumb.style.top = `${(page - 1) / total * 100}%`; thumb.style.height = `${Math.max(1.5, 100 / total)}%`; }
    showNote();
  }
  function drawMap() {
    if (!map || !total) return;
    map.hidden = false;
    lastUpdate = "";
    map.style.top = `${host.offsetHeight + (document.querySelector(".mobile-back")?.offsetHeight || 0) + 4}px`;
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
      if (group.length === 1) go(group[0].page, 0);
      else {
        const pages = new Set(group.map((entry) => entry.page));
        host.querySelectorAll("[data-match-page]").forEach((button) => { button.hidden = !pages.has(Number(button.dataset.matchPage)); });
        list.open = true;
        host.querySelector('[data-match-page]:not([hidden])')?.focus();
      }
    };
  }
  function go(destination, index) {
    list.open = false;
    page = destination;
    matchIndex = index;
    navigate(destination, index);
    update();
  }
  function setPage(value, pageCount) {
    const changedTotal = pageCount && pageCount !== total;
    if (page !== value) { page = value; matchIndex = 0; }
    total = pageCount || total;
    if (changedTotal) drawMap();
    update();
  }
  list.ontoggle = () => { if (!list.open) host.querySelectorAll("[data-match-page]").forEach((button) => { button.hidden = false; }); };
  host.onclick = (event) => {
    const direction = event.target.closest("[data-match-direction]")?.dataset.matchDirection;
    const target = event.target.closest("[data-match-page]")?.dataset.matchPage;
    if (!navigate) return;
    if (target) return go(Number(target), 0);
    if (!direction) return;
    const index = position();
    const destination = index >= 0 ? locations[index + (direction === "previous" ? -1 : 1)]
      : direction === "previous" ? locations.filter((entry) => entry.page < page).at(-1) : locations.find((entry) => entry.page >= page);
    if (destination) go(destination.page, destination.matchIndex);
  };
  host.onkeydown = (event) => {
    if (event.key === "Escape" && list.open) { list.open = false; list.querySelector("summary").focus(); event.stopPropagation(); }
  };
  setPage(page);
  if (map && typeof ResizeObserver === "function") {
    layoutObserver = new ResizeObserver(() => { drawMap(); update(); });
    layoutObserver.observe(host);
    layoutObserver.observe(map);
  }
  return {
    setPage,
    setMatch(value, index) { page = value; matchIndex = index; update(); },
    setMatches(value, ranges) {
      const entry = matches.find((entry) => entry.page === value);
      if (!entry) return;
      entry.ranges = ranges;
      entry.termIndices = [...new Set(ranges.map((range) => range.termIndex))];
      locations = matchingLocations(matches);
      drawMap();
      update();
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
