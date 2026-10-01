import { loadBaseline } from "./baseline.js";
import { createAssumptionGate } from "./assumptions.js";
import { createScenarioStudio } from "./scenarios.js";
import { createReviewBoard } from "./governance.js";

/**
 * 装配一个内存版应用实例。发布版本内含冻结输入/结果/审批的完整快照，
 * 可整体导出归档；进程重启后用归档快照仍可在 /replay 语义下复现。
 */
export async function createApp(contractPath) {
  const baseline = await loadBaseline(contractPath);
  const gate = createAssumptionGate(baseline);
  const studio = createScenarioStudio({ baseline, gate });
  const board = createReviewBoard({ baseline, gate, studio });
  return { baseline, gate, studio, board };
}

const HOSPITAL = { constituency: "hospital", org: "国家医学中心联合体", contact: "planning@hospitals.example" };
const PRIMARY = { constituency: "primary_care", org: "基层卫生服务网络", contact: "planning@primary.example" };
const EDU = { constituency: "education", org: "医学教育主管部门", contact: "planning@edu.example" };
const FINANCE = { constituency: "finance", org: "财政规划部门", contact: "planning@finance.example" };

/**
 * 演示种子：四方提交全国（CN）医师与护士六个变量的假设；
 * 教育部门最初误以百分数提交完成率（单位冲突）→ 进入澄清 → 更正放行；
 * 另有一条携带身份证字段的提交被隐私红线拒收；
 * 随后组合基准情景、完成四方表决（含一张带少数方案的反对票）、发布 V1，
 * 再以效率提升假设另起修订版 V2。
 */
