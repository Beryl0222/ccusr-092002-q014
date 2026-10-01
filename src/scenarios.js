import { clone, fingerprint, newId } from "./util.js";
import { evaluateScenario, FLOW_VARIABLES, resultFingerprint, sensitivityAnalysis } from "./engine.js";

/**
 * 候选情景工作室：研究人员只能把「兼容」的活跃假设组合成候选情景。
 * 求和纪律：
 *  1. 同一格（变量×队伍×地区，时间重叠）出现两条假设即冲突，必须先澄清取舍；
 *  2. 全国格 CN 与地方格 CN-XX 不得在同一情景中混用、相加；
 *  3. 情景所含每支队伍、每个地区必须覆盖基期存量与全部五个流量变量，
 *     覆盖不齐不得求和、不得给出达标结论；
 *  4. 全国情景净流入率必须为 0（省际调入调出在全国层面须配对轧平）。
 */

export function checkCompatibility(assumptions, baseline) {
  const errors = [];

  if (assumptions.some((a) => a.status !== "active")) {
    throw Object.assign(new Error("只有通过门禁的 active 假设才能进入候选情景"), {
      code: "INACTIVE_ASSUMPTION",
    });
  }

  const regions = new Set(assumptions.map((a) => a.region));
  const scope = regions.has(baseline.region_taxonomy.national)
    ? regions.size === 1
      ? "national"
      : "mixed"
    : "regional";

  if (scope === "mixed") {
    errors.push({
      code: "REGION_SCOPE_MIX",
      message: `全国格与地方格混用（${[...regions].sort().join("、")}），全国与地方数字不可直接相加`,
    });
  }

  const workforces = [...new Set(assumptions.map((a) => a.workforce))].sort();

  // 同格冲突（时间范围重叠即算）
  const slots = new Map();
  for (const a of assumptions) {
    const key = `${a.variable}|${a.workforce}|${a.region}`;
    const held = slots.get(key);
    if (held) {
      const overlap = !(a.year_end < held.year_start || held.year_end < a.year_start);
      if (overlap) {
        errors.push({
          code: "DUPLICATE_SLOT",
          message: `变量 ${a.variable}/${a.workforce}/${a.region} 在 ${a.year_start}-${a.year_end} 与 ${held.year_start}-${held.year_end} 存在两条竞争假设（${held.id} 与 ${a.id}），须先澄清取舍`,
          slot: { variable: a.variable, workforce: a.workforce, region: a.region },
          assumptions: [held.id, a.id],
        });
      }
    } else {
      slots.set(key, a);
    }
  }

  const required = ["stock", ...FLOW_VARIABLES];
  for (const workforce of workforces) {
    for (const region of regions) {
      const have = new Set(
        assumptions
          .filter((a) => a.workforce === workforce && a.region === region)
          .map((a) => a.variable),
      );
      const missing = required.filter((v) => !have.has(v));
      if (missing.length > 0) {
        errors.push({
          code: "INCOMPLETE_COVERAGE",
          message: `${workforce}/${region} 缺少变量 ${missing.join("、")}，覆盖不齐不得求和或给出达标结论`,
          workforce,
          region,
          missing,
        });
      }

      const inflow = assumptions.find(
        (a) =>
          a.workforce === workforce &&
          a.region === region &&
          a.variable === "net_inflow_rate",
      );
      if (scope === "national" && inflow && inflow.point !== 0) {
        errors.push({
          code: "NATIONAL_INFLOW_NONZERO",
          message: `全国情景 ${workforce} 的净流入率必须为 0（当前 ${inflow.point}），省际流动须配对轧平`,
          assumption_id: inflow.id,
        });
      }

      const stock = assumptions.find(
        (a) => a.workforce === workforce && a.region === region && a.variable === "stock",
      );
      if (stock && !(stock.year_start <= baseline.baseline_year && stock.year_end >= baseline.baseline_year)) {
        errors.push({
          code: "STOCK_YEAR_MISMATCH",
          message: `${workforce}/${region} 基期存量未覆盖基期年 ${baseline.baseline_year}`,
        });
      }
      // 同格可能存在时间不重叠的多条假设，每一条都必须完整覆盖递推年份
      for (const a of assumptions.filter(
        (x) =>
          x.workforce === workforce &&
          x.region === region &&
          FLOW_VARIABLES.includes(x.variable),
      )) {
        if (a.year_start > baseline.baseline_year + 1 || a.year_end < baseline.target_year) {
          errors.push({
            code: "FLOW_YEAR_GAP",
            message: `${workforce}/${region}/${a.variable} 适用期 ${a.year_start}-${a.year_end} 未覆盖递推年份 ${baseline.baseline_year + 1}-${baseline.target_year}`,
          });
        }
      }
    }
  }

  return { compatible: errors.length === 0, scope, regions: [...regions].sort(), workforces, errors };
}

