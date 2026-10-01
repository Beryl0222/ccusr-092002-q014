import { cellKey, isSourceStale, normalizeUnit, yearsOf } from "./baseline.js";
import { newId, recordEvent } from "./store.js";

export const ORG_TYPES = new Set(["hospital", "primary_care", "education", "finance"]);

/**
 * 提交来源登记。来源可被后续版本标记 superseded_by，引用过期来源的假设不能直接汇总。
 */
export function registerSource(store, input) {
  const required = ["title", "publisher", "published_on"];
  for (const key of required) {
    if (!input[key]) throw new Error(`来源缺少字段：${key}`);
  }
  const source = {
    id: input.id ?? newId(store, "SRC"),
    title: input.title,
    publisher: input.publisher,
    published_on: input.published_on,
    url: input.url ?? null,
    superseded_by: null
  };
  store.sources.set(source.id, source);
  recordEvent(store, "source_registered", { source_id: source.id });
  return source;
}

export function supersedeSource(store, sourceId, replacementId) {
  const source = store.sources.get(sourceId);
  if (!source) throw new Error("来源不存在");
  source.superseded_by = replacementId;
  recordEvent(store, "source_superseded", { source_id: sourceId, replacement_id: replacementId });
  return source;
}

function validateAssumption(input, baseline, source, now) {
  const issues = [];
  const fields = baseline.fields;
  const field = fields[input.field];
  if (!field) {
    issues.push({ code: "UNKNOWN_FIELD", message: `未登记字段：${input.field}` });
    return { issues, field: null };
  }
  if (!field.allowed_professions.includes(input.profession)) {
    issues.push({ code: "UNKNOWN_PROFESSION", message: `字段 ${input.field} 不适用职业 ${input.profession}` });
  }
  const regionCodes = new Set(baseline.regions.map((r) => r.code));
  if (!regionCodes.has(input.region)) {
    issues.push({ code: "UNKNOWN_REGION", message: `未登记地区：${input.region}` });
  }
  const range = input.year_range ?? [baseline.first_projection_year, baseline.target_year];
  if (range[0] < baseline.first_projection_year || range[1] > baseline.target_year) {
    issues.push({
      code: "RANGE_OUT_OF_WINDOW",
      message: `时间范围 ${range[0]}-${range[1]} 超出规划窗口 ${baseline.first_projection_year}-${baseline.target_year}`
    });
  }

  // 单位：只有登记过的同源单位（percent↔fraction）可自动换算，其余即单位冲突。
  let normalized = { value: Number(input.value), unit: input.unit, incompatible: true };
  if (input.unit) {
    normalized = normalizeUnit(Number(input.value), input.unit, field.unit);
    if (normalized.incompatible) {
      issues.push({
        code: "UNIT_CONFLICT",
        message: `提交单位「${input.unit}」与登记单位「${field.unit}」不可换算，不能直接求和`
      });
    }
  } else {
    issues.push({ code: "MISSING_UNIT", message: "必须声明单位" });
  }

  // 边界与置信区间均按归一化后的登记单位校验（92% → 0.92）。
  const checkValue = normalized.incompatible === false ? normalized.value : Number(input.value);
  if (!Number.isFinite(checkValue)) {
    issues.push({ code: "BAD_VALUE", message: "数值不是有限数" });
  } else {
    const [lo0, hi0] = field.bounds;
    if (checkValue < lo0 || checkValue > hi0) {
      issues.push({ code: "OUT_OF_BOUNDS", message: `数值 ${checkValue} 超出 ${field.label} 允许区间 [${lo0}, ${hi0}]` });
    }
  }
  if (!input.ci || !Number.isFinite(input.ci?.lo) || !Number.isFinite(input.ci?.hi)) {
    issues.push({ code: "MISSING_CI", message: "必须提交置信区间 ci.lo / ci.hi" });
  } else {
    const ciLo = input.unit === "percent" && field.unit === "fraction" ? input.ci.lo / 100 : input.ci.lo;
    const ciHi = input.unit === "percent" && field.unit === "fraction" ? input.ci.hi / 100 : input.ci.hi;
    if (ciLo > ciHi || checkValue < ciLo || checkValue > ciHi) {
      issues.push({ code: "BAD_CI", message: "置信区间需满足 lo ≤ value ≤ hi" });
    }
  }

  // 统计口径：非 standard 口径（如含执业助理医师、按毕业院校地统计）即定义不一致。
  if (input.population_scope && input.population_scope !== "standard") {
    issues.push({
      code: "DEFINITION_MISMATCH",
      message: `口径「${input.population_scope}」与基线定义不一致（医师不含执业助理医师、护士按执业地注册口径）`
    });
  }

  if (source) {
    const stale = isSourceStale(source, input.field, baseline, now);
    if (stale.stale) {
      issues.push({ code: "SOURCE_STALE", message: `来源 ${source.id} 不可用：${stale.reason}` });
    }
  } else {
    issues.push({ code: "SOURCE_MISSING", message: "必须登记带来源的假设" });
  }

  if (!input.submitted_by || !ORG_TYPES.has(input.submitted_by.org_type)) {
    issues.push({
      code: "BAD_SUBMITTER",
      message: `submitted_by.org_type 必须是 ${[...ORG_TYPES].join("/")} 之一`
    });
  }

  return { issues, field, normalized, range };
}

