import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CONTRACT_PATH = fileURLToPath(new URL("../contracts/workforce_scenario.json", import.meta.url));

let cached = null;

export async function loadBaseline() {
  if (!cached) {
    cached = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
  }
  return cached.baseline;
}

export function buildRegionIndex(baseline) {
  const index = new Map();
  for (const region of baseline.regions) index.set(region.code, region);
  return index;
}

/**
 * 单位归一化：percent 与 fraction 同源可换算；其余单位必须与字段登记一致，
 * 不可换算即视为单位冲突，不能直接求和。
 */
export function normalizeUnit(value, unit, registeredUnit) {
  if (unit === registeredUnit) return { value, unit: registeredUnit, converted: false, incompatible: false };
  if (registeredUnit === "fraction" && unit === "percent") {
    return { value: value / 100, unit: "fraction", converted: true, incompatible: false };
  }
  return { value, unit, converted: false, incompatible: true };
}

export function fieldRegistry(baseline) {
  return baseline.fields;
}

/** 来源是否过期：按字段允许的最大时效判断，无字段例外时取全局阈值。 */
export function isSourceStale(source, fieldName, baseline, asOf = new Date()) {
  if (!source || !source.published_on) return { stale: true, reason: "缺少发布日期" };
  if (source.superseded_by) return { stale: true, reason: `已被 ${source.superseded_by} 替代` };
  const maxDays = baseline.stale_exceptions?.[fieldName] ?? baseline.source_max_age_days;
  const ageDays = (new Date(asOf) - new Date(source.published_on)) / 86_400_000;
  if (ageDays > maxDays) return { stale: true, reason: `来源已发布 ${Math.floor(ageDays)} 天，超过 ${maxDays} 天上限` };
  return { stale: false, ageDays: Math.floor(ageDays) };
}

/** 投影单元键：字段×职业×地区×年份，任何汇总都以可比单元为前提。 */
export function cellKey(field, profession, region, year) {
  return `${field}|${profession}|${region}|${year}`;
}

export function parseCellKey(key) {
  const [field, profession, region, year] = key.split("|");
  return { field, profession, region, year: Number(year) };
}

export function yearsOf(range) {
  const years = [];
  for (let y = range[0]; y <= range[1]; y += 1) years.push(y);
  return years;
}
