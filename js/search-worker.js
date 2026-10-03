import { createPageSearchIndex, searchPageIndex } from "./local-index.js?v=phrase-map-2";

let index;
self.onmessage = ({ data }) => {
  try {
    if (data.type === "prepare") {
      index = createPageSearchIndex(data.entries);
      self.postMessage({ id: data.id, result: true });
    } else if (data.type === "search") {
      if (!index) throw new Error("검색 색인이 준비되지 않았습니다.");
      self.postMessage({ id: data.id, result: searchPageIndex(data.documents, index, data.query) });
    }
  } catch (error) { self.postMessage({ id: data.id, error: error.message }); }
};