/**
 * 提交假设。任何阻断性问题（单位冲突、口径不一致、来源过期等）都令假设进入澄清，
 * 状态为 clarification，不参与任何求和与情景组合。
 */
export function submitAssumption(store, baseline, input, now = new Date()) {
  if (!input.field) throw new Error("缺少 field");
  const source = input.source_id ? store.sources.get(input.source_id) : null;
  const { issues, field, normalized, range } = validateAssumption(input, baseline, source, now);

  const convertCi = (v) => (input.unit === "percent" && field?.unit === "fraction" ? v / 100 : v);
  const assumption = {
    id: input.id ?? newId(store, "ASM"),
    field: input.field,
    profession: input.profession,
    region: input.region,
    year_range: range,
    value_raw: Number(input.value),
    unit_raw: input.unit ?? null,
    value: normalized?.incompatible === false ? normalized.value : Number(input.value),
    unit: normalized?.incompatible === false ? normalized.unit : input.unit ?? null,
    unit_converted: Boolean(normalized?.converted),
    ci: input.ci
      ? { lo: convertCi(Number(input.ci.lo)), hi: convertCi(Number(input.ci.hi)), level: input.ci.level ?? 0.95 }
      : null,
    source_id: input.source_id ?? null,
    submitted_by: input.submitted_by ?? null,
    basis: input.basis ?? "",
    population_scope: input.population_scope ?? "standard",
    submitted_at: new Date(now).toISOString(),
    status: issues.length > 0 ? "clarification" : "accepted",
    supersedes: input.supersedes ?? null,
    resolution: null
  };
  store.assumptions.set(assumption.id, assumption);

  if (issues.length > 0) {
    const ticket = {
      id: newId(store, "CLR"),
      assumption_id: assumption.id,
      opened_at: new Date(now).toISOString(),
      status: "open",
      issues,
      threads: []
    };
    store.clarifications.push(ticket);
    recordEvent(store, "assumption_blocked", { assumption_id: assumption.id, clarification_id: ticket.id, codes: issues.map((i) => i.code) });
    return { assumption, clarification: ticket };
  }
  recordEvent(store, "assumption_accepted", { assumption_id: assumption.id });
  return { assumption, clarification: null };
}

/**
 * 解决澄清：reconcile=按更正内容重新提交（生成新假设，原票关闭）；withdraw=撤回。
 * 任何路径都不允许带未决问题的假设进入求和。
 */
export function resolveClarification(store, baseline, clarificationId, action, payload = {}, now = new Date()) {
  const ticket = store.clarifications.find((c) => c.id === clarificationId);
  if (!ticket) throw new Error("澄清单不存在");
  if (ticket.status !== "open") throw new Error("澄清单已关闭");
  const original = store.assumptions.get(ticket.assumption_id);

  if (action === "withdraw") {
    ticket.status = "closed";
    ticket.closed_at = new Date(now).toISOString();
    ticket.resolution = { action: "withdraw", note: payload.note ?? "" };
    original.status = "withdrawn";
    original.resolution = ticket.resolution;
    recordEvent(store, "clarification_closed", { clarification_id: ticket.id, action });
    return { ticket, new_assumption: null };
  }
  if (action === "reconcile") {
    const corrected = { ...payload, supersedes: original.id };
    const result = submitAssumption(store, baseline, corrected, now);
    ticket.status = "closed";
    ticket.closed_at = new Date(now).toISOString();
    ticket.resolution = { action: "reconcile", note: payload.note ?? "", new_assumption_id: result.assumption.id };
    original.status = "superseded";
    original.resolution = ticket.resolution;
    recordEvent(store, "clarification_closed", { clarification_id: ticket.id, action, new_assumption_id: result.assumption.id });
    return { ticket, new_assumption: result.assumption, clarification: result.clarification };
  }
  throw new Error("action 必须是 reconcile 或 withdraw");
}

export function addClarificationThread(store, clarificationId, orgType, message) {
  const ticket = store.clarifications.find((c) => c.id === clarificationId);
  if (!ticket || ticket.status !== "open") throw new Error("澄清单不存在或已关闭");
  ticket.threads.push({ at: new Date().toISOString(), org_type: orgType, message });
  return ticket;
}

/** 已接受假设按投影单元归集；同一单元出现多个口径不同的提交即存在分歧。 */
export function cellMap(assumptions) {
  const cells = new Map();
  for (const a of assumptions) {
    for (const year of yearsOf(a.year_range)) {
      const key = cellKey(a.field, a.profession, a.region, year);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(a);
    }
  }
  return cells
}

