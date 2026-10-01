import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.js";
import { createHttpServer } from "../src/http.js";

async function withServer(run) {
  const app = await createApp();
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(base, app);
  } finally {
    server.close();
  }
}

async function json(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

test("HTTP: /health 与 /baseline", async () => {
  await withServer(async (base) => {
    const h = await json("GET", `${base}/health`);
    assert.equal(h.status, 200);
    assert.equal(h.data.service, "health-workforce-plan");
    const b = await json("GET", `${base}/baseline`);
    assert.equal(b.data.target_year, 2030);
    assert.match(b.data.contract_fingerprint, /^[0-9a-f]{64}$/);
  });
});

test("HTTP: 单位冲突 → 422/澄清件 → 更正 → 情景拒绝澄清件", async () => {
  await withServer(async (base) => {
    const bad = {
      variable: "retirement_rate", workforce: "physicians", region: "CN",
      year_start: 2026, year_end: 2030, point: 2.5,
      ci: { low: 2, high: 3 }, unit: "percent",
      source: { title: "t", publisher: "p", year: 2025 },
      submitter: { constituency: "hospital", org: "o" },
    };
    const r1 = await json("POST", `${base}/assumptions`, bad);
    assert.equal(r1.status, 200);
    assert.equal(r1.data.status, "clarification");
    const id = r1.data.id;

    // 直接组合应被拒
    const r2 = await json("POST", `${base}/scenarios`, {
      name: "x", assumption_ids: [id],
    });
    assert.equal(r2.status, 422);
    assert.equal(r2.data.code, "INACTIVE_ASSUMPTION");

    // 更正
    const r3 = await json("POST", `${base}/assumptions/${id}/clarify`, {
      action: "correct",
      body: {
        by: { constituency: "hospital" },
        replacement: { ...bad, point: 0.025, ci: { low: 0.02, high: 0.03 }, unit: "fraction_per_year" },
      },
    });
    assert.equal(r3.status, 200);
    assert.equal(r3.data.status, "active");
    assert.equal(r3.data.supersedes, id);
  });
});

test("HTTP: 隐私红线 422", async () => {
  await withServer(async (base) => {
    const r = await json("POST", `${base}/assumptions`, {
      variable: "stock", workforce: "nurses", region: "CN",
      year_start: 2025, year_end: 2025, point: 1,
      ci: { low: 1, high: 2 }, unit: "persons",
      source: { title: "t", publisher: "p", year: 2025 },
      submitter: { constituency: "hospital" },
      patient_name: "李某",
    });
    assert.equal(r.status, 422);
    assert.equal(r.data.code, "PRIVACY_VIOLATION");
  });
});

test("HTTP: 完整四方表决发布链路与指标复现", async () => {
  await withServer(async (base) => {
    // 两个队伍各六个变量
    const ids = [];
    for (const workforce of ["physicians", "nurses"]) {
      const stock = workforce === "physicians" ? 4100000 : 5600000;
      const vars = [
        { variable: "stock", year_start: 2025, year_end: 2025, point: stock, ci: { low: stock * 0.96, high: stock * 1.04 }, unit: "persons" },
        { variable: "retirement_rate", point: 0.025, ci: { low: 0.02, high: 0.035 }, unit: "fraction_per_year" },
        { variable: "training_intake", point: 500000, ci: { low: 450000, high: 550000 }, unit: "persons_per_year" },
        { variable: "completion_rate", point: 0.55, ci: { low: 0.48, high: 0.62 }, unit: "fraction" },
        { variable: "net_inflow_rate", point: 0, ci: { low: 0, high: 0 }, unit: "fraction_per_year" },
        { variable: "efficiency_index", point: 1, ci: { low: 0.94, high: 1.08 }, unit: "index_2025_1" },
      ];
      for (const v of vars) {
        const r = await json("POST", `${base}/assumptions`, {
          workforce, region: "CN", year_start: 2026, year_end: 2030,
          source: { title: "t", publisher: "p", year: 2025 },
          submitter: { constituency: "hospital", org: "o" },
          ...v,
        });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        ids.push(r.data.id);
      }
    }

    const scenario = await json("POST", `${base}/scenarios`, { name: "HTTP 情景", assumption_ids: ids });
    assert.equal(scenario.data.compatibility.compatible, true);

    const reviewerIds = [];
    for (const [name, constituency] of [
      ["甲", "hospital"], ["乙", "primary_care"], ["丙", "education"], ["丁", "finance"],
    ]) {
      const reg = await json("POST", `${base}/reviewers`, { name, constituency });
      await json("POST", `${base}/reviewers/${reg.data.id}/disclosures`, { interests: [] });
      reviewerIds.push(reg.data.id);
    }

    const review = await json("POST", `${base}/reviews`, { scenario_id: scenario.data.id, title: "HTTP 审议" });
    for (const id of reviewerIds) {
      const v = await json("POST", `${base}/reviews/${review.data.id}/votes`, { reviewer_id: id, vote: "approve" });
      assert.equal(v.status, 200);
    }
    await json("POST", `${base}/reviews/${review.data.id}/close`);
    const pub = await json("POST", `${base}/reviews/${review.data.id}/publish`, { published_by: "研究组" });
    assert.equal(pub.status, 200);
    assert.equal(pub.data.version, "V1");

    const replay = await json("POST", `${base}/releases/${pub.data.id}/replay`);
    assert.equal(replay.data.fully_reproducible, true);

    const metric = await json("GET", `${base}/releases/${pub.data.id}/metrics/physicians_2030`);
    assert.equal(metric.data.assumption_chain.length, 6);
    assert.equal(metric.data.value.headcount_2030 > 0, true);
  });
});

test("HTTP: 未披露投票 403；未知路由 404；坏 JSON 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const bad = await fetch(`${base}/assumptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"oops":',
    });
    assert.equal(bad.status, 400);
  });
});
