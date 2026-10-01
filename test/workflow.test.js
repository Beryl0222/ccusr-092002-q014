import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";

const NOW = new Date("2026-10-01T00:00:00Z");
const hospital = { org_type: "hospital", org_name: "H" };
const education = { org_type: "education", org_name: "E" };
const finance = { org_type: "finance", org_name: "F" };

async function newApp() {
  return createApp({ now: NOW });
}

async function source(app, over = {}) {
  return app.registerSource({ title: "t", publisher: "p", published_on: "2026-01-01", ...over });
}

const base = (over = {}) => ({
  field: "retirement_rate",
  profession: "physician",
  region: "NATIONAL",
  year_range: [2026, 2030],
  value: 0.035,
  unit: "fraction",
  ci: { lo: 0.03, hi: 0.04 },
  submitted_by: hospital,
  ...over
});

test("单位冲突自动进入澄清，不参与求和", async () => {
  const app = await newApp();
  const s = await source(app);
  const result = app.submitAssumption(base({ source_id: s.id, field: "training_intake", value: 33, unit: "wan_per_year", ci: { lo: 30, hi: 36 } }));
  assert.equal(result.assumption.status, "clarification");
  assert.ok(result.clarification.issues.some((i) => i.code === "UNIT_CONFLICT"));
  assert.equal(app.listClarifications("open").length, 1);

  // 带未决澄清不能组情景
  assert.throws(
    () => app.createScenario({ name: "x", assumption_ids: [result.assumption.id] }),
    (e) => e.code === "INCOMPATIBLE" && e.issues.some((i) => i.code === "BLOCKED_BY_CLARIFICATION")
  );
});

test("percent 与 fraction 同源可自动换算并按归一化单位校验", async () => {
  const app = await newApp();
  const s = await source(app);
  const result = app.submitAssumption(base({
    source_id: s.id, field: "training_completion", value: 92, unit: "percent", ci: { lo: 88, hi: 95 }
  }));
  assert.equal(result.assumption.status, "accepted");
  assert.equal(result.assumption.value, 0.92);
  assert.equal(result.assumption.unit, "fraction");
  assert.equal(result.assumption.ci.lo, 0.88);
});

test("统计口径不一致进入澄清", async () => {
  const app = await newApp();
  const s = await source(app);
  const result = app.submitAssumption(base({ source_id: s.id, population_scope: "including_assistants" }));
  assert.ok(result.clarification.issues.some((i) => i.code === "DEFINITION_MISMATCH"));
  // 撤回后假设不可用
  app.resolveClarification(result.clarification.id, "withdraw", { note: "口径错误" });
  assert.equal(result.assumption.status, "withdrawn");
});

test("过期来源及被替代来源不可直接引用", async () => {
  const app = await newApp();
  const stale = await source(app, { published_on: "2020-01-01" });
  const r1 = app.submitAssumption(base({ source_id: stale.id }));
  assert.ok(r1.clarification.issues.some((i) => i.code === "SOURCE_STALE"));

  const fresh = await source(app);
  app.supersedeSource(stale.id, fresh.id);
  const r2 = app.submitAssumption(base({ source_id: stale.id }));
  assert.ok(r2.clarification.issues.some((i) => i.message.includes("替代")));

  // reconcile 生成新的已接受假设并关闭澄清单
  const fixed = app.resolveClarification(r1.clarification.id, "reconcile", base({ source_id: fresh.id }));
  assert.equal(fixed.ticket.status, "closed");
  assert.equal(fixed.new_assumption.status, "accepted");
});

test("时间范围超窗、地区/职业未登记、CI 不合法均被拒", async () => {
  const app = await newApp();
  const s = await source(app);
  assert.ok(app.submitAssumption(base({ source_id: s.id, year_range: [2025, 2031] })).clarification.issues.some((i) => i.code === "RANGE_OUT_OF_WINDOW"));
  assert.ok(app.submitAssumption(base({ source_id: s.id, region: "XX" })).clarification.issues.some((i) => i.code === "UNKNOWN_REGION"));
  assert.ok(app.submitAssumption(base({ source_id: s.id, profession: "pharmacist" })).clarification.issues.some((i) => i.code === "UNKNOWN_PROFESSION"));
  assert.ok(app.submitAssumption(base({ source_id: s.id, ci: { lo: 0.1, hi: 0.05 } })).clarification.issues.some((i) => i.code === "BAD_CI"));
});

