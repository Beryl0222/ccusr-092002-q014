import { buildInputSnapshot, programFingerprint } from "./model.js";
import { newId, recordEvent } from "./store.js";

/**
 * 评审治理：先披露利益关系、后表决；发布时冻结输入快照、计算程序指纹与审批记录；
 * 新数据不得改写已发布版本，只能另起修订版。异议与少数方案随版本永久保存。
 */

export function registerReviewer(store, input) {
  if (!input.id || !input.name || !input.org_type) throw new Error("评审成员需提供 id/name/org_type");
  const reviewer = {
    id: input.id,
    name: input.name,
    org_type: input.org_type,
    registered_at: new Date().toISOString()
  };
  store.reviewers.set(reviewer.id, reviewer);
  recordEvent(store, "reviewer_registered", { reviewer_id: reviewer.id });
  return reviewer;
}

/** 披露利益关系；披露内容随发布记录归档。未披露者的表决一律拒绝。 */
export function discloseInterest(store, input, now = new Date()) {
  const reviewer = store.reviewers.get(input.reviewer_id);
  if (!reviewer) throw new Error("评审成员不存在");
  const disclosure = {
    reviewer_id: input.reviewer_id,
    has_interest: Boolean(input.has_interest),
    interests: input.has_interest ? input.interests ?? [] : [],
    mitigation: input.mitigation ?? (input.has_interest ? "未声明回避安排" : ""),
    recuse: input.has_interest && input.recuse === true,
    declared_at: new Date(now).toISOString()
  };
  store.disclosures.set(input.reviewer_id, disclosure);
  recordEvent(store, "interest_disclosed", { reviewer_id: input.reviewer_id, has_interest: disclosure.has_interest, recuse: disclosure.recuse });
  return disclosure;
}

/**
 * 发起发布提案：锁定一个已运行情景的输入快照。提案发起后，底层假设即使被替代，
 * 提案仍引用当时快照。
 */
export async function proposeRelease(store, baseline, input, now = new Date()) {
  const run = store.runs.get(input.run_id);
  if (!run) throw new Error("运行不存在");
  const scenario = store.scenarios.get(run.scenario_id);
  if (!scenario) throw new Error("情景不存在");
  const snapshot = buildInputSnapshot(store, baseline, scenario.assumption_ids);

  const proposal = {
    id: newId(store, "REL"),
    run_id: run.id,
    scenario_id: scenario.id,
    version_label: input.version_label ?? "R1",
    based_on_release_id: input.based_on_release_id ?? null,
    status: "voting",
    opened_at: new Date(now).toISOString(),
    quorum: input.quorum ?? 3,
    threshold: input.threshold ?? 0.6,
    frozen_input: snapshot,
    input_fingerprint: snapshot.fingerprint,
    program_fingerprint: run.program_fingerprint,
    engine_version: run.engine_version,
    projection_summary: run.projection.conclusion,
    conclusion_changers: run.conclusion_changers,
    dissents: scenario.dissents,
    votes: [],
    approval: null
  };
  store.release_proposals.set(proposal.id, proposal);
  store.votes.set(proposal.id, []);
  recordEvent(store, "release_proposed", { release_id: proposal.id, run_id: run.id });
  return proposal;
}

/** 表决：必须已披露；披露利益且声明回避者不得投票；赞成比例达标且满足法定人数即通过。 */
export function castVote(store, releaseId, input, now = new Date()) {
  const proposal = store.release_proposals.get(releaseId);
  if (!proposal) throw new Error("发布提案不存在");
  if (proposal.status !== "voting") throw new Error("提案已结束表决");
  const reviewer = store.reviewers.get(input.reviewer_id);
  if (!reviewer) throw new Error("评审成员不存在");

  const disclosure = store.disclosures.get(input.reviewer_id);
  if (!disclosure) {
    const error = new Error("尚未披露利益关系，不能表决");
    error.code = "DISCLOSURE_REQUIRED";
    throw error;
  }
  if (disclosure.recuse) {
    const error = new Error("已声明回避，不能参与表决");
    error.code = "RECUSED";
    throw error;
  }
  const votes = store.votes.get(releaseId);
  if (votes.some((v) => v.reviewer_id === input.reviewer_id)) throw new Error("不得重复表决");
  if (!["approve", "reject", "abstain"].includes(input.position)) throw new Error("position 必须是 approve/reject/abstain");

  const vote = {
    reviewer_id: input.reviewer_id,
    org_type: reviewer.org_type,
    position: input.position,
    comment: input.comment ?? "",
    cast_at: new Date(now).toISOString(),
    disclosure_snapshot: { has_interest: disclosure.has_interest, interests: disclosure.interests, mitigation: disclosure.mitigation }
  };
  votes.push(vote);
  proposal.votes = votes;
  recordEvent(store, "vote_cast", { release_id: releaseId, reviewer_id: input.reviewer_id, position: input.position });

  const eligible = [...store.reviewers.keys()].filter((id) => {
    const d = store.disclosures.get(id);
    return d && !d.recuse;
  });
  const returned = votes.length;
  const approve = votes.filter((v) => v.position === "approve").length;
  return currentTally(proposal, { eligible: eligible.length, returned, approve });
}

