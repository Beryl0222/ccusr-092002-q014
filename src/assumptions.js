import { clone, finiteNumber, fingerprint, newId } from "./util.js";
import { assertNoPersonalRecords } from "./privacy.js";

/**
 * 假设审议：
 * 医院、基层机构、教育部门、财政部门分别提交带来源、适用地区、时间范围
 * 与置信区间的假设。单位冲突、定义不一致或引用过期时先进入澄清，
 * 澄清完成前不是「兼容假设」，不能参与求和与情景计算。
 */

export const CONSTITUENCIES = ["hospital", "primary_care", "education", "finance"];
export const WORKFORCES = ["physicians", "nurses"];

// 只有定义分歧可在评审员背书下以「说明」方式消解；其余问题必须更正或撤回。
const JUSTIFIABLE = new Set(["DEFINITION_MISMATCH"]);

export function validateAssumption(input, baseline) {
  const issues = [];
  const push = (code, message) => issues.push({ code, message });

  const variable = baseline.variables.get(input.variable);
  if (!variable) {
    push("UNKNOWN_VARIABLE", `未知变量 ${input.variable}；公共基线仅允许 ${[...baseline.variables.keys()].join("、")}`);
  }
  if (!WORKFORCES.includes(input.workforce)) {
    push("UNKNOWN_WORKFORCE", `队伍标识必须是 ${WORKFORCES.join(" 或 ")}`);
  }
  if (!CONSTITUENCIES.includes(input.submitter?.constituency)) {
    push("UNKNOWN_CONSTITUENCY", `提交方必须是四方之一：${CONSTITUENCIES.join("、")}`);
  }

  const region = String(input.region ?? "");
  if (region !== baseline.region_taxonomy.national && !/^CN-[A-Z]{2,3}$/.test(region)) {
    push("BAD_REGION", `地区 ${region} 不符合层级编码（CN 或 CN-XX）`);
  }

  const source = input.source || {};
  if (!source.title || !source.publisher || !finiteNumber(source.year)) {
    push("MISSING_SOURCE", "假设必须附来源：标题、发布机构与数据年份缺一不可");
  } else {
    const cutoff = baseline.citation_policy.evaluation_date.slice(0, 4) -
      baseline.citation_policy.max_reference_age_years;
    if (source.year < cutoff) {
      push(
        "CITATION_EXPIRED",
        `来源数据年份 ${source.year} 早于 ${cutoff} 年，按 ${baseline.citation_policy.max_reference_age_years} 年时效已过期，须更新来源后重新提交`,
      );
    }
  }

  const y0 = Number(input.year_start);
  const y1 = Number(input.year_end);
  if (!finiteNumber(y0) || !finiteNumber(y1)) {
    push("MISSING_TIME_RANGE", "假设必须给出适用时间范围 year_start/year_end");
  } else if (y1 < y0) {
    push("TIME_INVALID", `时间范围倒置：${y0}–${y1}`);
  } else {
    const [lo, hi] = baseline.temporal_policy.horizon;
    if (y0 < lo || y1 > hi) {
      push("OUT_OF_HORIZON", `适用年份 ${y0}–${y1} 超出规划区间 ${lo}–${hi}`);
    }
    if (variable?.key === "stock" && !(y0 <= baseline.baseline_year && y1 >= baseline.baseline_year)) {
      push("OUT_OF_HORIZON", `基期存量假设必须覆盖基期年 ${baseline.baseline_year}`);
    }
  }

  if (variable) {
    if (input.unit !== variable.unit) {
      push(
        "UNIT_CONFLICT",
        `变量 ${variable.key} 的规范单位是 ${variable.unit}，提交单位为 ${input.unit ?? "（缺）"}；单位冲突须先澄清，不得直接求和`,
      );
    }
    const expectedDef = baseline.definitions[
      input.workforce === "physicians" ? "physician" : input.workforce === "nurses" ? "nurse" : null
    ];
    if (input.definition_ref && expectedDef && input.definition_ref !== expectedDef) {
      push(
        "DEFINITION_MISMATCH",
        `提交采用的口径「${input.definition_ref}」与公共基线口径「${expectedDef}」不一致`,
      );
    }
    if (input.workforce === "physicians" && input.includes_assistant_physicians === true) {
      push("DEFINITION_MISMATCH", "医师目标不含执业助理医师，提交口径不得并入助理医师");
    }
  }

  if (!finiteNumber(input.point)) {
    push("BAD_VALUE", "点估计缺失或不是数值");
  } else if (variable?.metric === "rate") {
    if (input.point < 0 || input.point > 1) {
      push("BAD_VALUE", `比率变量取值须在 [0,1]，当前为 ${input.point}（注意规范单位为年率分数而非百分数）`);
    }
  } else if (variable?.metric === "efficiency_index" && input.point <= 0) {
    push("BAD_VALUE", "效率指数须为正数");
  } else if (variable?.metric === "headcount" && input.point < 0) {
    push("BAD_VALUE", "人数变量不得为负");
  }

  const ci = input.ci;
  if (!ci || !finiteNumber(ci.low) || !finiteNumber(ci.high)) {
    push("MISSING_CI", "缺少置信区间（95% 区间上下限）；仅给点估计的假设先进入澄清");
  } else if (!(ci.low <= input.point && input.point <= ci.high)) {
    push("BAD_CI", `置信区间 [${ci.low}, ${ci.high}] 未正确包含点估计 ${input.point}`);
  } else if (ci.low === ci.high && input.point !== 0) {
    push("BAD_CI", `零宽置信区间 [${ci.low}, ${ci.high}] 仅适用于确定性为 0 的轧平项（如全国净流入）`);
  } else if (variable?.metric === "rate" && (ci.low < 0 || ci.high > 1)) {
    push("BAD_CI", `比率变量置信区间超出 [0,1]：[${ci.low}, ${ci.high}]`);
  }

  return issues;
}