// ---- 情景与推演 ----

async function fullInputs(app, over = {}) {
  const s = await source(app);
  const specs = [
    ["retirement_rate", "physician", 0.035, "fraction", [0.03, 0.04]],
    ["retirement_rate", "nurse", 0.04, "fraction", [0.032, 0.05]],
    ["productivity", "physician", 1850, "service_visits", [1700, 2000]],
    ["productivity", "nurse", 1250, "service_visits", [1100, 1400]],
    ["training_intake", "physician", 330000, "headcount_rate", [300000, 360000]],
    ["training_intake", "nurse", 540000, "headcount_rate", [480000, 600000]],
    ["training_completion", "physician", 0.92, "fraction", [0.88, 0.95]],
    ["training_completion", "nurse", 0.88, "fraction", [0.82, 0.92]],
    ["migration_rate", "physician", 0, "fraction", [-0.002, 0.002]],
    ["migration_rate", "nurse", 0.001, "fraction", [-0.003, 0.004]]
  ];
  return specs.map(([field, profession, value, unit, ci]) =>
    app.submitAssumption(base({ ...over, field, profession, value, unit, ci: { lo: ci[0], hi: ci[1] }, source_id: s.id, basis: undefined })).assumption.id
  );
}

test("兼容假设可组成情景并推演出 2030 存量与结论", async () => {
  const app = await newApp();
  const ids = await fullInputs(app);
  const { scenario } = app.createScenario({ name: "共识", assumption_ids: ids });
  const run = await app.runScenario(scenario.id);
  assert.equal(run.projection.window.join("-"), "2026-2030");
  const p = run.projection.professions.physician;
  assert.ok(p.stock_2030 > 4_000_000 && p.stock_2030 < 6_000_000);
  assert.equal(p.target, 5_000_000);
  assert.equal(typeof p.target_met, "boolean");
  // 存量递推恒等式（2026 行）
  const row = p.rows[0];
  assert.ok(Math.abs(row.stock_end - (row.stock_start + row.entrants - row.retirees + row.net_flow)) < 0.01);
});

test("同一投影单元选择多个互斥假设被拒绝", async () => {
  const app = await newApp();
  const ids = await fullInputs(app);
  const s = app.store.assumptions.get(ids[0]);
  const alt = app.submitAssumption(base({ source_id: s.source_id, value: 0.05, ci: { lo: 0.045, hi: 0.06 } })).assumption;
  assert.throws(
    () => app.createScenario({ name: "x", assumption_ids: [...ids, alt.id] }),
    (e) => e.code === "INCOMPATIBLE" && e.issues.some((i) => i.code === "DUPLICATE_CELL")
  );
});

test("覆盖缺口被拦截（无默认值字段）", async () => {
  const app = await newApp();
  const ids = await fullInputs(app);
  // 去掉医师招生
  const withoutIntake = ids.filter((id) => app.store.assumptions.get(id).field !== "training_intake" || app.store.assumptions.get(id).profession !== "physician");
  assert.throws(
    () => app.createScenario({ name: "x", assumption_ids: withoutIntake }),
    (e) => e.issues.some((i) => i.code === "COVERAGE_GAP")
  );
});

