#!/usr/bin/env node
/**
 * 种子叙事：医院、基层、教育、财政四方围绕 BASE-2030 提交假设；
 * 单位冲突、口径不一致、来源过期先进入澄清；兼容假设组成共识情景与少数情景；
 * 披露利益关系后表决冻结 R1；新数据另起修订版 R2。
 * 运行：node scripts/seed.js [输出文件]
 */
import { saveStore } from "../src/store.js";
import { createApp } from "../src/app.js";

const NOW = new Date("2026-10-01T09:00:00Z");

const hospital = { org_type: "hospital", org_name: "省级医院联合体" };
const primary = { org_type: "primary_care", org_name: "基层卫生服务中心联盟" };
const education = { org_type: "education", org_name: "医学教育主管部门" };
const finance = { org_type: "finance", org_name: "财政规划部门" };

export async function buildSeed() {
  const app = await createApp({ now: NOW });

  // ---- 来源登记 ----
  const srcHospital = app.registerSource({
    title: "医院人力与退休抽样调查（2025）", publisher: "省级医院联合体",
    published_on: "2025-09-30", url: "https://example.org/src/hospital-2025"
  });
  const srcPrimary = app.registerSource({
    title: "基层人员流动月报汇编", publisher: "基层联盟",
    published_on: "2025-12-15", url: "https://example.org/src/primary-2025"
  });
  const srcEdu = app.registerSource({
    title: "医学教育招生与完成率统计", publisher: "教育主管部门",
    published_on: "2025-11-30", url: "https://example.org/src/edu-2025"
  });
  const srcFinance = app.registerSource({
    title: "财政供养能力与效率测算（2025）", publisher: "财政规划部门",
    published_on: "2025-08-31", url: "https://example.org/src/finance-2025"
  });
  const srcLegacy = app.registerSource({
    title: "2021 版效率历史调查", publisher: "某研究机构",
    published_on: "2021-06-01", url: "https://example.org/src/legacy-2021"
  });

  // ---- 四方提交：可直接接受的假设（年份范围覆盖整个规划窗口）----
  const aRetireP = app.submitAssumption({
    field: "retirement_rate", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.035, unit: "fraction",
    ci: { lo: 0.03, hi: 0.04, level: 0.95 },
    source_id: srcHospital.id, submitted_by: hospital, basis: "230 家医院人事档案汇总"
  }).assumption;
  const aRetireN = app.submitAssumption({
    field: "retirement_rate", profession: "nurse", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.04, unit: "fraction",
    ci: { lo: 0.032, hi: 0.05 },
    source_id: srcHospital.id, submitted_by: hospital, basis: "护士队伍年龄结构偏年轻但流动叠加退休"
  }).assumption;
  const aProductP = app.submitAssumption({
    field: "productivity", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 1850, unit: "service_visits",
    ci: { lo: 1700, hi: 2000 },
    source_id: srcHospital.id, submitted_by: hospital, basis: "门急诊与住院等效折算"
  }).assumption;
  const aProductN = app.submitAssumption({
    field: "productivity", profession: "nurse", region: "NATIONAL",
    year_range: [2026, 2030], value: 1250, unit: "service_visits",
    ci: { lo: 1100, hi: 1400 },
    source_id: srcHospital.id, submitted_by: hospital
  }).assumption;

  const aIntakeP = app.submitAssumption({
    field: "training_intake", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 330000, unit: "headcount_rate",
    ci: { lo: 300000, hi: 360000 },
    source_id: srcEdu.id, submitted_by: education, basis: "院校扩招计划"
  }).assumption;
  const aIntakeN = app.submitAssumption({
    field: "training_intake", profession: "nurse", region: "NATIONAL",
    year_range: [2026, 2030], value: 540000, unit: "headcount_rate",
    ci: { lo: 480000, hi: 600000 },
    source_id: srcEdu.id, submitted_by: education
  }).assumption;
  const aCompletionP = app.submitAssumption({
    field: "training_completion", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 92, unit: "percent", // 同源单位，自动换算为 0.92
    ci: { lo: 88, hi: 95 },
    source_id: srcEdu.id, submitted_by: education
  }).assumption;
  const aCompletionN = app.submitAssumption({
    field: "training_completion", profession: "nurse", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.88, unit: "fraction",
    ci: { lo: 0.82, hi: 0.92 },
    source_id: srcEdu.id, submitted_by: education
  }).assumption;

  const aMigrationP = app.submitAssumption({
    field: "migration_rate", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.0, unit: "fraction",
    ci: { lo: -0.002, hi: 0.002 },
    source_id: srcPrimary.id, submitted_by: primary, basis: "全国口径净流入归零"
  }).assumption;
  const aMigrationN = app.submitAssumption({
    field: "migration_rate", profession: "nurse", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.001, unit: "fraction",
    ci: { lo: -0.003, hi: 0.004 },
    source_id: srcPrimary.id, submitted_by: primary
  }).assumption;

  // 财政部门的少数派退休率（同一投影单元的替代假设，保留分歧）
  const aRetirePMinority = app.submitAssumption({
    field: "retirement_rate", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.045, unit: "fraction",
    ci: { lo: 0.04, hi: 0.055 },
    source_id: srcFinance.id, submitted_by: finance,
    basis: "延退政策落地慢于医院预期，55/60 岁存量集中退出"
  }).assumption;

  // ---- 三类必须澄清的提交 ----
  // 1) 单位冲突：万人 与登记单位 人/年 不可换算
  const blocked1 = app.submitAssumption({
    field: "training_intake", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 33, unit: "wan_headcount_rate",
    ci: { lo: 30, hi: 36 },
    source_id: srcEdu.id, submitted_by: education
  });
  // 讨论后改为登记单位重新提交
  app.addClarificationThread(blocked1.clarification.id, "education", "原文为万人/年，折算为 330000 人/年");
  const fixed1 = app.resolveClarification(blocked1.clarification.id, "reconcile", {
    field: "training_intake", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 330000, unit: "headcount_rate",
    ci: { lo: 300000, hi: 360000 },
    source_id: srcEdu.id, submitted_by: education, note: "万人/年已折算"
  });

  // 2) 定义不一致：口径含执业助理医师
  const blocked2 = app.submitAssumption({
    field: "retirement_rate", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.038, unit: "fraction",
    ci: { lo: 0.033, hi: 0.043 },
    source_id: srcHospital.id, submitted_by: hospital,
    population_scope: "including_assistants"
  });
  app.addClarificationThread(blocked2.clarification.id, "hospital", "误用含助理医师口径，按基线重算");
  app.resolveClarification(blocked2.clarification.id, "withdraw", { note: "口径不符，撤回" });

  // 3) 来源过期：引用 2021 旧调查
  const blocked3 = app.submitAssumption({
    field: "productivity", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 1600, unit: "service_visits",
    ci: { lo: 1450, hi: 1750 },
    source_id: srcLegacy.id, submitted_by: finance
  });
  const srcFinanceNew = app.registerSource({
    title: "财政供养能力与效率测算（2026 修订）", publisher: "财政规划部门",
    published_on: "2026-06-30", url: "https://example.org/src/finance-2026"
  });
  app.supersedeSource(srcLegacy.id, srcFinanceNew.id);
  app.resolveClarification(blocked3.clarification.id, "reconcile", {
    field: "productivity", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 1820, unit: "service_visits",
    ci: { lo: 1680, hi: 1960 },
    source_id: srcFinanceNew.id, submitted_by: finance, note: "换用 2026 修订来源"
  });

  // ---- 共识候选情景（医院/教育/基层口径，退休率取医院值）----
  const consensusIds = [
    aRetireP.id, aRetireN.id, aProductP.id, aProductN.id,
    aIntakeP.id, aIntakeN.id, aCompletionP.id, aCompletionN.id,
    aMigrationP.id, aMigrationN.id
  ];
  const { scenario: consensus } = app.createScenario({
    name: "共识基线情景 R1 候选",
    description: "医院退休/效率、教育招生完成、基层全国零净流动",
    assumption_ids: consensusIds
  });
  const runConsensus = await app.runScenario(consensus.id);

  // 财政部门少数方案：退休 4.5%，结论若改变则记录在案
  const { scenario: minority } = app.createScenario({
    name: "财政少数情景：高退休率",
    description: "仅替换医师退休率为 4.5%",
    assumption_ids: consensusIds.map((id) => (id === aRetireP.id ? aRetirePMinority.id : id))
  });
  const runMinority = await app.runScenario(minority.id);
  app.addDissent(consensus.id, {
    org_type: "finance",
    reviewer_id: "RV-F",
    message: "不认同 3.5% 退休率，延退落地存在不确定性，少数情景见附件运行",
    minority_assumption_ids: [aRetirePMinority.id],
    minority_run_id: runMinority.id
  });

  // ---- 评审：先披露利益关系 ----
  for (const reviewer of [
    { id: "RV-H", name: "医院方代表", org_type: "hospital" },
    { id: "RV-P", name: "基层方代表", org_type: "primary_care" },
    { id: "RV-E", name: "教育方代表", org_type: "education" },
    { id: "RV-F", name: "财政方代表", org_type: "finance" }
  ]) app.registerReviewer(reviewer);
  app.discloseInterest({ reviewer_id: "RV-H", has_interest: true, interests: ["兼任教学医院顾问"], mitigation: "表决意见中说明，不参与退休率条目核定" });
  app.discloseInterest({ reviewer_id: "RV-P", has_interest: false });
  app.discloseInterest({ reviewer_id: "RV-E", has_interest: false });
  app.discloseInterest({ reviewer_id: "RV-F", has_interest: false });

  // ---- 提案、表决、冻结 R1 ----
  const proposal = await app.proposeRelease({ run_id: runConsensus.id, version_label: "R1", quorum: 3, threshold: 0.6 });
  app.castVote(proposal.id, { reviewer_id: "RV-H", position: "approve", comment: "同意发布，已披露顾问关系" });
  app.castVote(proposal.id, { reviewer_id: "RV-P", position: "approve" });
  app.castVote(proposal.id, { reviewer_id: "RV-E", position: "approve" });
  app.castVote(proposal.id, { reviewer_id: "RV-F", position: "reject", comment: "保留退休率少数意见，但不阻断发布" });
  const releaseR1 = await app.publishRelease(proposal.id);

  // ---- 复现校验 ----
  const repro = await app.reproduceRun(runConsensus.id);

  // ---- 新数据：2027 年扩招更新，不得改写 R1，另起修订版 ----
  const srcEdu2027 = app.registerSource({
    title: "医学教育招生统计（2027 中期更新）", publisher: "教育主管部门",
    published_on: "2027-03-31", url: "https://example.org/src/edu-2027"
  });
  const revision = app.openRevision(releaseR1.id, {
    reason: "2027 年招生计划上调，护士年增量由 54 万调整为 58 万",
    new_sources: [srcEdu2027.id]
  });
  const aIntakeNR2 = app.submitAssumption({
    field: "training_intake", profession: "nurse", region: "NATIONAL",
    year_range: [2027, 2030], value: 580000, unit: "headcount_rate",
    ci: { lo: 520000, hi: 630000 },
    source_id: srcEdu2027.id, submitted_by: education
  }).assumption;
  const aIntakeNR2Keep = app.submitAssumption({
    field: "training_intake", profession: "nurse", region: "NATIONAL",
    year_range: [2026, 2026], value: 540000, unit: "headcount_rate",
    ci: { lo: 480000, hi: 600000 },
    source_id: srcEdu.id, submitted_by: education, basis: "R2：2026 年沿用原计划"
  }).assumption;
  // R2 情景：2026 沿用、2027-2030 扩招，整条替换旧招生假设，投影单元互不重叠
  const r2Ids = consensusIds.flatMap((id) => (id === aIntakeN.id ? [aIntakeNR2Keep.id, aIntakeNR2.id] : [id]));
  const { scenario: r2scenario } = app.createScenario({
    name: "R2 修订候选：护士扩招",
    description: "基于 R1，2027-2030 护士年招生由 54 万上调至 58 万",
    assumption_ids: r2Ids
  });
  await app.runScenario(r2scenario.id);
  app.bindRevisionScenario(revision.id, r2scenario.id);

  return { app, ids: {
    sources: { hospital: srcHospital.id, primary: srcPrimary.id, edu: srcEdu.id, finance: srcFinance.id, legacy: srcLegacy.id, financeNew: srcFinanceNew.id, edu2027: srcEdu2027.id },
    clarifications: [blocked1.clarification.id, blocked2.clarification.id, blocked3.clarification.id],
    scenario: consensus.id, minorityScenario: minority.id,
    run: runConsensus.id, minorityRun: runMinority.id,
    release: releaseR1.id, revision: revision.id
  }, repro };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { app, ids, repro } = await buildSeed();
  const outFile = process.argv[2] ?? null;
  if (outFile) saveStore(app.store, outFile);
  console.log(JSON.stringify({
    seeded: true,
    assumptions: app.store.assumptions.size,
    clarifications: app.store.clarifications.length,
    scenarios: app.store.scenarios.size,
    runs: app.store.runs.size,
    release: ids.release,
    revision: ids.revision,
    reproduce: repro
  }, null, 2));
}
