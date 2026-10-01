import crypto from "node:crypto";

/**
 * 稳定规范化 JSON：对象键按字典序排序，用于指纹与快照复现。
 */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}

export function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function fingerprint(value) {
  return sha256(canonical(value));
}

export function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString("hex")}`;
}

export function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