export function createScenarioStudio({ baseline, gate }) {
  const scenarios = new Map();

  function compose({ name, assumption_ids, author, note = null }) {
    const records = assumption_ids.map((id) => gate.get(id));
    const check = checkCompatibility(records, baseline);
    const now = new Date().toISOString();
    const scenario = {
      id: newId("SCN"),
      name,
      author: author ? clone(author) : null,
      note,
      baseline_id: baseline.baseline_id,
      assumption_ids: records.map((a) => a.id),
      assumptions: records.map(clone),
      scope: check.scope,
      regions: check.regions,
      workforces: check.workforces,
      compatibility: { compatible: check.compatible, errors: check.errors },
      results: null,
      sensitivity: null,
      result_fingerprint: null,
      created_at: now,
    };
    scenario.input_fingerprint = fingerprint(serializeScenario(scenario));
    if (check.compatible) evaluate(scenario);
    scenarios.set(scenario.id, scenario);
    return clone(scenario);
  }

  function evaluate(scenario) {
    const results = evaluateScenario(scenario, baseline);
    scenario.results = results;
    scenario.sensitivity = sensitivityAnalysis(scenario, baseline);
    scenario.result_fingerprint = resultFingerprint(results);
  }

  function get(id) {
    const scenario = scenarios.get(id);
    if (!scenario) throw Object.assign(new Error(`情景 ${id} 不存在`), { code: "NOT_FOUND" });
    return scenario;
  }

  /** 快照冻结后重放：用冻结输入重建临时情景并重新计算。 */
  function replay(frozen) {
    const check = checkCompatibility(frozen.assumptions, baseline);
    if (!check.compatible) {
      return { reproduced: false, reason: "frozen_inputs_incompatible", errors: check.errors };
    }
    const replayScenario = {
      ...clone(frozen),
      compatibility: { compatible: true, errors: [] },
      results: null,
      sensitivity: null,
      result_fingerprint: null,
    };
    evaluate(replayScenario);
    const reproduced = replayScenario.result_fingerprint === frozen.result_fingerprint;
    return {
      reproduced,
      reason: reproduced ? null : "result_fingerprint_mismatch",
      results: replayScenario.results,
      result_fingerprint: replayScenario.result_fingerprint,
      expected_fingerprint: frozen.result_fingerprint,
    };
  }

  function list() {
    return [...scenarios.values()].map((s) =>
      clone({ ...s, assumptions: s.assumptions.map(stripAssumption) }),
    );
  }

  return { scenarios, compose, get, replay, list };
}

function stripAssumption(a) {
  // 列表视图不重复携带完整来源正文，保留溯源标识
  return {
    id: a.id,
    variable: a.variable,
    workforce: a.workforce,
    region: a.region,
    point: a.point,
    ci: a.ci,
    unit: a.unit,
    source: a.source,
    submitter: a.submitter,
    year_start: a.year_start,
    year_end: a.year_end,
  };
}

export function serializeScenario(scenario) {
  return {
    baseline_id: scenario.baseline_id,
    assumption_ids: [...scenario.assumption_ids].sort(),
    assumption_contents: scenario.assumptions
      .map((a) => ({
        id: a.id,
        variable: a.variable,
        workforce: a.workforce,
        region: a.region,
        year_start: a.year_start,
        year_end: a.year_end,
        point: a.point,
        ci: a.ci,
        unit: a.unit,
        content_fingerprint: a.content_fingerprint,
      }))
      .sort((x, y) => x.id.localeCompare(y.id)),
  };
}
