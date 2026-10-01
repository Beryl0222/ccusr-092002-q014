import { clone, fingerprint, newId } from "./util.js";
import { programFingerprint, ENGINE_VERSION } from "./program.js";
import { assumptionContentFingerprint } from "./assumptions.js";
import { serializeScenario } from "./scenarios.js";

/**
 * 审议治理与发布冻结：
 *  - 评审成员登记并披露利益关系后才能投票；
 *  - 四方法定人数 + 投票多数决；反对票必须附理由；少数方案随版本永久保存；
 *  - 发布即冻结输入快照、计算程序指纹与审批记录；已发布版本不可变；
 *  - 新数据、新假设只能另起修订版，修订链可追溯；
 *  - 任一指标都能回溯假设链、未解决分歧、替代情景，并在相同快照上复现。
 */

const VOTES = new Set(["approve", "oppose", "abstain"]);

export function createReviewBoard({ baseline, gate, studio, programFingerprintFn = programFingerprint }) {
  const reviewers = new Map();
  const reviews = new Map();
  /** @type {Map<string, any>} */
  const releases = new Map();
  let releaseCounter = 0;

  function registerReviewer({ name, constituency }) {
    if (!baseline.governance_policy.constituencies.includes(constituency)) {
      throw Object.assign(new Error(`未知评审方 ${constituency}`), { code: "VALIDATION_ERROR" });
    }
    if (!name) throw Object.assign(new Error("评审员姓名缺失"), { code: "VALIDATION_ERROR" });
    const reviewer = {
      id: newId("REV"),
      name,
      constituency,
      disclosures: [],
      disclosed_at: null,
      registered_at: new Date().toISOString(),
    };
    reviewers.set(reviewer.id, reviewer);
    return clone(reviewer);
  }

  function discloseInterests(reviewerId, interests, at = new Date().toISOString()) {
    const reviewer = requireReviewer(reviewerId);
    const entries = (interests || []).map((text) => String(text));
    reviewer.disclosures.push(...entries);
    reviewer.disclosed_at = reviewer.disclosed_at || at;
    return clone({
      id: reviewer.id,
      disclosed: true,
      disclosed_at: reviewer.disclosed_at,
      interests: reviewer.disclosures,
    });
  }

  function openReview({ scenario_id, title, revision_of_release = null, opened_by = null }) {
    const scenario = studio.get(scenario_id);
    if (!scenario.compatibility.compatible) {
      throw Object.assign(new Error("情景尚未通过兼容性检查，不能进入表决"), {
        code: "SCENARIO_INCOMPATIBLE",
        errors: scenario.compatibility.errors,
      });
    }
    if (revision_of_release) {
      const prev = releases.get(revision_of_release);
      if (!prev || prev.status !== "published") {
        throw Object.assign(new Error("修订基线必须是已发布版本"), { code: "NOT_FOUND" });
      }
    }
    const review = {
      id: newId("RVW"),
      title: title || `情景 ${scenario.name} 审议`,
      scenario_id,
      scenario_name: scenario.name,
      revision_of_release,
      status: "open",
      opened_by,
      opened_at: new Date().toISOString(),
      closed_at: null,
      votes: [], // {reviewer_id, name, constituency, vote, reason, minority_proposal, ballot_at}
      tally: null,
      result: null,
    };
    reviews.set(review.id, review);
    return clone(review);
  }

  function castVote(reviewId, ballot) {
    const review = requireOpenReview(reviewId);
    const reviewer = requireReviewer(ballot.reviewer_id);
    if (!reviewer.disclosed_at) {
      throw Object.assign(
        new Error("评审成员须先披露利益关系才能表决"),
        { code: "DISCLOSURE_REQUIRED", reviewer_id: reviewer.id },
      );
    }
    if (!VOTES.has(ballot.vote)) {
      throw Object.assign(new Error("vote 必须是 approve / oppose / abstain"), { code: "VALIDATION_ERROR" });
    }
    if (review.votes.some((v) => v.reviewer_id === reviewer.id)) {
      throw Object.assign(new Error("评审成员只能投票一次"), { code: "ALREADY_VOTED" });
    }
    let reason = ballot.reason ?? null;
    if (ballot.vote === "oppose" && !reason) {
      throw Object.assign(new Error("反对票必须附理由，异议将随版本保存"), { code: "REASON_REQUIRED" });
    }
    let minorityProposal = null;
    if (ballot.minority_proposal) {
      const mp = ballot.minority_proposal;
      if (!mp.name || !mp.rationale) {
        throw Object.assign(new Error("少数方案须包含 name 与 rationale"), { code: "VALIDATION_ERROR" });
      }
      minorityProposal = {
        id: newId("MIN"),
        name: mp.name,
        rationale: mp.rationale,
        assumption_ids: mp.assumption_ids ? [...mp.assumption_ids] : [],
        proposed_by: reviewer.id,
      };
    }
    review.votes.push({
      reviewer_id: reviewer.id,
      name: reviewer.name,
      constituency: reviewer.constituency,
      vote: ballot.vote,
      reason,
      minority_proposal: minorityProposal,
      disclosed_interests: [...reviewer.disclosures],
      ballot_at: new Date().toISOString(),
    });
    return clone(review);
  }

  function closeReview(reviewId) {
    const review = requireOpenReview(reviewId);
    const policy = baseline.governance_policy.voting;
    const byConstituency = new Map(policy.constituency_quorum.map((c) => [c, 0]));
    for (const v of review.votes) byConstituency.set(v.constituency, (byConstituency.get(v.constituency) || 0) + 1);
    const missingConstituencies = [...byConstituency].filter(([, n]) => n === 0).map(([c]) => c);

    const approve = review.votes.filter((v) => v.vote === "approve").length;
    const oppose = review.votes.filter((v) => v.vote === "oppose").length;
    const abstain = review.votes.filter((v) => v.vote === "abstain").length;
    const cast = approve + oppose;
    const quorum =
      review.votes.length >= policy.min_participants && missingConstituencies.length === 0;

    review.tally = {
      ballots: review.votes.length,
      approve,
      oppose,
      abstain,
      votes_cast: cast,
      constituencies_present: [...byConstituency.keys()].filter((c) => byConstituency.get(c) > 0),
      missing_constituencies: missingConstituencies,
      quorum,
    };
    review.closed_at = new Date().toISOString();
    review.status = "closed";
    review.result = !quorum
      ? "rejected_no_quorum"
      : approve > cast / 2
        ? "approved"
        : "rejected";
    return clone(review);
  }

  async function publish(reviewId, { published_by = null, notes = null } = {}) {
    const review = reviews.get(reviewId);
    if (!review) throw Object.assign(new Error(`审议 ${reviewId} 不存在`), { code: "NOT_FOUND" });
    if (review.status !== "closed") {
      throw Object.assign(new Error("审议尚未结束，不能发布"), { code: "REVIEW_OPEN" });
    }
    if (review.result !== "approved") {
      throw Object.assign(new Error(`审议结果为 ${review.result}，不能发布`), { code: "NOT_APPROVED" });
    }
    const scenario = studio.get(review.scenario_id);

    const prev = review.revision_of_release ? releases.get(review.revision_of_release) : null;
    releaseCounter += 1;
    const id = newId("REL");
    const frozenScenario = clone(scenario);
    const frozenInputs = {
      serialized: serializeScenario(scenario),
      input_fingerprint: scenario.input_fingerprint,
      assumptions: clone(scenario.assumptions),
    };
    const chain = prev ? [...prev.revision_chain, prev.id] : [];
    const release = {
      id,
      release_no: releaseCounter,
      version: `V${releaseCounter}`,
      status: "published",
      published_at: new Date().toISOString(),
      published_by,
      notes,
      immutable: true,
      baseline: {
        baseline_id: baseline.baseline_id,
        contract_fingerprint: baseline.contract_fingerprint,
      },
      scenario: {
        id: scenario.id,
        name: scenario.name,
        scope: scenario.scope,
        regions: scenario.regions,
        workforces: scenario.workforces,
        input_fingerprint: scenario.input_fingerprint,
        result_fingerprint: scenario.result_fingerprint,
      },
      frozen_scenario: frozenScenario,
      frozen_inputs: frozenInputs,
      frozen_results: clone(scenario.results),
      frozen_sensitivity: clone(scenario.sensitivity),
      program: {
        engine_version: ENGINE_VERSION,
        program_fingerprint: await programFingerprintFn(),
      },
      review: {
        id: review.id,
        title: review.title,
        opened_at: review.opened_at,
        closed_at: review.closed_at,
        tally: clone(review.tally),
        votes: clone(review.votes),
      },
      dissents: review.votes
        .filter((v) => v.vote === "oppose")
        .map((v) => ({
          reviewer_id: v.reviewer_id,
          name: v.name,
          constituency: v.constituency,
          reason: v.reason,
        })),
      minority_proposals: review.votes
        .filter((v) => v.minority_proposal)
        .map((v) => ({ ...clone(v.minority_proposal), reviewer_id: v.reviewer_id, name_reviewer: v.name })),
      revision_of: prev ? prev.id : null,
      revision_chain: chain,
    };
    release.release_fingerprint = fingerprint({
      version: release.version,
      baseline: release.baseline,
      scenario: release.scenario,
      program: release.program,
      review_id: release.review.id,
      revision_of: release.revision_of,
      frozen_inputs_fingerprint: release.frozen_inputs.input_fingerprint,
      result_fingerprint: scenario.result_fingerprint,
    });
    releases.set(id, release);
    return releaseView(release);
  }

  /** 在冻结快照上复现：校验输入未被篡改，并用当前程序重算，比对结果指纹。 */
  async function replay(releaseId) {
    return replayArchive(requireRelease(releaseId));
  }

  /** 对任意外部归档快照执行复现核验，无需先导入版本库。 */
  async function replayArchive(release) {
    const tampered = [];
    for (const a of release.frozen_inputs.assumptions) {
      if (assumptionContentFingerprint(a) !== a.content_fingerprint) {
        tampered.push(a.id);
      }
    }
    const serializedFingerprint = fingerprint(release.frozen_inputs.serialized);
    if (serializedFingerprint !== release.frozen_inputs.input_fingerprint) {
      tampered.push("__serialized_inputs__");
    }
    const currentProgram = await programFingerprintFn();
    const replayOut = studio.replay(release.frozen_scenario);
    return {
      release_id: release.id,
      version: release.version,
      inputs_intact: tampered.length === 0,
      tampered_slots: tampered,
      program_fingerprint: {
        frozen: release.program.program_fingerprint,
        current: currentProgram,
        matches: currentProgram === release.program.program_fingerprint,
      },
      engine_version: { frozen: release.program.engine_version, current: ENGINE_VERSION },
      computation: replayOut,
      result_fingerprint: {
        frozen: release.scenario.result_fingerprint,
        reproduced: replayOut.result_fingerprint,
        matches: replayOut.result_fingerprint === release.scenario.result_fingerprint,
      },
      fully_reproducible:
        tampered.length === 0 &&
        currentProgram === release.program.program_fingerprint &&
        replayOut.reproduced,
    };
  }

  /** 决策者指标视图：指标值 → 假设链 → 未决分歧 → 替代情景 → 复现凭证。 */
  function metricView(releaseId, metricKey) {
    const release = requireRelease(releaseId);
    const metric = baseline.metrics[metricKey];
    if (!metric) throw Object.assign(new Error(`未知指标 ${metricKey}`), { code: "NOT_FOUND" });
    const workforce = metric.workforce;
    const result = release.frozen_results[workforce];

    const assumptionChain = release.frozen_inputs.assumptions
      .filter((a) => a.workforce === workforce)
      .map((a) => ({
        assumption_id: a.id,
        variable: a.variable,
        region: a.region,
        applicable_years: [a.year_start, a.year_end],
        point: a.point,
        ci: clone(a.ci),
        unit: a.unit,
        source: clone(a.source),
        submitted_by: a.submitter,
        content_fingerprint: a.content_fingerprint,
      }));

    const unresolvedDisagreements = [
      ...release.dissents
        .map((d) => ({ kind: "dissent", version: release.version, ...d })),
      ...gate
        .list({ status: "clarification", workforce })
        .filter((a) =>
          release.scenario.scope === "national"
            ? a.region === baseline.region_taxonomy.national
            : release.scenario.regions.includes(a.region),
        )
        .map((a) => ({
          kind: "open_clarification",
          assumption_id: a.id,
          variable: a.variable,
          region: a.region,
          issues: a.issues,
        })),
    ];

    const alternatives = [];
    for (const other of releases.values()) {
      if (other.id === release.id) continue;
      alternatives.push({
        version: other.version,
        release_id: other.id,
        effective_capacity_2030: other.frozen_results[workforce].effective_capacity_2030,
        meets_target: other.frozen_results[workforce].meets_target,
        target_gap: other.frozen_results[workforce].target_gap,
        relation: release.revision_chain.includes(other.id) ? "predecessor_revision" : "parallel",
      });
    }
    for (const candidate of studio.list()) {
      if (!candidate.compatibility.compatible || !candidate.results) continue;
      if (candidate.id === release.scenario.id) continue;
      alternatives.push({
        candidate_id: candidate.id,
        name: candidate.name,
        effective_capacity_2030: candidate.results[workforce].effective_capacity_2030,
        meets_target: candidate.results[workforce].meets_target,
        target_gap: candidate.results[workforce].target_gap,
        relation: "candidate",
      });
    }

    return {
      metric: metricKey,
      release: { id: release.id, version: release.version, published_at: release.published_at },
      baseline: { id: baseline.baseline_id, target_year: baseline.target_year },
      target: baseline.national_targets[workforce],
      value: {
        headcount_2030: result.headcount_2030,
        effective_capacity_2030: result.effective_capacity_2030,
        target_gap: result.target_gap,
        meets_target: result.meets_target,
      },
      assumption_chain: assumptionChain,
      sensitivity: clone(release.frozen_sensitivity[workforce]),
      unresolved_disagreements: unresolvedDisagreements,
      minority_proposals: clone(release.minority_proposals),
      alternative_scenarios: alternatives,
      reproducibility: {
        input_fingerprint: release.scenario.input_fingerprint,
        result_fingerprint: release.scenario.result_fingerprint,
        program_fingerprint: release.program.program_fingerprint,
        contract_fingerprint: release.baseline.contract_fingerprint,
        replay: `POST /releases/${release.id}/replay`,
      },
      privacy_notice: "本视图仅含聚合统计，不含任何个人医护档案",
    };
  }

  function listReleases() {
    return [...releases.values()].map(releaseView);
  }

  /** 发布归档导出：整份不可变快照，可落盘保存或跨进程移交。 */
  function exportRelease(id) {
    return clone(requireRelease(id));
  }

  /**
   * 归档导入：作为信任边界，先深度核验
   *  1. 每条假设内容指纹与记录一致；
   *  2. 序列化输入指纹与归档一致；
   *  3. 发布指纹与归档头一致。
   * 任一不符说明归档在库外被改动，拒绝导入。
   */
  function importRelease(archive) {
    const tampered = [];
    for (const a of archive.frozen_inputs?.assumptions ?? []) {
      if (assumptionContentFingerprint(a) !== a.content_fingerprint) tampered.push(a.id);
    }
    if (
      archive.frozen_inputs &&
      fingerprint(archive.frozen_inputs.serialized) !== archive.frozen_inputs.input_fingerprint
    ) {
      tampered.push("__serialized_inputs__");
    }
    if (tampered.length > 0) {
      throw Object.assign(new Error("归档输入完整性核验失败，快照在库外被改动"), {
        code: "ARCHIVE_TAMPERED",
        tampered_slots: tampered,
      });
    }

    const stored = archive.release_fingerprint;
    if (!stored) throw Object.assign(new Error("归档缺少 release_fingerprint"), { code: "VALIDATION_ERROR" });
    const recomputed = fingerprint({
      version: archive.version,
      baseline: archive.baseline,
      scenario: archive.scenario,
      program: archive.program,
      review_id: archive.review?.id,
      revision_of: archive.revision_of,
      frozen_inputs_fingerprint: archive.frozen_inputs?.input_fingerprint,
      result_fingerprint: archive.scenario?.result_fingerprint,
    });
    if (recomputed !== stored) {
      throw Object.assign(new Error("归档发布指纹校验失败，快照在库外被改动"), {
        code: "ARCHIVE_TAMPERED",
        stored,
        recomputed,
      });
    }
    if (releases.has(archive.id)) {
      throw Object.assign(new Error(`版本 ${archive.version}（${archive.id}）已存在`), { code: "ALREADY_EXISTS" });
    }
    releases.set(archive.id, clone(archive));
    releaseCounter = Math.max(releaseCounter, archive.release_no);
    return releaseView(releases.get(archive.id));
  }
  function listReviews() {
    return [...reviews.values()].map(clone);
  }
  function listReviewers() {
    return [...reviewers.values()].map(clone);
  }
  function getReview(id) {
    return clone(requireReview(id));
  }
  function getRelease(id) {
    return releaseView(requireRelease(id));
  }

  function requireReviewer(id) {
    const reviewer = reviewers.get(id);
    if (!reviewer) throw Object.assign(new Error(`评审员 ${id} 不存在`), { code: "NOT_FOUND" });
    return reviewer;
  }
  function requireReview(id) {
    const review = reviews.get(id);
    if (!review) throw Object.assign(new Error(`审议 ${id} 不存在`), { code: "NOT_FOUND" });
    return review;
  }
  function requireOpenReview(id) {
    const review = requireReview(id);
    if (review.status !== "open") {
      throw Object.assign(new Error(`审议 ${review.id} 已结束（${review.result}）`), { code: "REVIEW_CLOSED" });
    }
    return review;
  }
  function requireRelease(id) {
    const release = releases.get(id);
    if (!release) throw Object.assign(new Error(`发布版本 ${id} 不存在`), { code: "NOT_FOUND" });
    return release;
  }

  return {
    registerReviewer,
    discloseInterests,
    openReview,
    castVote,
    closeReview,
    publish,
    replay,
    replayArchive,
    metricView,
    listReleases,
    exportRelease,
    importRelease,
    listReviews,
    listReviewers,
    getReview,
    getRelease,
  };
}

function releaseView(release) {
  return clone({
    ...release,
    // 视图中不重复内联完整快照，需要快照走 /releases/:id（getRelease 返回完整）
  });
}