test("省级净流动全部为正触发流量不平衡检查", async () => {
  const app = await newApp();
  const s = await source(app);
  const mk = (field, profession, region, value, ci, unit = "fraction") =>
    app.submitAssumption(base({ field, profession, region, value, unit, ci: { lo: ci[0], hi: ci[1] }, source_id: s.id })).assumption.id;

  const ids = [];
  for (const region of ["BJ", "SH"]) {
    ids.push(mk("retirement_rate", "physician", region, 0.035, [0.03, 0.04]));
    ids.push(mk("training_completion", "physician", region, 0.92, [0.88, 0.95]));
    ids.push(mk("training_intake", "physician", region, 30000, [25000, 35000], "headcount_rate"));
    ids.push(mk("productivity", "physician", region, 1850, [1700, 2000], "service_visits"));
  }
  // 两市都假设大量净流入——物理上不可能同时成立
  ids.push(mk("migration_rate", "physician", "BJ", 0.08, [0.06, 0.09]));
  ids.push(mk("migration_rate", "physician", "SH", 0.07, [0.05, 0.09]));

  assert.throws(
    () => app.createScenario({
      name: "不平衡",
      options: { regions: ["BJ", "SH"], professions: ["physician"] },
      assumption_ids: ids
    }),
    (e) => e.issues.some((i) => i.code === "FLOW_IMBALANCE")
  );

  // 一流入一流出（加权平衡）则不触发该问题：改为上海净流出后可通过检查
  const balanced = ids.filter((id) => {
    const a = app.store.assumptions.get(id);
    return !(a.field === "migration_rate" && a.region === "SH");
  });
  balanced.push(mk("migration_rate", "physician", "SH", -0.07, [-0.09, -0.05]));
  assert.doesNotThrow(() => app.createScenario({
    name: "平衡",
    options: { regions: ["BJ", "SH"], professions: ["physician"] },
    assumption_ids: balanced
  }));
});

test("敏感性分析标记翻转结论的变量并输出排序", async () => {
  const app = await newApp();
  const ids = await fullInputs(app);
  const { scenario } = app.createScenario({ name: "共识", assumption_ids: ids });
  const run = await app.runScenario(scenario.id);
  assert.ok(run.sensitivity.length > 0);
  for (const s2 of run.sensitivity) {
    assert.match(s2.bound, /^lo|hi$/);
  }
  // tornado 按 swing 降序
  const swings = run.tornado.map((t) => t.swing);
  assert.deepEqual(swings, [...swings].sort((a, b) => b - a));
});

test("相同快照上结果可复现，双指纹一致", async () => {
  const app = await newApp();
  const ids = await fullInputs(app);
  const { scenario } = app.createScenario({ name: "共识", assumption_ids: ids });
  const run = await app.runScenario(scenario.id);
  const repro = await app.reproduceRun(run.id);
  assert.equal(repro.same_program, true);
  assert.equal(repro.same_input, true);
  assert.equal(repro.same_conclusion, true);
});

test("指标血缘回溯假设链、来源与未解决分歧", async () => {
  const app = await newApp();
  const ids = await fullInputs(app);
  const { scenario } = app.createScenario({ name: "共识", assumption_ids: ids });
  const run = await app.runScenario(scenario.id);
  const lin = app.metricLineage(run.id, "physician.stock_end.2030");
  assert.equal(lin.assumption_chain.length, 5);
  const retirement = lin.assumption_chain.find((c) => c.field === "retirement_rate");
  assert.ok(retirement.assumption_id);
  assert.ok(retirement.source.published_on);
  assert.equal(lin.input_fingerprint, run.input_fingerprint);

  // 加入值不同的替代假设 -> 未解决分歧
  const s = app.store.sources.get(retirement.source.id);
  app.submitAssumption(base({ source_id: s.id, submitted_by: finance, value: 0.045, ci: { lo: 0.04, hi: 0.055 } }));
  const lin2 = app.metricLineage(run.id, "physician.stock_end.2030");
  assert.ok(lin2.unresolved_disagreements.some((d) => d.alternative_value === 0.045));
});

// ---- 治理 ----

async function governableApp() {
  const app = await newApp();
  const ids = await fullInputs(app);
  const { scenario } = app.createScenario({ name: "共识", assumption_ids: ids });
  const run = await app.runScenario(scenario.id);
  for (const r of [
    { id: "R1", name: "医", org_type: "hospital" },
    { id: "R2", name: "基", org_type: "primary_care" },
    { id: "R3", name: "教", org_type: "education" },
    { id: "R4", name: "财", org_type: "finance" }
  ]) app.registerReviewer(r);
  return { app, scenario, run };
}

