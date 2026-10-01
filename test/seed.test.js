import assert from "node:assert/strict";
import test from "node:test";

import { createApp, seedDemo } from "../src/app.js";

test("演示种子：澄清、隐私拒收、两版发布与修订链、冻结复现", async () => {
  const app = await createApp();
  const demo = await seedDemo(app);

  // 单位冲突被识别并经更正解决
  assert.deepEqual(
    new Set(demo.log.find((e) => e.event === "clarification_opened" && e.id === demo.ids.assumptions.badCompletion).issues),
    new Set(["UNIT_CONFLICT", "BAD_VALUE", "BAD_CI"]),
  );
  assert.ok(demo.log.some((e) => e.event === "clarification_resolved" && e.id === demo.ids.assumptions.badCompletion));

  // 引用过期单独留在澄清状态
  const expired = app.gate.get(demo.ids.assumptions.expired);
  assert.equal(expired.status, "clarification");
  assert.ok(expired.issues.some((i) => i.code === "CITATION_EXPIRED"));

  // 隐私红线
  assert.equal(demo.privacyBlocked.code, "PRIVACY_VIOLATION");

  // 结论：V1 医师不达标、护士达标；V2 效率修订翻转医师结论
  assert.deepEqual(demo.outcomes.v1, { physicians: false, nurses: true });
  assert.deepEqual(demo.outcomes.v2, { physicians: true, nurses: true });

  // V1 可完全复现；V2 修订自 V1
  assert.equal(demo.replayV1.fully_reproducible, true);
  const v1 = app.board.getRelease(demo.ids.releases.v1);
  const v2 = app.board.getRelease(demo.ids.releases.v2);
  assert.equal(v2.revision_of, v1.id);
  assert.deepEqual(v2.revision_chain, [v1.id]);

  // 反对意见与少数方案随 V1 保存
  assert.equal(v1.dissents.length, 1);
  assert.equal(v1.minority_proposals.length, 1);
  assert.equal(v1.minority_proposals[0].name, "效率提升情景");

  // V1 不可变：发布对象带 immutable 标记，冻结结果仍是效率=1
  assert.equal(v1.immutable, true);
  assert.equal(v1.frozen_results.physicians.efficiency_index, 1);
  assert.equal(v2.frozen_results.physicians.efficiency_index, 1.08);

  // 指标视图把 V2 列为 V1 的后继替代（修订链上）
  const view = app.board.metricView(v1.id, "physicians_2030");
  const v2Alt = view.alternative_scenarios.find((a) => a.release_id === v2.id);
  assert.ok(v2Alt);
  assert.equal(v2Alt.meets_target, true);
});

test("演示种子的 V2 也可在冻结快照上复现", async () => {
  const app = await createApp();
  const demo = await seedDemo(app);
  const replay = await app.board.replay(demo.ids.releases.v2);
  assert.equal(replay.fully_reproducible, true);
});
