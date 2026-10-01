import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { cellKey, yearsOf } from "./baseline.js";
import { checkCompatibility, cellMap, resolveCell } from "./assumptions.js";
import { newId, recordEvent } from "./store.js";

export const ENGINE_VERSION = "workforce-model-1.0.0";
const MODEL_FILE = fileURLToPath(import.meta.url);

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries([...Object.entries(value)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

export async function programFingerprint() {
  // 程序指纹覆盖推演实现本身：源码 + 引擎版本号。
  const source = await readFile(MODEL_FILE, "utf8");
  return { algorithm: "sha256", version: ENGINE_VERSION, fingerprint: sha256(`${ENGINE_VERSION}\n${source}`) };
}

/**
 * 把情景选中的假设固化为输入快照：即使之后假设被替代，旧版本仍可原样复现。
 */
export function buildInputSnapshot(store, baseline, assumptionIds) {
  const picked = assumptionIds.map((id) => {
    const a = store.assumptions.get(id);
    return {
      id: a.id,
      field: a.field,
      profession: a.profession,
      region: a.region,
      year_range: a.year_range,
      value: a.value,
      unit: a.unit,
      ci: a.ci,
      source_id: a.source_id,
      population_scope: a.population_scope,
      submitted_by: a.submitted_by
    };
  });
  const snapshot = {
    baseline_snapshot_id: baseline.snapshot_id,
    reference_date: baseline.reference_date,
    window: [baseline.first_projection_year, baseline.target_year],
    definitions: {
      physician: "不含执业助理医师",
      nurse: "注册护士（按执业地统计，不含在校护生）"
    },
    initial_stocks: baseline.stocks_2025,
    initial_inputs: baseline.initial_inputs_2026,
    assumptions: picked
  };
  snapshot.fingerprint = sha256(canonicalJson({ ...snapshot, assumptions: picked.map((p) => ({ ...p, submitted_by: undefined })) }));
  return snapshot;
}

function resolverFromSnapshot(snapshot, baseline) {
  const cells = cellMap(snapshot.assumptions);
  return function resolve(field, profession, region, year) {
    const hit = cells.get(cellKey(field, profession, region, year));
    if (hit) return { value: hit[0].value, origin: "assumption", assumption_id: hit[0].id, ci: hit[0].ci };
    const fieldDef = baseline.fields[field];
    if (fieldDef && fieldDef.default_value !== null && fieldDef.default_value !== undefined) {
      return { value: fieldDef.default_value, origin: "baseline_default", assumption_id: null, ci: null };
    }
    const seed = snapshot.initial_inputs?.[profession]?.[field];
    if (seed) return { value: seed.value, origin: "baseline_input", assumption_id: null, ci: null, source_id: seed.source_id };
    if (field === "base_stock") {
      return { value: snapshot.initial_stocks?.[profession]?.value ?? 0, origin: "baseline_stock", assumption_id: null, ci: null };
    }
    return { value: 0, origin: "zero_fallback", assumption_id: null, ci: null };
  };
}

/**
 * 逐年存量递推（仅在可比投影单元上进行）：
 *   存量_end = 存量_start + 招生×完成率 − 退休 + 净流动
 *   服务能力 = 存量_end × 人均效率
 */
export function project(snapshot, baseline, options = {}) {
  const resolve = options.resolve ?? resolverFromSnapshot(snapshot, baseline);
  const professions = options.professions ?? ["physician", "nurse"];
  const region = options.region ?? "NATIONAL";
  const years = yearsOf(snapshot.window);
  const results = {};

  for (const profession of professions) {
    let stock = snapshot.initial_stocks?.[profession]?.value ?? 0;
    const rows = [];
    for (const year of years) {
      const stockStart = stock;
      const intake = resolve("training_intake", profession, region, year);
      const completion = resolve("training_completion", profession, region, year);
      const retirement = resolve("retirement_rate", profession, region, year);
      const migration = resolve("migration_rate", profession, region, year);
      const productivity = resolve("productivity", profession, region, year);
      const demand = resolve("demand_visits", profession, region, year);

      const entrants = intake.value * completion.value;
      const retirees = stockStart * retirement.value;
      const netFlow = stockStart * migration.value;
      const stockEnd = stockStart + entrants - retirees + netFlow;
      const capacity = stockEnd * productivity.value;
      rows.push({
        year,
        stock_start: round(stockStart),
        entrants: round(entrants),
        retirees: round(retirees),
        net_flow: round(netFlow),
        stock_end: round(stockEnd),
        productivity: productivity.value,
        service_capacity: round(capacity),
        demand_visits: demand.origin === "zero_fallback" ? null : round(demand.value),
        capacity_gap: demand.origin === "zero_fallback" ? null : round(capacity - demand.value),
        origins: {
          training_intake: intake.assumption_id ?? intake.origin,
          training_completion: completion.assumption_id ?? completion.origin,
          retirement_rate: retirement.assumption_id ?? retirement.origin,
          migration_rate: migration.assumption_id ?? migration.origin,
          productivity: productivity.assumption_id ?? productivity.origin
        }
      });
      stock = stockEnd;
    }
    const targetRow = baseline.national_targets[profession];
    const end2030 = rows.find((r) => r.year === baseline.target_year) ?? rows.at(-1);
    results[profession] = {
      rows,
      stock_2030: end2030.stock_end,
      target: targetRow.target,
      gap_to_target: round(end2030.stock_end - targetRow.target),
      target_met: end2030.stock_end >= targetRow.target
    };
  }
  return {
    window: snapshot.window,
    region,
    professions: results,
    conclusion: {
      physician_target_met: results.physician.target_met,
      nurse_target_met: results.nurse.target_met,
      headline: `${results.physician.target_met && results.nurse.target_met ? "双目标达标" : "存在未达标职业"}（医师缺口 ${Math.max(0, -results.physician.gap_to_target)}，护士缺口 ${Math.max(0, -results.nurse.gap_to_target)}）`
    }
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * 创建候选情景：兼容性检查不通过则拒绝；记录异议/少数方案可通过 dissent 随版本保存。
 */
export function createScenario(store, baseline, input, now = new Date()) {
  const memberIds = [...new Set(input.assumption_ids ?? [])];
  if (memberIds.length === 0) throw new Error("情景至少包含一个假设");
  const check = checkCompatibility(store, baseline, memberIds, input.options);
  if (!check.compatible) {
    const error = new Error("假设不兼容，不能组合求和");
    error.code = "INCOMPATIBLE";
    error.issues = check.issues;
    throw error;
  }
  const snapshot = buildInputSnapshot(store, baseline, memberIds);
  const scenario = {
    id: input.id ?? newId(store, "SCN"),
    name: input.name ?? "未命名情景",
    description: input.description ?? "",
    assumption_ids: memberIds,
    input_fingerprint: snapshot.fingerprint,
    created_at: new Date(now).toISOString(),
    status: "candidate",
    dissents: input.dissent ? [serializeDissent(input.dissent, now)] : []
  };
  store.scenarios.set(scenario.id, scenario);
  recordEvent(store, "scenario_created", { scenario_id: scenario.id, members: memberIds.length });
  return { scenario, snapshot };
}

export function addDissent(store, scenarioId, dissent, now = new Date()) {
  const scenario = store.scenarios.get(scenarioId);
  if (!scenario) throw new Error("情景不存在");
  scenario.dissents.push(serializeDissent(dissent, now));
  recordEvent(store, "dissent_recorded", { scenario_id: scenarioId });
  return scenario;
}

function serializeDissent(dissent, now) {
  if (!dissent.org_type || !dissent.message) throw new Error("异议必须包含 org_type 与 message");
  return {
    at: dissent.at ?? new Date(now).toISOString(),
    org_type: dissent.org_type,
    reviewer_id: dissent.reviewer_id ?? null,
    message: dissent.message,
    minority_assumption_ids: dissent.minority_assumption_ids ?? [],
    minority_run_id: dissent.minority_run_id ?? null
  };
}

function conclusionKey(projection) {
  return `${projection.conclusion.physician_target_met}|${projection.conclusion.nurse_target_met}`;
}

/**
 * 运行情景：主结果 + 对每个含 CI 的假设做单变量敏感性（取下限、上限重算）。
 * 记录哪些变量翻转了达标结论，并给出 2030 存量效应排序（tornado）。
 */
export async function runScenario(store, baseline, scenarioId, options = {}, now = new Date()) {
  const scenario = store.scenarios.get(scenarioId);
  if (!scenario) throw new Error("情景不存在");
  const snapshot = buildInputSnapshot(store, baseline, scenario.assumption_ids);
  const base = project(snapshot, baseline, options);
  const baseKey = conclusionKey(base);

  const sensitivity = [];
  for (const a of snapshot.assumptions) {
    if (!a.ci) continue;
    for (const bound of ["lo", "hi"]) {
      const override = new Map(snapshot.assumptions.map((x) => [x.id, x]));
      override.set(a.id, { ...a, value: a.ci[bound] });
      const perturbedSnapshot = { ...snapshot, assumptions: [...override.values()] };
      const out = project(perturbedSnapshot, baseline, options);
      sensitivity.push({
        assumption_id: a.id,
        field: a.field,
        profession: a.profession,
        region: a.region,
        bound,
        value: a.ci[bound],
        physician_stock_2030: out.professions.physician.stock_2030,
        nurse_stock_2030: out.professions.nurse.stock_2030,
        conclusion_key: conclusionKey(out),
        conclusion_changed: conclusionKey(out) !== baseKey,
        headline: out.conclusion.headline
      });
    }
  }
  const conclusionChangers = sensitivity.filter((s) => s.conclusion_changed);

  // tornado：按 |hi 效应 − lo 效应| 对变量排序
  const byAssumption = new Map();
  for (const s of sensitivity) {
    if (!byAssumption.has(s.assumption_id)) {
      byAssumption.set(s.assumption_id, { assumption_id: s.assumption_id, field: s.field, profession: s.profession, region: s.region, lo: null, hi: null });
    }
    const row = byAssumption.get(s.assumption_id);
    row[s.bound] = s.profession === "physician" ? s.physician_stock_2030 : s.nurse_stock_2030;
  }
  const tornado = [...byAssumption.values()]
    .map((r) => ({ ...r, swing: round(Math.abs((r.hi ?? 0) - (r.lo ?? 0))) }))
    .sort((a, b) => b.swing - a.swing);

  const prog = await programFingerprint();
  const run = {
    id: newId(store, "RUN"),
    scenario_id: scenarioId,
    ran_at: new Date(now).toISOString(),
    engine_version: prog.version,
    program_fingerprint: prog.fingerprint,
    input_fingerprint: snapshot.fingerprint,
    input_snapshot: snapshot,
    options,
    projection: base,
    sensitivity,
    conclusion_changers: conclusionChangers.map((c) => ({
      assumption_id: c.assumption_id,
      field: c.field,
      profession: c.profession,
      bound: c.bound,
      value: c.value,
      headline: c.headline
    })),
    tornado
  };
  store.runs.set(run.id, run);
  recordEvent(store, "scenario_run", { run_id: run.id, scenario_id: scenarioId, changed: run.conclusion_changers.length });
  return run;
}

/**
 * 在完全相同的输入快照与程序指纹上复现历史运行。
 */
export async function reproduceRun(store, runId, baseline) {
  const historical = store.runs.get(runId);
  if (!historical) throw new Error("运行不存在");
  const prog = await programFingerprint();
  const reprojected = project(historical.input_snapshot, baseline, historical.options);
  const reproducedKey = conclusionKey(reprojected);
  return {
    run_id: runId,
    same_program: prog.fingerprint === historical.program_fingerprint,
    current_program_fingerprint: prog.fingerprint,
    stored_program_fingerprint: historical.program_fingerprint,
    same_input: historical.input_fingerprint === historical.input_snapshot.fingerprint,
    same_conclusion: reproducedKey === conclusionKey(historical.projection),
    reprojected_conclusion: reprojected.conclusion,
    stored_conclusion: historical.projection.conclusion,
    note: prog.fingerprint === historical.program_fingerprint
      ? "程序未变更，结果可在相同快照上复现"
      : "程序已变更：历史结果仍以冻结版本为准，复现结果仅供对照"
  };
}

/** 指标血缘：任一指标回溯到假设链、来源与未决分歧。 */
export function metricLineage(store, baseline, runId, metric) {
  const run = store.runs.get(runId);
  if (!run) throw new Error("运行不存在");
  const [profession, , yearStr] = metric.split(".");
  const year = Number(yearStr);
  const projection = run.projection.professions[profession];
  if (!projection) throw new Error("指标职业不存在，可用 physician / nurse");
  const row = projection.rows.find((r) => r.year === year);
  if (!row) throw new Error("指标年份不在推演窗口");

  const chain = [];
  for (const [field, origin] of Object.entries(row.origins)) {
    if (typeof origin === "string" && origin.startsWith("ASM")) {
      const a = store.assumptions.get(origin);
      const source = a ? store.sources.get(a.source_id) : null;
      const openClr = store.clarifications.find((c) => c.assumption_id === origin && c.status === "open");
      chain.push({
        field,
        assumption_id: origin,
        value: a?.value,
        unit: a?.unit,
        ci: a?.ci,
        submitted_by: a?.submitted_by,
        source: source ? { id: source.id, title: source.title, publisher: source.publisher, published_on: source.published_on, superseded_by: source.superseded_by } : null,
        open_clarification: openClr?.id ?? null
      });
    } else {
      chain.push({ field, origin, assumption_id: null, note: "基线默认值或基线初始输入" });
    }
  }
  const unresolved = listRunDisagreements(store, run);
  const alternatives = store.scenarios.get(run.scenario_id)?.dissents ?? [];
  return {
    metric,
    value: metric.startsWith(`${profession}.stock`) ? row.stock_end : metric.endsWith("service_capacity") ? row.service_capacity : row.stock_end,
    year,
    assumption_chain: chain,
    unresolved_disagreements: unresolved,
    minority_options: alternatives,
    input_fingerprint: run.input_fingerprint,
    program_fingerprint: run.program_fingerprint
  };
}

export function listRunDisagreements(store, run) {
  // 同单元的已接受替代方案，即使未入选，也作为未解决分歧呈现给决策者；
  // 值与口径完全相同的重复提交（如单位折算后重新提交、修订版沿用段）不算分歧。
  const sig = (a) => `${a.value}|${a.unit}|${a.population_scope}`;
  const out = [];
  for (const picked of run.input_snapshot.assumptions) {
    const alts = [...store.assumptions.values()].filter(
      (a) =>
        a.status === "accepted" &&
        a.id !== picked.id &&
        sig(a) !== sig(picked) &&
        a.field === picked.field &&
        a.profession === picked.profession &&
        a.region === picked.region &&
        a.year_range[0] === picked.year_range[0]
    );
    for (const alt of alts) {
      out.push({ cell: `${picked.field}/${picked.profession}/${picked.region}/${picked.year_range[0]}`, selected: picked.id, selected_value: picked.value, alternative: alt.id, alternative_value: alt.value, org_type: alt.submitted_by?.org_type });
    }
  }
  return out;
}
