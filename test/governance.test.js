import assert from "node:assert/strict";
import test from "node:test";

import { loadBaseline } from "../src/baseline.js";
import { createAssumptionGate } from "../src/assumptions.js";
import { createScenarioStudio } from "../src/scenarios.js";
import { createReviewBoard } from "../src/governance.js";
import { submitFullSet } from "./helpers.js";

async function freshBoard() {
  const baseline = await loadBaseline();
  const gate = createAssumptionGate(baseline);
  const studio = createScenarioStudio({ baseline, gate });
  const board = createReviewBoard({ baseline, gate, studio });
  return { baseline, gate, studio, board };
}

async function prepareScenario(board, studio, gate, name = "待审议情景") {
  const phy = submitFullSet(gate, { workforce: "physicians", stock: 4000000 });
  const nur = submitFullSet(gate, { workforce: "nurses", stock: 5500000 });
  return studio.compose({ name, assumption_ids: [...phy, ...nur] });
}

function fourReviewers(board) {
  return ["hospital", "primary_care", "education", "finance"].map((constituency, i) => {
    const r = board.registerReviewer({ name: `评审${i}`, constituency });
    board.discloseInterests(r.id, i === 0 ? ["规培基地任职"] : []);
    return r;
  });
}

test("未披露利益关系不能投票", async () => {
  const { board, studio, gate } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const r = board.registerReviewer({ name: "未披露者", constituency: "finance" });
  const review = board.openReview({ scenario_id: scenario.id });
  assert.throws(
    () => board.castVote(review.id, { reviewer_id: r.id, vote: "approve" }),
    (e) => e.code === "DISCLOSURE_REQUIRED",
  );
});

test("反对票必须附理由", async () => {
  const { board, studio, gate } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const [r] = fourReviewers(board);
  const review = board.openReview({ scenario_id: scenario.id });
  assert.throws(
    () => board.castVote(review.id, { reviewer_id: r.id, vote: "oppose" }),
    (e) => e.code === "REASON_REQUIRED",
  );
});

test("不兼容情景不能进入表决", async () => {
  const { board, gate, studio } = await freshBoard();
  const ids = submitFullSet(gate).slice(0, 3); // 覆盖不齐
  const scenario = studio.compose({ name: "残缺", assumption_ids: ids });
  assert.throws(
    () => board.openReview({ scenario_id: scenario.id }),
    (e) => e.code === "SCENARIO_INCOMPATIBLE",
  );
});

test("法定人数不足：四方缺席一方则否决且不能发布", async () => {
  const { board, studio, gate } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const reviewers = fourReviewers(board);
  const review = board.openReview({ scenario_id: scenario.id });
  for (const r of reviewers.slice(0, 3)) {
    board.castVote(review.id, { reviewer_id: r.id, vote: "approve" });
  }
  const closed = board.closeReview(review.id);
  assert.equal(closed.result, "rejected_no_quorum");
  assert.deepEqual(closed.tally.missing_constituencies, ["finance"]);
  await assert.rejects(
    () => board.publish(review.id),
    (e) => e.code === "NOT_APPROVED",
  );
});