export function listDisagreements(assumptions) {
  const cells = cellMap(assumptions.filter((a) => a.status === "accepted"));
  const out = [];
  for (const [key, alts] of cells) {
    const distinct = new Map();
    for (const a of alts) {
      const sig = `${a.value}|${a.unit}|${a.population_scope}`;
      if (!distinct.has(sig)) distinct.set(sig, a);
    }
    if (distinct.size > 1) {
      out.push({ cell: key, alternatives: alts.map((a) => ({ id: a.id, value: a.value, unit: a.unit, org_type: a.submitted_by?.org_type, ci: a.ci })) });
    }
  }
  return out;
}

const REQUIRED_SCENARIO_FIELDS = ["retirement_rate", "training_completion", "training_intake", "migration_rate", "productivity"];

/**
 * 兼容性组合检查：通过才允许构成候选情景。
 * - 任何假设带未决澄清 → blocked
 * - 同一投影单元选中多个假设 → DUPLICATE_CELL
 * - 必要字段在区域×职业×年份上缺口 → COVERAGE_GAP（允许使用基线默认值的字段除外）
 * - 各区域净流入在全国层面不平衡（不可能各省都净流入）→ FLOW_IMBALANCE
 */
export function checkCompatibility(store, baseline, assumptionIds, options = {}) {
  const issues = [];
  const selected = [];
  for (const id of assumptionIds) {
    const a = store.assumptions.get(id);
    if (!a) {
      issues.push({ code: "UNKNOWN_ASSUMPTION", message: `假设不存在：${id}` });
      continue;
    }
    if (a.status !== "accepted") {
      issues.push({ code: "BLOCKED_BY_CLARIFICATION", message: `假设 ${id} 状态为 ${a.status}，未决澄清未关闭` });
    }
    selected.push(a);
  }

  // 口径一致性
  const scopes = new Set(selected.map((a) => a.population_scope));
  if (scopes.size > 1) {
    issues.push({ code: "DEFINITION_MISMATCH", message: `混合了不同统计口径：${[...scopes].join("、")}` });
  }

  const cells = cellMap(selected);
  for (const [key, alts] of cells) {
    if (alts.length > 1) {
      issues.push({ code: "DUPLICATE_CELL", message: `投影单元 ${key} 存在多个互斥假设，必须择一：${alts.map((a) => a.id).join(", ")}` });
    }
  }

  // 覆盖缺口（在要求推演的地区与职业上）
  const professions = options.professions ?? ["physician", "nurse"];
  const regions = options.regions ?? ["NATIONAL"];
  const years = yearsOf([baseline.first_projection_year, baseline.target_year]);
  for (const fieldName of REQUIRED_SCENARIO_FIELDS) {
    const field = baseline.fields[fieldName];
    for (const profession of professions) {
      for (const region of regions) {
        for (const year of years) {
          const hit = cells.get(cellKey(fieldName, profession, region, year));
          const hasDefault = field.default_value !== null && field.default_value !== undefined;
          if (!hit && !hasDefault) {
            issues.push({ code: "COVERAGE_GAP", message: `缺少假设：${fieldName}/${profession}/${region}/${year}（无基线默认值）` });
          }
        }
      }
    }
  }

  // 流量平衡：同一年所有子地区净流动按基准存量加权后全国合计应约等于 0。
  const leafRegions = baseline.regions.filter((r) => r.type === "province").map((r) => r.code);
  for (const profession of professions) {
    for (const year of years) {
      let weighted = 0;
      let known = 0;
      for (const region of leafRegions) {
        const rateCell = cells.get(cellKey("migration_rate", profession, region, year));
        const stock = resolveCell(cells, baseline, "base_stock", profession, region, year - 1)
          ?? professionStock(baseline, profession);
        if (rateCell) {
          weighted += rateCell[0].value * stock;
          known += 1;
        }
      }
      if (known >= 2) {
        const totalStock = professionStock(baseline, profession);
        if (Math.abs(weighted) > 0.02 * totalStock) {
          issues.push({
            code: "FLOW_IMBALANCE",
            message: `${profession} ${year} 年省级净流动加权合计 ${Math.round(weighted).toLocaleString()} 人，超出全国 ±2% 平衡带，不可能所有地区同时净流入`
          });
        }
      }
    }
  }

  return { compatible: issues.length === 0, issues, cells };
}

function professionStock(baseline, profession) {
  return baseline.stocks_2025?.[profession]?.value ?? 0;
}

export function resolveCell(cells, baseline, fieldName, profession, region, year) {
  const hit = cells.get(cellKey(fieldName, profession, region, year));
  if (hit) return hit[0].value;
  const field = baseline.fields[fieldName];
  return field?.default_value ?? null;
}
