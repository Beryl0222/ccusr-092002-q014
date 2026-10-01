import assert from "node:assert/strict";
import test from "node:test";

import { loadBaseline } from "../src/baseline.js";
import { createAssumptionGate } from "../src/assumptions.js";
import { checkCompatibility, createScenarioStudio } from "../src/scenarios.js";
import { assumption, submitFullSet, EDU } from "./helpers.js";

const baseline = await loadBaseline();

function fresh() {
  const gate = createAssumptionGate(baseline);
  const studio = createScenarioStudio({ baseline, gate });
  return { gate, studio };
}

test("完整六变量兼容集：可以组合并完成测算", () => {
  const { gate, studio } = fresh();
  const ids = submitFullSet(gate);
  const s = studio.compose({ name: "完整集", assumption_ids: ids });
  assert.equal(s.compatibility.compatible, true, JSON.stringify(s.compatibility.errors));
  assert.equal(s.scope, "national");
  assert.ok(s.results.physicians.headcount_2030 > 0);
  assert.equal(typeof s.results.physicians.meets_target, "boolean");
});

test("覆盖不齐不得求和：缺变量情景标记 INCOMPLETE_COVERAGE 且不产出结果", () => {
  const { gate, studio } = fresh();
  const ids = submitFullSet(gate).filter((_, i) => i !== 1); // 去掉 retirement_rate
  const s = studio.compose({ name: "缺退休率", assumption_ids: ids });
  assert.equal(s.compatibility.compatible, false);
  assert.ok(s.compatibility.errors.some((e) => e.code === "INCOMPLETE_COVERAGE"));
  assert.equal(s.results, null);
});

test("同格竞争假设（时间重叠）触发 DUPLICATE_SLOT", () => {
  const { gate, studio } = fresh();
  const ids = submitFullSet(gate);
  const duplicate = gate.submit(assumption({ point: 0.04, ci: { low: 0.03, high: 0.05 } }));
  const s = studio.compose({ name: "双退休率", assumption_ids: [...ids, duplicate.id] });
  assert.ok(s.compatibility.errors.some((e) => e.code === "DUPLICATE_SLOT"));
});

test("同变量时间不重叠的两条假设不算同格冲突，但流量期未覆盖仍会被拦", () => {
  const { gate, studio } = fresh();
  const ids = submitFullSet(gate);
  const other = gate.submit(assumption({
    year_start: 2025, year_end: 2025, point: 0.02, ci: { low: 0.015, high: 0.025 },
  }));
  const s = studio.compose({ name: "时间段错开", assumption_ids: [...ids, other.id] });
  // 没有重复槽，但新条 2024-2025 流量未覆盖 2027-2030 → FLOW_YEAR_GAP，且原槽仍完整
  assert.equal(s.compatibility.errors.some((e) => e.code === "DUPLICATE_SLOT"), false);
  assert.ok(s.compatibility.errors.some((e) => e.code === "FLOW_YEAR_GAP"));
});

test("全国格与地方格混用不可相加（REGION_SCOPE_MIX）", () => {
  const gate = createAssumptionGate(baseline);
  const national = submitFullSet(gate, { region: "CN" });
  const beijing = submitFullSet(gate, { region: "CN-BJ", stock: 120000 });
  const s = createScenarioStudio({ baseline, gate }).compose({
    name: "混用", assumption_ids: [...national, ...beijing],
  });
  assert.ok(s.compatibility.errors.some((e) => e.code === "REGION_SCOPE_MIX"));
});

