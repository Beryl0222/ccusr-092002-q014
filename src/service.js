import http from "node:http";
import { pathToFileURL } from "node:url";

import { createApp, seedDemo } from "./app.js";
import { createHttpServer } from "./http.js";

export const serviceId = "health-workforce-plan";
export const serviceName = "医护供给规划版本库";

export function healthPayload() {
  return { status: "ok", service: serviceId, name: serviceName };
}

export function createServer() {
  // 保留无依赖的最小健康检查服务器，供基础契约使用
  return http.createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "未找到资源" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(healthPayload()));
  });
}

function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv.includes("--check")) {
    const app = await createApp();
    if (healthPayload().service !== serviceId) process.exit(1);
    const demo = await seedDemo(app);
    if (!demo.replayV1.fully_reproducible) {
      console.error("冻结快照复现失败");
      process.exit(1);
    }
    console.log("基础检查通过");
    console.log(`基线 ${app.baseline.baseline_id}（契约指纹 ${app.baseline.contract_fingerprint.slice(0, 12)}…）`);
    console.log(`V1 达标结论 医师=${demo.outcomes.v1.physicians} 护士=${demo.outcomes.v1.nurses}；V2 医师=${demo.outcomes.v2.physicians}`);
    console.log(`V1 冻结重放结果指纹一致=${demo.replayV1.result_fingerprint_matches}`);
    return;
  }

  if (process.argv.includes("--demo")) {
    const app = await createApp();
    const demo = await seedDemo(app);
    console.log(JSON.stringify(demo, null, 2));
    return;
  }

  const port = Number(argValue("port", 8000));
  const app = await createApp();
  if (process.argv.includes("--seed")) await seedDemo(app);
  createHttpServer(app).listen(port, "0.0.0.0", () => {
    console.log(`${serviceName} 监听 http://0.0.0.0:${port}（基线 ${app.baseline.baseline_id}）`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
