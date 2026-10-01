import http from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.js";
import { loadStore, saveStore } from "./store.js";

export const serviceId = "health-workforce-plan";
export const serviceName = "医护供给规划版本库";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

function send(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * 路由仅暴露机构级汇总资源：来源、假设、澄清、情景、运行、评审、发布。
 * 不存在个人医护档案的读写端点。
 */
export async function createServer({ dataFile = process.env.WORKFORCE_DATA_FILE ?? null } = {}) {
  const store = loadStore(dataFile) ?? undefined;
  const app = await createApp(store ? { store } : {});
  const persist = () => {
    if (dataFile) saveStore(app.store, dataFile);
  };

  const safe = (handler) => async (request, response, params) => {
    try {
      await handler(request, response, params);
    } catch (error) {
      const status = error.code === "DISCLOSURE_REQUIRED" || error.code === "RECUSED" ? 403
        : error.code === "INCOMPATIBLE" ? 409
        : 400;
      send(response, status, { error: error.message, code: error.code ?? "BAD_REQUEST", issues: error.issues });
    }
  };

  const routes = [
    ["POST", /^\/sources$/, safe(async (req, res) => {
      send(res, 201, app.registerSource(await readBody(req))); persist();
    })],
    ["POST", /^\/sources\/([^/]+)\/supersede$/, safe(async (req, res, p) => {
      const body = await readBody(req);
      send(res, 200, app.supersedeSource(p[0], body.replacement_id)); persist();
    })],
    ["POST", /^\/assumptions$/, safe(async (req, res) => {
      const result = app.submitAssumption(await readBody(req)); persist();
      send(res, result.clarification ? 202 : 201, result);
    })],
    ["GET", /^\/assumptions$/, safe(async (req, res) => {
      const status = new URL(req.url, "http://x").searchParams.get("status");
      send(res, 200, app.listAssumptions(status));
    })],
    ["GET", /^\/clarifications$/, safe(async (req, res) => {
      const status = new URL(req.url, "http://x").searchParams.get("status");
      send(res, 200, app.listClarifications(status));
    })],
    ["POST", /^\/clarifications\/([^/]+)\/resolve$/, safe(async (req, res, p) => {
      const body = await readBody(req);
      send(res, 200, app.resolveClarification(p[0], body.action, body.payload ?? {})); persist();
    })],
    ["POST", /^\/clarifications\/([^/]+)\/threads$/, safe(async (req, res, p) => {
      const body = await readBody(req);
      send(res, 201, app.addClarificationThread(p[0], body.org_type, body.message)); persist();
    })],
    ["GET", /^\/disagreements$/, safe(async (req, res) => {
      send(res, 200, app.listDisagreements());
    })],
    ["POST", /^\/scenarios$/, safe(async (req, res) => {
      const { scenario } = app.createScenario(await readBody(req)); persist();
      send(res, 201, scenario);
    })],
    ["GET", /^\/scenarios$/, safe(async (req, res) => send(res, 200, app.listScenarios()))],
    ["GET", /^\/scenarios\/([^/]+)$/, safe(async (req, res, p) => {
      const scenario = app.getScenario(p[0]);
      send(res, scenario ? 200 : 404, scenario ?? { error: "情景不存在" });
    })],
    ["POST", /^\/scenarios\/([^/]+)\/dissent$/, safe(async (req, res, p) => {
      send(res, 201, app.addDissent(p[0], await readBody(req))); persist();
    })],
    ["POST", /^\/scenarios\/([^/]+)\/runs$/, safe(async (req, res, p) => {
      const body = await readBody(req);
      const run = await app.runScenario(p[0], body.options ?? {}); persist();
      send(res, 201, run);
    })],
    ["GET", /^\/runs\/([^/]+)$/, safe(async (req, res, p) => {
      const run = app.getRun(p[0]);
      send(res, run ? 200 : 404, run ?? { error: "运行不存在" });
    })],
    ["POST", /^\/runs\/([^/]+)\/reproduce$/, safe(async (req, res, p) => {
      send(res, 200, await app.reproduceRun(p[0]));
    })],
    ["GET", /^\/runs\/([^/]+)\/lineage$/, safe(async (req, res, p) => {
      const metric = new URL(req.url, "http://x").searchParams.get("metric");
      send(res, 200, app.metricLineage(p[0], metric));
    })],
    ["POST", /^\/reviewers$/, safe(async (req, res) => {
      send(res, 201, app.registerReviewer(await readBody(req))); persist();
    })],
    ["POST", /^\/disclosures$/, safe(async (req, res) => {
      send(res, 201, app.discloseInterest(await readBody(req))); persist();
    })],
    ["POST", /^\/releases$/, safe(async (req, res) => {
      send(res, 201, await app.proposeRelease(await readBody(req))); persist();
    })],
    ["GET", /^\/releases$/, safe(async (req, res) => send(res, 200, app.listReleases()))],
    ["GET", /^\/releases\/([^/]+)$/, safe(async (req, res, p) => {
      const release = app.getRelease(p[0]);
      send(res, release ? 200 : 404, release ?? { error: "发布不存在或尚未冻结" });
    })],
    ["POST", /^\/releases\/([^/]+)\/votes$/, safe(async (req, res, p) => {
      send(res, 200, app.castVote(p[0], await readBody(req))); persist();
    })],
    ["POST", /^\/releases\/([^/]+)\/publish$/, safe(async (req, res, p) => {
      send(res, 201, await app.publishRelease(p[0])); persist();
    })],
    ["POST", /^\/releases\/([^/]+)\/revisions$/, safe(async (req, res, p) => {
      send(res, 201, app.openRevision(p[0], await readBody(req))); persist();
    })],
    ["POST", /^\/revisions\/([^/]+)\/bind$/, safe(async (req, res, p) => {
      const body = await readBody(req);
      send(res, 200, app.bindRevisionScenario(p[0], body.scenario_id)); persist();
    })],
    ["GET", /^\/baseline$/, safe(async (req, res) => send(res, 200, app.getBaseline()))]
  ];

  return http.createServer((request, response) => {
    if (request.url === "/health") {
      send(response, 200, healthPayload());
      return;
    }
    const path = new URL(request.url, "http://x").pathname;
    for (const [method, pattern, handler] of routes) {
      if (request.method !== method) continue;
      const match = path.match(pattern);
      if (match) {
        handler(request, response, match.slice(1));
        return;
      }
    }
    send(response, 404, { error: "未找到资源" });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) {
    if (healthPayload().service !== serviceId) process.exit(1);
    console.log("基础检查通过");
  } else {
    const portIndex = process.argv.indexOf("--port");
    const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8000;
    createServer().then((server) => server.listen(port, "0.0.0.0"));
  }
}