export async function seedDemo(app) {
  const resolvedApp = app || (await createApp());
  const { gate, studio, board } = resolvedApp;
  const log = [];

  const submit = (input) => {
    const r = gate.submit(input);
    log.push({ event: "submit", id: r.id, variable: r.variable, status: r.status });
    return r;
  };

  // ---- 医师（physicians）----
  const phyStock = submit({
    variable: "stock", workforce: "physicians", region: "CN",
    year_start: 2025, year_end: 2025, point: 4000000,
    ci: { low: 3850000, high: 4150000 }, unit: "persons",
    definition_ref: "执业医师（不含执业助理医师），以年末在岗注册人数计",
    source: { title: "全国卫生健康统计公报 2025", publisher: "国家卫生健康委统计机构", year: 2025 },
    submitter: HOSPITAL,
    note: "不含执业助理医师",
  });
  const phyRetire = submit({
    variable: "retirement_rate", workforce: "physicians", region: "CN",
    year_start: 2026, year_end: 2030, point: 0.025,
    ci: { low: 0.02, high: 0.035 }, unit: "fraction_per_year",
    source: { title: "医师队伍年龄结构与减员测算", publisher: "行业研究机构", year: 2025 },
    submitter: HOSPITAL,
  });
  const phyIntake = submit({
    variable: "training_intake", workforce: "physicians", region: "CN",
    year_start: 2026, year_end: 2030, point: 500000,
    ci: { low: 460000, high: 540000 }, unit: "persons_per_year",
    source: { title: "医学教育与住院医师规范化培训招生计划", publisher: "医学教育主管部门", year: 2026 },
    submitter: EDU,
  });

  // 单位冲突：教育部门误用百分数 55 + 单位 percent，先进入澄清
  const badCompletion = gate.submit({
    variable: "completion_rate", workforce: "physicians", region: "CN",
    year_start: 2026, year_end: 2030, point: 55,
    ci: { low: 50, high: 60 }, unit: "percent",
    source: { title: "医学教育与住院医师规范化培训招生计划", publisher: "医学教育主管部门", year: 2026 },
    submitter: EDU,
    note: "初稿按百分数填报",
  });
  log.push({
    event: "clarification_opened", id: badCompletion.id,
    issues: badCompletion.issues.map((i) => i.code),
  });
  const phyCompletion = gate.resolveClarification(badCompletion.id, "correct", {
    by: EDU,
    replacement: {
      variable: "completion_rate", workforce: "physicians", region: "CN",
      year_start: 2026, year_end: 2030, point: 0.55,
      ci: { low: 0.5, high: 0.62 }, unit: "fraction",
      source: { title: "医学教育与住院医师规范化培训招生计划", publisher: "医学教育主管部门", year: 2026 },
      submitter: EDU,
      note: "已换算为规范单位 fraction（0.55 即 55%）",
    },
  });
  log.push({
    event: "clarification_resolved", id: badCompletion.id,
    replacement_id: phyCompletion.id, action: "correct",
  });

  const phyInflow = submit({
    variable: "net_inflow_rate", workforce: "physicians", region: "CN",
    year_start: 2026, year_end: 2030, point: 0,
    ci: { low: 0, high: 0 }, unit: "fraction_per_year",
    source: { title: "全国医师跨区流动配对台账", publisher: "规划研究组", year: 2025 },
    submitter: PRIMARY,
    note: "全国层面省际调入调出配对轧平",
  });
  const phyEfficiency = submit({
    variable: "efficiency_index", workforce: "physicians", region: "CN",
    year_start: 2026, year_end: 2030, point: 1.0,
    ci: { low: 0.95, high: 1.08 }, unit: "index_2025_1",
    source: { title: "医师服务效率与工时抽样调查", publisher: "财政规划部门委托研究", year: 2025 },
    submitter: FINANCE,
  });

  // ---- 护士（nurses）----
  const nurStock = submit({
    variable: "stock", workforce: "nurses", region: "CN",
    year_start: 2025, year_end: 2025, point: 5400000,
    ci: { low: 5200000, high: 5600000 }, unit: "persons",
    definition_ref: "注册护士，以年末在岗注册人数计",
    source: { title: "全国卫生健康统计公报 2025", publisher: "国家卫生健康委统计机构", year: 2025 },
    submitter: HOSPITAL,
  });
  const nurRetire = submit({
    variable: "retirement_rate", workforce: "nurses", region: "CN",
    year_start: 2026, year_end: 2030, point: 0.03,
    ci: { low: 0.022, high: 0.045 }, unit: "fraction_per_year",
    source: { title: "护士队伍年龄结构与减员测算", publisher: "行业研究机构", year: 2025 },
    submitter: HOSPITAL,
  });
  const nurIntake = submit({
    variable: "training_intake", workforce: "nurses", region: "CN",
    year_start: 2026, year_end: 2030, point: 800000,
    ci: { low: 740000, high: 860000 }, unit: "persons_per_year",
    source: { title: "护理教育招生计划", publisher: "医学教育主管部门", year: 2026 },
    submitter: EDU,
  });
  const nurCompletion = submit({
    variable: "completion_rate", workforce: "nurses", region: "CN",
    year_start: 2026, year_end: 2030, point: 0.7,
    ci: { low: 0.64, high: 0.76 }, unit: "fraction",
    source: { title: "护理教育招生与注册衔接统计", publisher: "医学教育主管部门", year: 2026 },
    submitter: EDU,
  });
  const nurInflow = submit({
    variable: "net_inflow_rate", workforce: "nurses", region: "CN",
    year_start: 2026, year_end: 2030, point: 0,
    ci: { low: 0, high: 0 }, unit: "fraction_per_year",
    source: { title: "全国护士跨区流动配对台账", publisher: "规划研究组", year: 2025 },
    submitter: PRIMARY,
  });
  const nurEfficiency = submit({
    variable: "efficiency_index", workforce: "nurses", region: "CN",
    year_start: 2026, year_end: 2030, point: 1.02,
    ci: { low: 0.96, high: 1.09 }, unit: "index_2025_1",
    source: { title: "护理服务效率与床位比抽样调查", publisher: "财政规划部门委托研究", year: 2025 },
    submitter: FINANCE,
  });

  // ---- 隐私红线演示：夹带身份证字段的提交必须被拒收 ----
  let privacyBlocked = null;
  try {
    gate.submit({
      variable: "stock", workforce: "physicians", region: "CN",
      year_start: 2025, year_end: 2025, point: 1,
      ci: { low: 1, high: 2 }, unit: "persons",
      source: { title: "违规的个人花名册", publisher: "某机构", year: 2025 },
      submitter: HOSPITAL,
      id_card: "110101199003071234",
      staff_name: "张三",
    });
  } catch (error) {
    privacyBlocked = { code: error.code, hits: error.hits };
    log.push({ event: "privacy_blocked", hits: error.hits?.map((h) => h.path) });
  }

  // ---- 引用过期演示：2020 年旧数据不能直接进入兼容集 ----
  const expired = gate.submit({
    variable: "retirement_rate", workforce: "physicians", region: "CN-BJ",
    year_start: 2026, year_end: 2030, point: 0.02,
    ci: { low: 0.01, high: 0.03 }, unit: "fraction_per_year",
    source: { title: "某地旧五年规划附表", publisher: "某省卫生部门", year: 2020 },
    submitter: PRIMARY,
  });
  log.push({ event: "clarification_opened", id: expired.id, issues: expired.issues.map((i) => i.code) });

  // ---- 候选情景 V1（基准）----
  const baseIds = [
    phyStock, phyRetire, phyIntake, phyCompletion, phyInflow, phyEfficiency,
    nurStock, nurRetire, nurIntake, nurCompletion, nurInflow, nurEfficiency,
  ].map((a) => a.id);
  const scenarioV1 = studio.compose({
    name: "2030 基准情景（现行政策延续）",
    assumption_ids: baseIds,
    author: { name: "规划研究组", at: "research@planning.example" },
    note: "各变量取点估计；医师在基准假设下达标存在缺口",
  });

  // ---- 评审员：四方各一人，先披露利益关系 ----
  const reviewerDefs = [
    { name: "林院长", constituency: "hospital", interests: ["所在医院承担规培基地任务"] },
    { name: "白主任", constituency: "primary_care", interests: [] },
    { name: "宋处长", constituency: "education", interests: ["配偶任职于医学院校"] },
    { name: "钱处长", constituency: "finance", interests: ["参与财政投入测算课题"] },
  ];
  const reviewers = reviewerDefs.map((d) => {
    const r = board.registerReviewer({ name: d.name, constituency: d.constituency });
    board.discloseInterests(r.id, d.interests);
    return r;
  });

  const reviewV1 = board.openReview({
    scenario_id: scenarioV1.id,
    title: "2030 医护供给基准情景审议",
    opened_by: "规划研究组",
  });
  // 三方赞成；财政方反对并附理由与少数方案
  board.castVote(reviewV1.id, { reviewer_id: reviewers[0].id, vote: "approve" });
  board.castVote(reviewV1.id, { reviewer_id: reviewers[1].id, vote: "approve" });
  board.castVote(reviewV1.id, { reviewer_id: reviewers[2].id, vote: "approve" });
  board.castVote(reviewV1.id, {
    reviewer_id: reviewers[3].id,
    vote: "oppose",
    reason: "基准情景低估了薪酬与数字化改革带来的效率提升，医师缺口被夸大，可能导致财政过度投入培训扩容。",
    minority_proposal: {
      name: "效率提升情景",
      rationale: "若绩效与数字化投入按现节奏推进，2030 年医师效率指数可升至 1.08，应以效率假设上界重算达标缺口。",
      assumption_ids: [phyEfficiency.id],
    },
  });
  board.closeReview(reviewV1.id);
  const releaseV1 = await board.publish(reviewV1.id, {
    published_by: "规划研究组",
    notes: "基准情景正式发布；财政方反对意见及少数方案随版本保存",
  });

  // ---- 修订版 V2：采纳效率提升少数方案，新数据另起修订版 ----
  const phyEfficiencyV2 = submit({
    variable: "efficiency_index", workforce: "physicians", region: "CN",
    year_start: 2026, year_end: 2030, point: 1.08,
    ci: { low: 1.02, high: 1.12 }, unit: "index_2025_1",
    source: { title: "绩效改革与数字化效率跟踪 2026 中期评估", publisher: "财政规划部门委托研究", year: 2026 },
    submitter: FINANCE,
    note: "V1 少数方案获得新一轮中期数据支持，作为修订输入",
  });
  const v2Ids = baseIds.map((id) => (id === phyEfficiency.id ? phyEfficiencyV2.id : id));
  const scenarioV2 = studio.compose({
    name: "2030 效率提升情景（V1 修订版）",
    assumption_ids: v2Ids,
    author: { name: "规划研究组", at: "research@planning.example" },
    note: "仅替换医师效率指数假设，其余输入冻结沿用 V1",
  });
  const reviewV2 = board.openReview({
    scenario_id: scenarioV2.id,
    title: "2030 效率提升情景审议",
    revision_of_release: releaseV1.id,
    opened_by: "规划研究组",
  });
  for (let i = 0; i < reviewers.length; i++) {
    board.castVote(reviewV2.id, {
      reviewer_id: reviewers[i].id,
      vote: "approve",
      ...(i === 3 ? { reason: "中期数据支持效率上界，撤回 V1 反对立场" } : {}),
    });
  }
  board.closeReview(reviewV2.id);
  const releaseV2 = await board.publish(reviewV2.id, {
    published_by: "规划研究组",
    notes: "基于 2026 中期数据的修订版；V1 保持不可变",
  });

  const replayV1 = await board.replay(releaseV1.id);

  return {
    log,
    ids: {
      assumptions: {
        phyStock: phyStock.id, badCompletion: badCompletion.id, phyCompletion: phyCompletion.id,
        expired: expired.id, phyEfficiency: phyEfficiency.id, phyEfficiencyV2: phyEfficiencyV2.id,
      },
      scenarios: { v1: scenarioV1.id, v2: scenarioV2.id },
      reviews: { v1: reviewV1.id, v2: reviewV2.id },
      releases: { v1: releaseV1.id, v2: releaseV2.id },
      reviewers: Object.fromEntries(reviewers.map((r, i) => [["hospital", "primary_care", "education", "finance"][i], r.id])),
    },
    privacyBlocked,
    releases: { v1: releaseV1.version, v2: releaseV2.version },
    replayV1: { fully_reproducible: replayV1.fully_reproducible, result_fingerprint_matches: replayV1.result_fingerprint.matches },
    outcomes: {
      v1: {
        physicians: releaseV1.frozen_results.physicians.meets_target,
        nurses: releaseV1.frozen_results.nurses.meets_target,
      },
      v2: {
        physicians: releaseV2.frozen_results.physicians.meets_target,
        nurses: releaseV2.frozen_results.nurses.meets_target,
      },
    },
  };
}