export function currentTally(proposal, counts) {
  const counts0 = counts ?? {
    returned: proposal.votes.length,
    approve: proposal.votes.filter((v) => v.position === "approve").length
  };
  const quorumMet = counts0.returned >= proposal.quorum;
  const ratio = counts0.returned === 0 ? 0 : counts0.approve / counts0.returned;
  // 投票期不因达法定人数而提前关闭：异议票必须有机会入册。状态仅作可否发布的判定。
  const decision = !quorumMet ? "pending" : ratio >= proposal.threshold ? "approvable" : "below_threshold";
  return { status: proposal.status, tally_status: decision, counts: counts0, ratio: Math.round(ratio * 1000) / 1000, threshold: proposal.threshold, quorum: proposal.quorum };
}

/**
 * 冻结发布：仅已通过提案可发布。发布即不可变——输入、程序指纹、审批记录、异议全部封存。
 */
export async function publishRelease(store, releaseId, now = new Date()) {
  const proposal = store.release_proposals.get(releaseId);
  if (!proposal) throw new Error("发布提案不存在");
  if (proposal.status !== "voting") throw new Error(`提案状态为 ${proposal.status}，不能发布`);

  const votes = proposal.votes;
  if (votes.length < proposal.quorum) throw new Error(`未达法定人数：已投 ${votes.length}，需 ${proposal.quorum}`);
  const approve = votes.filter((v) => v.position === "approve").length;
  const ratio = approve / votes.length;
  if (ratio < proposal.threshold) {
    const error = new Error(`赞成比例 ${(ratio * 100).toFixed(1)}% 低于 ${(proposal.threshold * 100).toFixed(0)}% 阈值，不能发布`);
    error.code = "VOTE_FAILED";
    throw error;
  }

  const prog = await programFingerprint();
  const run = store.runs.get(proposal.run_id);
  const release = {
    id: proposal.id,
    version_label: proposal.version_label,
    based_on_release_id: proposal.based_on_release_id,
    published_at: new Date(now).toISOString(),
    status: "frozen",
    scenario_id: proposal.scenario_id,
    run_id: proposal.run_id,
    engine_version: proposal.engine_version,
    frozen_input: proposal.frozen_input,
    input_fingerprint: proposal.input_fingerprint,
    program_fingerprint: proposal.program_fingerprint,
    program_fingerprint_at_review: proposal.program_fingerprint,
    program_fingerprint_current: prog.fingerprint,
    program_unchanged: prog.fingerprint === proposal.program_fingerprint,
    projection: run.projection,
    conclusion_changers: proposal.conclusion_changers,
    approval: {
      votes: proposal.votes,
      quorum: proposal.quorum,
      threshold: proposal.threshold,
      approved_at: new Date(now).toISOString()
    },
    dissents: proposal.dissents,
    revisions: []
  };
  proposal.status = "published";
  store.releases.set(release.id, release);
  recordEvent(store, "release_published", {
    release_id: release.id,
    version_label: release.version_label,
    input_fingerprint: release.input_fingerprint,
    program_fingerprint: release.program_fingerprint
  });
  return release;
}

/**
 * 修订版：基于已冻结版本派生，携带新数据/新假设；修订版是独立候选，必须重新表决发布。
 */
export function openRevision(store, parentReleaseId, input, now = new Date()) {
  const parent = store.releases.get(parentReleaseId);
  if (!parent || parent.status !== "frozen") throw new Error("只能基于已冻结发布开立修订版");
  const revision = {
    id: newId(store, "REV"),
    parent_release_id: parent.id,
    parent_version_label: parent.version_label,
    reason: input.reason ?? "",
    new_sources: input.new_sources ?? [],
    new_assumption_ids: input.new_assumption_ids ?? [],
    opened_at: new Date(now).toISOString(),
    status: "draft",
    new_scenario_id: null
  };
  parent.revisions.push(revision.id);
  store.revisions.set(revision.id, revision);
  recordEvent(store, "revision_opened", { revision_id: revision.id, parent_release_id: parent.id });
  return revision;
}

export function bindRevisionScenario(store, revisionId, scenarioId, now = new Date()) {
  const revision = store.revisions.get(revisionId);
  if (!revision) throw new Error("修订草案不存在");
  revision.new_scenario_id = scenarioId;
  revision.status = "ready_for_review";
  recordEvent(store, "revision_bound", { revision_id: revisionId, scenario_id: scenarioId, at: new Date(now).toISOString() });
  return revision;
}
