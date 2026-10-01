import http from "node:http";

import { serviceId, serviceName } from "./service.js";

/**
 * HTTP 装配。状态保存在进程内存中；已发布版本含完整冻结快照，
 * 可经 GET /releases/:id 导出归档。
 */
export function createRouter(app) {
  const { baseline, gate, studio, board } = app;

  const routes = [
    ["GET", /^\/health$/, () => ({
      status: "ok", service: serviceId, name: serviceName,
      baseline_id: baseline.baseline_id,
    })],
    ["GET", /^\/baseline$/, () => ({
      baseline_id: baseline.baseline_id,
      baseline_year: baseline.baseline_year,
      target_year: baseline.target_year,
      national_targets: baseline.national_targets,
      canonical_units: baseline.canonical_units,
      variables: baseline.variables,
      citation_policy: baseline.citation_policy,
      confidence_policy: baseline.confidence_policy,
      governance_policy: baseline.governance_policy,
      contract_fingerprint: baseline.contract_fingerprint,
    })],

    ["POST", /^\/assumptions$/, (_, body) => gate.submit(body)],
    ["GET", /^\/assumptions$/, (params) => gate.list(params)],
    ["GET", /^\/assumptions\/([^/]+)$/, (p) => gate.get(p[0])],
    ["POST", /^\/assumptions\/([^/]+)\/clarify$/, (p, body) =>
      gate.resolveClarification(p[0], body.action, body.body ?? {})],

    ["POST", /^\/scenarios$/, (_, body) =>
      studio.compose({
        name: body.name,
        assumption_ids: body.assumption_ids,
        author: body.author,
        note: body.note,
      })],
    ["GET", /^\/scenarios$/, () => studio.list()],
    ["GET", /^\/scenarios\/([^/]+)$/, (p) => studio.get(p[0])],

    ["POST", /^\/reviewers$/, (_, body) => board.registerReviewer(body)],
    ["GET", /^\/reviewers$/, () => board.listReviewers()],
    ["POST", /^\/reviewers\/([^/]+)\/disclosures$/, (p, body) =>
      board.discloseInterests(p[0], body.interests ?? [])],

    ["POST", /^\/reviews$/, (_, body) => board.openReview(body)],
    ["GET", /^\/reviews$/, () => board.listReviews()],
    ["GET", /^\/reviews\/([^/]+)$/, (p) => board.getReview(p[0])],
    ["POST", /^\/reviews\/([^/]+)\/votes$/, (p, body) =>
      board.castVote(p[0], body)],
    ["POST", /^\/reviews\/([^/]+)\/close$/, (p) => board.closeReview(p[0])],
    ["POST", /^\/reviews\/([^/]+)\/publish$/, async (p, body) =>
      board.publish(p[0], { published_by: body.published_by, notes: body.notes })],

    ["GET", /^\/releases$/, () => board.listReleases()],
    ["GET", /^\/releases\/([^/]+)$/, (p) => board.getRelease(p[0])],
    ["GET", /^\/releases\/([^/]+)\/archive$/, (p) => board.exportRelease(p[0])],
    ["POST", /^\/releases\/import$/, (_, body) => board.importRelease(body)],
    ["POST", /^\/releases\/([^/]+)\/replay$/, async (p) => board.replay(p[0])],
    ["GET", /^\/releases\/([^/]+)\/metrics\/([^/]+)$/, (p) => board.metricView(p[0], p[1])],
  ];

  return async function router({ method, url, body }) {
    const [pathname, queryString] = url.split("?");
    for (const [verb, pattern, handler] of routes) {
      if (verb !== method) continue;
      const match = pathname.match(pattern);
      if (!match) continue;
      const params = queryString ? Object.fromEntries(new URLSearchParams(queryString)) : {};
      const data = await handler(match.slice(1).length ? match.slice(1) : [params], body);
      return { status: 200, data };
    }
    return { status: 404, data: { error: "未找到资源", path: pathname } };
  };
}

const STATUS_BY_CODE = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INVALID_STATE: 409,
  REVIEW_OPEN: 409,
  REVIEW_CLOSED: 409,
  ALREADY_VOTED: 409,
  DISCLOSURE_REQUIRED: 403,
  REASON_REQUIRED: 400,
  PRIVACY_VIOLATION: 422,
  SCENARIO_INCOMPATIBLE: 422,
  INACTIVE_ASSUMPTION: 422,
  JUSTIFICATION_NOT_ALLOWED: 422,
  STILL_CLARIFICATION: 422,
  NOT_APPROVED: 409,
  ALREADY_EXISTS: 409,
  ARCHIVE_TAMPERED: 422,
  UNKNOWN_VARIABLE: 400,
  UNKNOWN_WORKFORCE: 400,
  UNKNOWN_CONSTITUENCY: 400,
  BAD_REGION: 400,
};

export function errorResponse(error) {
  const status = STATUS_BY_CODE[error.code] ?? 400;
  return {
    status,
    data: {
      error: error.message,
      code: error.code ?? "ERROR",
      ...(error.hits ? { hits: error.hits } : {}),
      ...(error.blocked ? { blocked: error.blocked } : {}),
      ...(error.errors ? { errors: error.errors } : {}),
      ...(error.clarification ? { clarification: error.clarification } : {}),
      ...(error.tampered_slots ? { tampered_slots: error.tampered_slots } : {}),
    },
  };
}

export function createHttpServer(app) {
  const router = createRouter(app);
  return http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", async () => {
      let body = null;
      if (chunks.length > 0) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          respond(response, 400, { error: "请求体不是合法 JSON", code: "BAD_JSON" });
          return;
        }
      }
      try {
        const { status, data } = await router({ method: request.method, url: request.url, body });
        respond(response, status, data);
      } catch (error) {
        const { status, data } = errorResponse(error);
        respond(response, status, data);
      }
    });
    request.on("error", () => respond(response, 400, { error: "请求读取失败", code: "BAD_REQUEST" }));
  });
}

function respond(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}