test("纯地方格可组合；全国净流入非零被强制轧平", () => {
  const gate = createAssumptionGate(baseline);
  const bj = submitFullSet(gate, { region: "CN-BJ", stock: 120000 });
  const studio = createScenarioStudio({ baseline, gate });
  const ok = studio.compose({ name: "北京", assumption_ids: bj });
  assert.equal(ok.compatibility.compatible, true, JSON.stringify(ok.compatibility.errors));
  assert.equal(ok.scope, "regional");

  // 地方净流入为 0 没问题；全国情景净流入必须为 0
  const gate2 = createAssumptionGate(baseline);
  const ids = submitFullSet(gate2);
  const nonzero = gate2.submit(assumption({
    variable: "net_inflow_rate", point: 0.01, ci: { low: 0.005, high: 0.02 },
    year_start: 2026, year_end: 2030, submitter: { constituency: "primary_care", org: "x" },
  }));
  // 替换掉原净流入（同格重复），先取原 id
  const origInflow = gate2.list({ workforce: "physicians" })
    .find((a) => a.variable === "net_inflow_rate").id;
  const s2 = studio2compose(gate2, ids.filter((id) => id !== origInflow).concat(nonzero.id));
  assert.ok(s2.compatibility.errors.some((e) => e.code === "NATIONAL_INFLOW_NONZERO"));
});

function studio2compose(gate, ids) {
  return createScenarioStudio({ baseline, gate }).compose({ name: "全国净流入非零", assumption_ids: ids });
}

test("非 active（澄清中）假设不得组合", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({ unit: "percent", point: 2.5 }));
  assert.throws(
    () => checkCompatibility([gate.get(a.id)], baseline),
    (e) => e.code === "INACTIVE_ASSUMPTION",
  );
});

test("测算递推：五年存量演化与能力折算是确定性的", () => {
  const { gate, studio } = fresh();
  const ids = submitFullSet(gate, { stock: 4000000 });
  const s = studio.compose({ name: "数值核对", assumption_ids: ids });
  const r = s.results.physicians;
  // stock_2030 = 4,000,000*0.975^5 + 275000*(0.975^4+...+1) ≈ 4,832,330
  assert.ok(Math.abs(r.headcount_2030 - 4832330.146) < 1, String(r.headcount_2030));
  assert.equal(r.efficiency_index, 1);
  assert.equal(r.effective_capacity_2030, r.headcount_2030);
});

test("敏感性分析记录改变达标结论的变量", () => {
  const { gate, studio } = fresh();
  // 让点估计恰好略低于目标、效率上界可翻转
  const ids = submitFullSet(gate, { stock: 4080000 });
  const s = studio.compose({ name: "临界", assumption_ids: ids });
  const sens = s.sensitivity.physicians;
  assert.ok(Array.isArray(sens.tornado));
  // 影响力排序：培训入口人数规模最大
  assert.ok(sens.tornado[0].abs_impact >= sens.tornado.at(-1).abs_impact);
  // 至少一个变量在区间端点翻转达标结论
  const anyFlip = sens.tornado.some((v) => v.conclusion_flips);
  assert.equal(anyFlip, true, JSON.stringify(sens.conclusion_flip_variables));
  assert.ok(sens.envelope.adverse.effective_capacity_2030 <=
    sens.envelope.favorable.effective_capacity_2030);
});

test("冻结输入指纹随假设内容变化", () => {
  const { gate, studio } = fresh();
  const ids = submitFullSet(gate);
  const s1 = studio.compose({ name: "A", assumption_ids: ids });
  const s2 = studio.compose({ name: "A 副本", assumption_ids: ids });
  assert.equal(s1.input_fingerprint, s2.input_fingerprint); // 相同输入 → 同指纹
  const other = gate.submit(assumption({
    variable: "retirement_rate", region: "CN-BJ", point: 0.03,
    ci: { low: 0.02, high: 0.04 },
  }));
  assert.equal(other.status, "active");
  const s3 = studio.compose({
    name: "B",
    assumption_ids: submitFullSet(gate, { region: "CN-SH", stock: 100000 }),
  });
  assert.notEqual(s1.input_fingerprint, s3.input_fingerprint);
});

test("教育方误以百分数提交的假设经更正后才能组合（端到端澄清）", () => {
  const gate = createAssumptionGate(baseline);
  const bad = gate.submit(assumption({
    variable: "completion_rate", unit: "fraction",
    point: 55, ci: { low: 50, high: 60 }, submitter: EDU,
  }));
  assert.equal(bad.status, "clarification");
  assert.throws(() => createScenarioStudio({ baseline, gate }).compose({
    name: "x", assumption_ids: submitFullSet(gate).concat(bad.id),
  }), (e) => e.code === "INACTIVE_ASSUMPTION");
});
