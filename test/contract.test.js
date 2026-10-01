import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { healthPayload, serviceId } from "../src/service.js";

test("服务身份稳定", () => {
  assert.equal(healthPayload().service, serviceId);
});

test("领域样例与服务一致且基线完整", async () => {
  const raw = await readFile(new URL("../contracts/workforce_scenario.json", import.meta.url), "utf8");
  const data = JSON.parse(raw);
  assert.equal(data.service, serviceId);
  assert.ok(data.sample);
  const b = data.baseline;
  assert.equal(b.snapshot_id, "BASE-2030");
  assert.equal(b.national_targets.physician.target, 5000000);
  for (const field of ["retirement_rate", "training_completion", "training_intake", "migration_rate", "productivity"]) {
    assert.ok(b.fields[field], `缺少字段登记：${field}`);
  }
});
