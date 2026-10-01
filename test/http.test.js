import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createServer } from "../src/service.js";

async function withServer(dataFile = null) {
  const server = await createServer({ dataFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  };
  return {
    call,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

test("健康检查与基线可读", async () => {
  const srv = await withServer();
  const h = await srv.call("GET", "/health");
  assert.equal(h.body.service, "health-workforce-plan");
  const b = await srv.call("GET", "/baseline");
  assert.equal(b.body.snapshot_id, "BASE-2030");
  await srv.close();
});

test("单位冲突的提交返回 202 并挂起澄清，更正后才可用", async () => {
  const srv = await withServer();
  const src = await srv.call("POST", "/sources", { title: "t", publisher: "p", published_on: "2026-01-01" });
  const bad = await srv.call("POST", "/assumptions", {
    field: "training_intake", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 33, unit: "wan", ci: { lo: 30, hi: 36 },
    source_id: src.body.id, submitted_by: { org_type: "education" }
  });
  assert.equal(bad.status, 202);
  assert.equal(bad.body.assumption.status, "clarification");
  const open = await srv.call("GET", "/clarifications?status=open");
  assert.equal(open.body.length, 1);

  const fixed = await srv.call("POST", `/clarifications/${open.body[0].id}/resolve`, {
    action: "reconcile",
    payload: {
      field: "training_intake", profession: "physician", region: "NATIONAL",
      year_range: [2026, 2030], value: 330000, unit: "headcount_rate", ci: { lo: 300000, hi: 360000 },
      source_id: src.body.id, submitted_by: { org_type: "education" }
    }
  });
  assert.equal(fixed.body.new_assumption.status, "accepted");
  await srv.close();
});

async function tenAssumptions(srv, sourceId) {
  const specs = [
    ["retirement_rate", "physician", 0.035, "fraction", [0.03, 0.04]],
    ["retirement_rate", "nurse", 0.04, "fraction", [0.032, 0.05]],
    ["productivity", "physician", 1850, "service_visits", [1700, 2000]],
    ["productivity", "nurse", 1250, "service_visits", [1100, 1400]],
    ["training_intake", "physician", 330000, "headcount_rate", [300000, 360000]],
    ["training_intake", "nurse", 540000, "headcount_rate", [480000, 600000]],
    ["training_completion", "physician", 0.92, "fraction", [0.88, 0.95]],
    ["training_completion", "nurse", 0.88, "fraction", [0.82, 0.92]],
    ["migration_rate", "physician", 0, "fraction", [-0.002, 0.002]],
    ["migration_rate", "nurse", 0.001, "fraction", [-0.003, 0.004]]
  ];
  const ids = [];
  for (const [field, profession, value, unit, ci] of specs) {
    const r = await srv.call("POST", "/assumptions", {
      field, profession, region: "NATIONAL", year_range: [2026, 2030],
      value, unit, ci: { lo: ci[0], hi: ci[1] }, source_id: sourceId,
      submitted_by: { org_type: "hospital" }
    });
    ids.push(r.body.assumption.id);
  }
  return ids;
}

test("未披露利益关系的表决返回 403", async () => {
  const srv = await withServer();
  const src = await srv.call("POST", "/sources", { title: "t", publisher: "p", published_on: "2026-01-01" });
  const ids = await tenAssumptions(srv, src.body.id);
  const scn = await srv.call("POST", "/scenarios", { name: "S", assumption_ids: ids });
  const run = await srv.call("POST", `/scenarios/${scn.body.id}/runs`, {});
  const rel = await srv.call("POST", "/releases", { run_id: run.body.id });
  await srv.call("POST", "/reviewers", { id: "R1", name: "x", org_type: "hospital" });
  const res = await srv.call("POST", `/releases/${rel.body.id}/votes`, { reviewer_id: "R1", position: "approve" });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DISCLOSURE_REQUIRED");
  await srv.close();
});

test("数据文件持久化：重启后状态保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wf-"));
  const file = join(dir, "data.json");
  const s1 = await withServer(file);
  const src = await s1.call("POST", "/sources", { title: "持久来源", publisher: "p", published_on: "2026-01-01" });
  await s1.close();

  const s2 = await withServer(file);
  const asm = await s2.call("POST", "/assumptions", {
    field: "retirement_rate", profession: "physician", region: "NATIONAL",
    year_range: [2026, 2030], value: 0.035, unit: "fraction", ci: { lo: 0.03, hi: 0.04 },
    source_id: src.body.id, submitted_by: { org_type: "hospital" }
  });
  assert.equal(asm.status, 201);
  await s2.close();
  await rm(dir, { recursive: true, force: true });
});

test("服务只暴露汇总资源，未知路径 404", async () => {
  const srv = await withServer();
  const res = await srv.call("GET", "/individual-staff-records");
  assert.equal(res.status, 404);
  await srv.close();
});
