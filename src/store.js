import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 内存版本库：仅保存机构级汇总假设与治理记录，不接收任何个人医护档案。
 * 设 DATA_FILE 时落盘为 JSON；测试用 freshStore() 不落盘。
 */
export function freshStore() {
  return {
    seq: 0,
    sources: new Map(),
    assumptions: new Map(),
    clarifications: [],
    scenarios: new Map(),
    runs: new Map(),
    reviewers: new Map(),
    disclosures: new Map(),
    release_proposals: new Map(),
    votes: new Map(),
    releases: new Map(),
    revisions: new Map(),
    events: []
  };
}

export function newId(store, prefix) {
  store.seq += 1;
  return `${prefix}-${String(store.seq).padStart(4, "0")}`;
}

export function recordEvent(store, type, detail = {}) {
  store.events.push({ at: new Date().toISOString(), type, detail });
}

const MAP_KEYS = ["sources", "assumptions", "scenarios", "runs", "reviewers", "disclosures", "release_proposals", "votes", "releases", "revisions"];

export function saveStore(store, file) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const payload = { seq: store.seq, events: store.events, clarifications: store.clarifications };
  for (const key of MAP_KEYS) payload[key] = [...store[key].entries()];
  writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
}

export function loadStore(file) {
  const store = freshStore();
  if (!file || !existsSync(file)) return null;
  const payload = JSON.parse(readFileSync(file, "utf8"));
  store.seq = payload.seq ?? 0;
  store.events = payload.events ?? [];
  store.clarifications = payload.clarifications ?? [];
  for (const key of MAP_KEYS) {
    for (const [id, value] of payload[key] ?? []) store[key].set(id, value);
  }
  return store;
}
