import assert from "node:assert/strict";
import test from "node:test";

import { createAssumptionGate } from "../src/assumptions.js";
import { PrivacyViolation } from "../src/privacy.js";
import { loadBaseline } from "../src/baseline.js";
import { assumption } from "./helpers.js";

const baseline = await loadBaseline();

test("合规假设直接成为 active，可进入兼容集", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption());
  assert.equal(a.status, "active");
  assert.match(a.content_fingerprint, /^[0-9a-f]{64}$/);
});

test("单位冲突进入澄清，不能直接求和", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({ unit: "percent", point: 2.5 }));
  assert.equal(a.status, "clarification");
  assert.ok(a.issues.some((i) => i.code === "UNIT_CONFLICT"), JSON.stringify(a.issues));
});

test("百分数误填导致越界（55）同时标记单位冲突、数值与区间越界", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({ unit: "percent", point: 55, ci: { low: 50, high: 60 } }));
  assert.deepEqual(
    new Set(a.issues.map((i) => i.code)),
    new Set(["UNIT_CONFLICT", "BAD_VALUE", "BAD_CI"]),
  );
});

test("定义不一致（并入执业助理医师）进入澄清", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({ includes_assistant_physicians: true }));
  assert.equal(a.status, "clarification");
  assert.ok(a.issues.some((i) => i.code === "DEFINITION_MISMATCH"));
});

test("引用过期（早于评审年-3）进入澄清", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({ source: { title: "旧资料", publisher: "机构", year: 2020 } }));
  assert.equal(a.status, "clarification");
  assert.ok(a.issues.some((i) => i.code === "CITATION_EXPIRED"));
});

test("缺置信区间进入澄清，点估计不得直接求和", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({ ci: undefined }));
  assert.equal(a.status, "clarification");
  assert.ok(a.issues.some((i) => i.code === "MISSING_CI"));
});

test("时间范围越界与倒置分别拦截", () => {
  const gate = createAssumptionGate(baseline);
  const out = gate.submit(assumption({ year_start: 2031, year_end: 2032 }));
  assert.ok(out.issues.some((i) => i.code === "OUT_OF_HORIZON"));
  const inverted = gate.submit(assumption({ year_start: 2030, year_end: 2026 }));
  assert.ok(inverted.issues.some((i) => i.code === "JUSTIFICATION_NOT_ALLOWED") === false);
  assert.ok(inverted.issues.some((i) => i.code === "TIME_INVALID"));
  const badStock = gate.submit(assumption({
    variable: "stock", year_start: 2024, year_end: 2024,
    point: 4000000, ci: { low: 3800000, high: 4200000 }, unit: "persons",
  }));
  assert.ok(badStock.issues.some((i) => i.code === "OUT_OF_HORIZON"));
});

test("澄清更正：旧件 superseded、新件 active 且保留 supersedes 链", () => {
  const gate = createAssumptionGate(baseline);
  const bad = gate.submit(assumption({ unit: "percent", point: 2.5 }));
  const fixed = gate.resolveClarification(bad.id, "correct", {
    by: { constituency: "hospital" },
    replacement: assumption(),
  });
  assert.equal(fixed.status, "active");
  assert.equal(fixed.supersedes, bad.id);
  assert.equal(gate.get(bad.id).status, "superseded");
  // 内容指纹在更正后改变
  assert.notEqual(fixed.content_fingerprint, bad.content_fingerprint);
});

test("单位冲突不能以说明放行，必须更正", () => {
  const gate = createAssumptionGate(baseline);
  const bad = gate.submit(assumption({ unit: "percent", point: 2.5 }));
  assert.throws(
    () => gate.resolveClarification(bad.id, "justify", {
      accepted_by: "REV-x", justification: "我们一直这么算",
    }),
    (e) => e.code === "JUSTIFICATION_NOT_ALLOWED",
  );
});

test("定义分歧可在评审员背书后以说明放行", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({
    definition_ref: "含规培在岗学员的口径",
  }));
  assert.equal(a.status, "clarification");
  const resolved = gate.resolveClarification(a.id, "justify", {
    accepted_by: "REV-x",
    justification: "经评审确认该口径仅用于基层能力辅助分析，不进入达标加总",
  });
  assert.equal(resolved.status, "active");
  assert.equal(resolved.resolution.kind, "justification");
});

test("撤回澄清件后不可再用于情景", () => {
  const gate = createAssumptionGate(baseline);
  const a = gate.submit(assumption({ ci: undefined }));
  gate.resolveClarification(a.id, "withdraw", { note: "数据暂时无法补全" });
  assert.equal(gate.get(a.id).status, "withdrawn");
});

test("隐私红线：身份证字段/值与病历字段拒收", () => {
  const gate = createAssumptionGate(baseline);
  assert.throws(
    () => gate.submit(assumption({ id_card: "110101199003071234" })),
    (e) => e.code === "PRIVACY_VIOLATION" && e.hits.length >= 1,
  );
  assert.throws(
    () => gate.submit(assumption({ note: "对应病历号 00012345 的医生" })),
    (e) => e.code === "PRIVACY_VIOLATION",
  );
  assert.ok(PrivacyViolation);
});

test("未知变量、单位、地区、提交方被拦截", () => {
  const gate = createAssumptionGate(baseline);
  assert.equal(
    gate.submit(assumption({ variable: "turnover_guess" })).issues[0].code,
    "UNKNOWN_VARIABLE",
  );
  assert.ok(gate.submit(assumption({ region: "BEIJING" })).issues.some((i) => i.code === "BAD_REGION"));
  assert.ok(gate.submit(assumption({ submitter: { constituency: "vendor" } })).issues
    .some((i) => i.code === "UNKNOWN_CONSTITUENCY"));
});
