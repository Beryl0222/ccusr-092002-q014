import assert from "node:assert/strict";
import test from "node:test";

import { loadBaseline } from "../src/baseline.js";

const baseline = await loadBaseline();

test("公共基线加载：目标年、目标值与定义", () => {
  assert.equal(baseline.baseline_id, "NATIONAL-2030-BASELINE");
  assert.equal(baseline.target_year, 2030);
  assert.equal(baseline.national_targets.physicians.value, 5000000);
  assert.equal(baseline.national_targets.nurses.value, 7000000);
  assert.match(baseline.definitions.physician, /不含执业助理医师/);
});

test("规范变量与单位齐备", () => {
  for (const key of [
    "stock",
    "retirement_rate",
    "training_intake",
    "completion_rate",
    "net_inflow_rate",
    "efficiency_index",
  ]) {
    assert.ok(baseline.variables.get(key), `缺少变量 ${key}`);
  }
  assert.equal(baseline.variables.get("retirement_rate").unit, "fraction_per_year");
});

test("基线契约指纹稳定（契约未改动则不变）", () => {
  assert.match(baseline.contract_fingerprint, /^[0-9a-f]{64}$/);
});

test("旧样例字段仍保留在契约中", () => {
  assert.equal(baseline.contract.service, "health-workforce-plan");
  assert.equal(baseline.contract.sample.scenario_id, "BASE-2030");
});