export function createAssumptionGate(baseline) {
  /** @type {Map<string, any>} */
  const assumptions = new Map();

  function publicView(record) {
    return clone(record);
  }

  function submit(input) {
    assertNoPersonalRecords(input);
    const issues = validateAssumption(input, baseline);
    const now = new Date().toISOString();
    const record = {
      id: newId("ASM"),
      baseline_id: baseline.baseline_id,
      variable: input.variable,
      workforce: input.workforce,
      region: input.region,
      year_start: input.year_start,
      year_end: input.year_end,
      point: input.point,
      ci: input.ci ?? null,
      unit: input.unit,
      definition_ref: input.definition_ref ?? null,
      source: clone(input.source),
      submitter: clone(input.submitter),
      note: input.note ?? null,
      status: issues.length === 0 ? "active" : "clarification",
      issues,
      supersedes: null,
      resolution: null,
      submitted_at: now,
    };
    record.content_fingerprint = fingerprint(stripRuntime(record));
    assumptions.set(record.id, record);
    return publicView(record);
  }

  function get(id) {
    const record = assumptions.get(id);
    if (!record) throw Object.assign(new Error(`假设 ${id} 不存在`), { code: "NOT_FOUND" });
    return record;
  }

  /**
   * 处理澄清：
   * - correct：用更正后的内容重新提交，旧件标记 superseded，保留审计链；
   * - withdraw：撤回旧件；
   * - justify：仅定义分歧可在评审员背书后附说明保留。
   */
  function resolveClarification(id, action, body = {}) {
    const record = get(id);
    if (record.status !== "clarification") {
      throw Object.assign(new Error(`假设 ${id} 不在澄清状态（当前 ${record.status}）`), {
        code: "INVALID_STATE",
      });
    }
    const now = new Date().toISOString();

    if (action === "withdraw") {
      record.status = "withdrawn";
      record.resolution = { kind: "withdraw", note: body.note ?? null, by: body.by ?? null, at: now };
      return publicView(record);
    }

    if (action === "justify") {
      const blocked = record.issues.filter((i) => !JUSTIFIABLE.has(i.code));
      if (blocked.length > 0) {
        throw Object.assign(
          new Error(`单位冲突、引用过期、缺区间等问题不能以说明放行，请更正后重新提交：${blocked.map((i) => i.code).join(",")}`),
          { code: "JUSTIFICATION_NOT_ALLOWED", blocked },
        );
      }
      if (!body.accepted_by || !body.justification) {
        throw Object.assign(new Error("以说明消解定义分歧须给出 justification 与评审员 accepted_by"), {
          code: "VALIDATION_ERROR",
        });
      }
      record.status = "active";
      record.resolution = {
        kind: "justification",
        justification: body.justification,
        accepted_by: body.accepted_by,
        at: now,
      };
      return publicView(record);
    }

    if (action === "correct") {
      if (!body.replacement) {
        throw Object.assign(new Error("更正须提供 replacement 提交内容"), { code: "VALIDATION_ERROR" });
      }
      const fresh = submit(body.replacement);
      if (fresh.status === "clarification") {
        // 更正件仍有问题：保留为新的澄清件，旧件维持澄清，不做状态推进。
        throw Object.assign(new Error("更正后的假设仍未通过门禁，见返回的澄清件问题清单"), {
          code: "STILL_CLARIFICATION",
          clarification: fresh,
        });
      }
      const replacement = assumptions.get(fresh.id);
      replacement.supersedes = record.id;
      replacement.resolution = { kind: "correction", of: record.id, by: body.by ?? null, at: now };
      record.status = "superseded";
      record.resolution = { kind: "superseded_by", replacement_id: replacement.id, at: now };
      return publicView(replacement);
    }

    throw Object.assign(new Error(`未知澄清动作 ${action}`), { code: "VALIDATION_ERROR" });
  }

  function list(filter = {}) {
    let rows = [...assumptions.values()];
    if (filter.status) rows = rows.filter((r) => r.status === filter.status);
    if (filter.workforce) rows = rows.filter((r) => r.workforce === filter.workforce);
    if (filter.region) rows = rows.filter((r) => r.region === filter.region);
    return rows.map(publicView);
  }

  function activeAssumptions() {
    return [...assumptions.values()].filter((r) => r.status === "active");
  }

  return { assumptions, submit, get, resolveClarification, list, activeAssumptions, publicView };
}

export function assumptionContentFingerprint(record) {
  return fingerprint(stripRuntime(record));
}

function stripRuntime(record) {
  const { id, status, issues, supersedes, resolution, submitted_at, content_fingerprint, ...content } = record;
  return content;
}