test("完整审议与发布：冻结输入、程序指纹、审批记录", async () => {
  const { board, studio, gate } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const reviewers = fourReviewers(board);
  const review = board.openReview({ scenario_id: scenario.id, title: "正式审议" });
  for (const r of reviewers.slice(0, 3)) {
    board.castVote(review.id, { reviewer_id: r.id, vote: "approve" });
  }
  board.castVote(review.id, {
    reviewer_id: reviewers[3].id,
    vote: "oppose",
    reason: "效率假设过于保守",
    minority_proposal: { name: "效率替代方案", rationale: "效率指数 1.08", assumption_ids: [] },
  });
  board.closeReview(review.id);
  const release = await board.publish(review.id, { published_by: "研究组" });

  assert.equal(release.status, "published");
  assert.equal(release.immutable, true);
  assert.equal(release.version, "V1");
  assert.ok(release.frozen_inputs.assumptions.length === 12);
  assert.match(release.program.program_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(release.review.tally.approve, 3);
  assert.equal(release.dissents.length, 1);
  assert.equal(release.dissents[0].reason, "效率假设过于保守");
  assert.equal(release.minority_proposals[0].name, "效率替代方案");
  assert.match(release.release_fingerprint, /^[0-9a-f]{64}$/);
});

test("平票不算通过；重复投票被拒绝", async () => {
  const { board, studio, gate } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const reviewers = fourReviewers(board);
  const review = board.openReview({ scenario_id: scenario.id });
  board.castVote(review.id, { reviewer_id: reviewers[0].id, vote: "approve" });
  board.castVote(review.id, { reviewer_id: reviewers[1].id, vote: "approve" });
  board.castVote(review.id, { reviewer_id: reviewers[2].id, vote: "oppose", reason: "r1" });
  board.castVote(review.id, { reviewer_id: reviewers[3].id, vote: "oppose", reason: "r2" });
  assert.throws(
    () => board.castVote(review.id, { reviewer_id: reviewers[0].id, vote: "approve" }),
    (e) => e.code === "ALREADY_VOTED",
  );
  const closed = board.closeReview(review.id);
  assert.equal(closed.result, "rejected");
});

test("冻结快照可复现：相同输入与程序指纹重算结果一致", async () => {
  const { board, studio, gate } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const reviewers = fourReviewers(board);
  const review = board.openReview({ scenario_id: scenario.id });
  for (const r of reviewers) board.castVote(review.id, { reviewer_id: r.id, vote: "approve" });
  board.closeReview(review.id);
  const release = await board.publish(review.id);

  const report = await board.replay(release.id);
  assert.equal(report.inputs_intact, true);
  assert.equal(report.program_fingerprint.matches, true);
  assert.equal(report.result_fingerprint.matches, true);
  assert.equal(report.fully_reproducible, true);
});

test("库外篡改冻结归档：复现可识别，且归档禁止导入", async () => {
  const { board, studio, gate } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const reviewers = fourReviewers(board);
  const review = board.openReview({ scenario_id: scenario.id });
  for (const r of reviewers) board.castVote(review.id, { reviewer_id: r.id, vote: "approve" });
  board.closeReview(review.id);
  const release = await board.publish(review.id);

  // 导出不可变归档，模拟库外篡改一个假设点值（不更新内容指纹）
  const archive = board.exportRelease(release.id);
  const target = archive.frozen_inputs.assumptions.find((a) => a.variable === "retirement_rate");
  target.point = 0.9;
  const report = await board.replayArchive(archive);
  assert.equal(report.inputs_intact, false);
  assert.ok(report.tampered_slots.includes(target.id));
  assert.equal(report.fully_reproducible, false);

  // 篡改归档的发布指纹失效，拒绝导入
  assert.throws(
    () => board.importRelease(archive),
    (e) => e.code === "ARCHIVE_TAMPERED",
  );
});

test("未篡改的归档可导入新库并继续形成修订链", async () => {
  const first = await freshBoard();
  const scenario = await prepareScenario(first.board, first.studio, first.gate);
  const reviewers = fourReviewers(first.board);
  const review = first.board.openReview({ scenario_id: scenario.id });
  for (const r of reviewers) first.board.castVote(review.id, { reviewer_id: r.id, vote: "approve" });
  first.board.closeReview(review.id);
  const release = await first.board.publish(review.id);
  const archive = first.board.exportRelease(release.id);

  const second = await freshBoard();
  const imported = second.board.importRelease(archive);
  assert.equal(imported.version, "V1");
  const replay = await second.board.replay(imported.id);
  assert.equal(replay.fully_reproducible, true);
});

test("修订链：新数据另起修订版，V1 保持不可变", async () => {
  const { board, studio, gate } = await freshBoard();
  const phy = submitFullSet(gate, { workforce: "physicians", stock: 4000000 });
  const nur = submitFullSet(gate, { workforce: "nurses", stock: 5500000 });
  const s1 = studio.compose({ name: "V1 情景", assumption_ids: [...phy, ...nur] });
  const reviewers = fourReviewers(board);

  const rv1 = board.openReview({ scenario_id: s1.id });
  for (const r of reviewers) board.castVote(rv1.id, { reviewer_id: r.id, vote: "approve" });
  board.closeReview(rv1.id);
  const v1 = await board.publish(rv1.id);

  // V2：替换医师效率假设
  const oldEff = gate.list({ workforce: "physicians" }).find((a) => a.variable === "efficiency_index").id;
  const newEff = gate.submit({
    ...gate.get(oldEff),
    point: 1.08,
    ci: { low: 1.02, high: 1.12 },
    source: { title: "中期评估", publisher: "财政委托研究", year: 2026 },
    note: "新数据",
  });
  assert.equal(newEff.status, "active");
  const s2 = studio.compose({
    name: "V2 情景",
    assumption_ids: [...phy.filter((id) => id !== oldEff), ...nur, newEff.id],
  });
  const rv2 = board.openReview({ scenario_id: s2.id, revision_of_release: v1.id });
  for (const r of reviewers) board.castVote(rv2.id, { reviewer_id: r.id, vote: "approve" });
  board.closeReview(rv2.id);
  const v2 = await board.publish(rv2.id);

  assert.equal(v2.version, "V2");
  assert.equal(v2.revision_of, v1.id);
  assert.deepEqual(v2.revision_chain, [v1.id]);
  // V1 结果未被改动
  assert.equal(board.getRelease(v1.id).frozen_results.physicians.efficiency_index, 1);
  assert.notEqual(
    v1.frozen_results.physicians.effective_capacity_2030,
    v2.frozen_results.physicians.effective_capacity_2030,
  );
});

test("指标视图：假设链、敏感性翻转、异议与替代情景齐备", async () => {
  const { board, studio, gate, baseline } = await freshBoard();
  const scenario = await prepareScenario(board, studio, gate);
  const reviewers = fourReviewers(board);
  const review = board.openReview({ scenario_id: scenario.id });
  for (const r of reviewers.slice(0, 3)) {
    board.castVote(review.id, { reviewer_id: r.id, vote: "approve" });
  }
  board.castVote(review.id, {
    reviewer_id: reviewers[3].id, vote: "oppose", reason: "护士缺口测算可疑",
    minority_proposal: { name: "护理扩容替代", rationale: "提高培训入口", assumption_ids: [] },
  });
  board.closeReview(review.id);
  const release = await board.publish(review.id);

  const view = board.metricView(release.id, "nurses_2030");
  assert.equal(view.target.value, baseline.national_targets.nurses.value);
  assert.equal(view.assumption_chain.length, 6);
  for (const link of view.assumption_chain) {
    assert.ok(link.source.title, "假设链保留来源");
    assert.ok(link.content_fingerprint, "假设链保留内容指纹");
    assert.equal(link.applicable_years.length, 2);
  }
  assert.ok(view.sensitivity.tornado.length === 6);
  assert.equal(view.minority_proposals[0].name, "护理扩容替代");
  assert.equal(view.privacy_notice.includes("个人医护档案"), true);
  assert.ok(view.reproducibility.program_fingerprint);
});
