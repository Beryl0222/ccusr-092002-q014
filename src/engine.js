import { clone, fingerprint, finiteNumber } from "./util.js";

/**
 * 测算引擎（纯函数，便于在冻结快照上重放）：
 *
 *   stock_t = stock_{t-1} × (1 - 退休率 + 净流入率) + 培训入口 × 完成率
 *   有效服务能力_2030 = stock_2030 × 效率指数
 *
 * 培训周期滞后按基线定义已并入完成率；全国净流入必须为 0，
 * 省际调入调出须配对记账，二者在情景兼容性检查中强制。
 */

export const FLOW_VARIABLES = [
  "retirement_rate",
  "training_intake",
  "completion_rate",
  "net_inflow_rate",
  "efficiency_index",
];

export function projectWorkforce(params, baseline) {
  const years = [];
  let stock = params.stock;
  years.push({ year: baseline.baseline_year, stock });
  for (let year = baseline.baseline_year + 1; year <= baseline.target_year; year++) {
    const retained = stock * (1 - params.retirement_rate + params.net_inflow_rate);
    const added = params.training_intake * params.completion_rate;
    stock = retained + added;
    years.push({ year, stock: round(stock) });
  }
  const headcount = stock;
  const effectiveCapacity = stock * params.efficiency_index;
  return {
    trajectory: years,
    headcount_2030: round(headcount),
    effective_capacity_2030: round(effectiveCapacity),
    efficiency_index: params.efficiency_index,
  };
}

export function parameterMap(assumptions) {
  const params = {};
  for (const a of assumptions) params[a.variable] = a.point;
  return params;
}

export function evaluateScenario(scenario, baseline) {
  const results = {};
  for (const workforce of scenario.workforces) {
    const params = parameterMap(scenario.assumptions.filter((a) => a.workforce === workforce));
    const projection = projectWorkforce(params, baseline);
    const target = baseline.national_targets[workforce].value;
    results[workforce] = {
      ...projection,
      target,
      target_gap: round(projection.effective_capacity_2030 - target),
      meets_target: projection.effective_capacity_2030 >= target,
    };
  }
  return results;
}

/**
 * 单变量敏感性：逐个把变量推到 95% 区间上下限，重算 2030 结果。
 * conclusion_flips 记录哪些变量改变「是否达标」的结论；
 * 另给同向组合的悲观/乐观包络，供决策者看到结论稳健区间。
 */
export function sensitivityAnalysis(scenario, baseline) {
  const report = {};
  for (const workforce of scenario.workforces) {
    const chosen = scenario.assumptions.filter((a) => a.workforce === workforce);
    const baseParams = parameterMap(chosen);
    const base = projectWorkforce(baseParams, baseline);
    const target = baseline.national_targets[workforce].value;
    const baseMeets = base.effective_capacity_2030 >= target;

    const variables = [];
    for (const a of chosen) {
      const swings = [];
      for (const end of ["low", "high"]) {
        const params = { ...baseParams, [a.variable]: a.ci[end] };
        const out = projectWorkforce(params, baseline);
        const meets = out.effective_capacity_2030 >= target;
        swings.push({
          end,
          value: a.ci[end],
          effective_capacity_2030: out.effective_capacity_2030,
          meets_target: meets,
        });
      }
      const delta = Math.abs(swings[1].effective_capacity_2030 - swings[0].effective_capacity_2030);
      const flips = swings.some((s) => s.meets_target !== baseMeets);
      variables.push({
        variable: a.variable,
        assumption_id: a.id,
        point: a.point,
        ci: clone(a.ci),
        swings,
        abs_impact: round(delta),
        conclusion_flips: flips,
      });
    }
    variables.sort((x, y) => y.abs_impact - x.abs_impact);

    const adverseParams = {};
    const favorableParams = {};
    for (const a of chosen) {
      const positiveDriver = a.variable !== "retirement_rate";
      adverseParams[a.variable] = positiveDriver ? a.ci.low : a.ci.high;
      favorableParams[a.variable] = positiveDriver ? a.ci.high : a.ci.low;
    }
    const adverse = projectWorkforce(adverseParams, baseline);
    const favorable = projectWorkforce(favorableParams, baseline);

    report[workforce] = {
      baseline_meeting: baseMeets,
      baseline_effective_capacity_2030: base.effective_capacity_2030,
      target,
      tornado: variables,
      conclusion_flip_variables: variables.filter((v) => v.conclusion_flips).map((v) => v.variable),
      envelope: {
        adverse: {
          effective_capacity_2030: adverse.effective_capacity_2030,
          meets_target: adverse.effective_capacity_2030 >= target,
        },
        favorable: {
          effective_capacity_2030: favorable.effective_capacity_2030,
          meets_target: favorable.effective_capacity_2030 >= target,
        },
      },
    };
  }
  return report;
}

export function resultFingerprint(results) {
  return fingerprint({
    results: roundNested(results),
    model: "stock*(1-retirement+net_inflow)+intake*completion; capacity=stock*efficiency",
  });
}

function roundNested(value) {
  if (Array.isArray(value)) return value.map(roundNested);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundNested(v)]));
  }
  return typeof value === "number" ? round(value) : value;
}

function round(n) {
  if (!finiteNumber(n)) return n;
  return Math.round(n * 1e3) / 1e3;
}