test("未披露利益关系不能表决；回避者不能表决", async () => {
  const { app, run } = await governableApp();
  const proposal = await app.proposeRelease({ run_id: run.id });
  assert.throws(() => app.castVote(proposal.id, { reviewer_id: "R1", position: "approve" }), /披露/);
  app.discloseInterest({ reviewer_id: "R1", has_interest: true, interests: ["x"], recuse: true });
  assert.throws(() => app.castVote(proposal.id, { reviewer_id: "R1", position: "approve" }), /回避/);
});

test("表决达法定人数与比例后冻结发布，封存输入/程序指纹与审批记录", async () => {
  const { app, run } = await governableApp();
  for (const id of ["R1", "R2", "R3", "R4"]) app.discloseInterest({ reviewer_id: id, has_interest: false });
  const proposal = await app.proposeRelease({ run_id: run.id, quorum: 3, threshold: 0.7 });
  app.castVote(proposal.id, { reviewer_id: "R1", position: "approve" });
  app.castVote(proposal.id, { reviewer_id: "R2", position: "approve" });
  const t3 = app.castVote(proposal.id, { reviewer_id: "R3", position: "reject" });
  assert.equal(t3.tally_status, "below_threshold");
  app.castVote(proposal.id, { reviewer_id: "R4", position: "approve" });
  const release = await app.publishRelease(proposal.id);
  assert.equal(release.status, "frozen");
  assert.ok(release.input_fingerprint);
  assert.ok(release.program_fingerprint);
  assert.equal(release.approval.votes.length, 4);
  assert.equal(release.program_unchanged, true);
  assert.throws(() => app.castVote(proposal.id, { reviewer_id: "R1", position: "approve" }), /已结束/);
});

test("赞成比例不足不能发布", async () => {
  const { app, run } = await governableApp();
  for (const id of ["R1", "R2", "R3"]) app.discloseInterest({ reviewer_id: id, has_interest: false });
  const proposal = await app.proposeRelease({ run_id: run.id, quorum: 3, threshold: 0.8 });
  app.castVote(proposal.id, { reviewer_id: "R1", position: "approve" });
  app.castVote(proposal.id, { reviewer_id: "R2", position: "reject" });
  app.castVote(proposal.id, { reviewer_id: "R3", position: "reject" });
  await assert.rejects(() => app.publishRelease(proposal.id), /低于/);
});

test("异议与少数方案随版本保存", async () => {
  const { app, scenario, run } = await governableApp();
  app.addDissent(scenario.id, {
    org_type: "finance", reviewer_id: "R4",
    message: "退休率取高值的少数判断", minority_assumption_ids: [], minority_run_id: run.id
  });
  for (const id of ["R1", "R2", "R3"]) app.discloseInterest({ reviewer_id: id, has_interest: false });
  const proposal = await app.proposeRelease({ run_id: run.id });
  for (const id of ["R1", "R2", "R3"]) app.castVote(proposal.id, { reviewer_id: id, position: "approve" });
  const release = await app.publishRelease(proposal.id);
  assert.equal(release.dissents.length, 1);
  assert.match(release.dissents[0].message, /少数/);
});

test("冻结后新数据只能另起修订版，不改写已发布版本", async () => {
  const { app, run } = await governableApp();
  for (const id of ["R1", "R2", "R3"]) app.discloseInterest({ reviewer_id: id, has_interest: false });
  const proposal = await app.proposeRelease({ run_id: run.id });
  for (const id of ["R1", "R2", "R3"]) app.castVote(proposal.id, { reviewer_id: id, position: "approve" });
  const release = await app.publishRelease(proposal.id);
  const before = JSON.stringify(release.frozen_input);

  const rev = app.openRevision(release.id, { reason: "新数据", new_sources: [] });
  assert.equal(rev.parent_release_id, release.id);
  assert.equal(rev.status, "draft");
  assert.equal(JSON.stringify(app.getRelease(release.id).frozen_input), before);

  // 修订版必须绑定自己的新情景，重新走表决
  const ids2 = await fullInputs(app);
  const { scenario: s2 } = app.createScenario({ name: "R2 候选", assumption_ids: ids2 });
  const bound = app.bindRevisionScenario(rev.id, s2.id);
  assert.equal(bound.status, "ready_for_review");
});
