import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256 } from "./util.js";

/**
 * 计算程序版本：参与领域计算的源代码变更都会改变指纹。
 * 发布时记录该指纹；复现须在相同程序指纹下进行。
 * service.js（HTTP 装配）与 seed.js（演示数据）不参与计算，故不计入。
 */
export const ENGINE_VERSION = "1.0.0";

const EXCLUDED = new Set(["service.js", "seed.js", "program.js"]);

export async function programFingerprint() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const entries = await readdir(dir);
  const files = entries.filter((f) => f.endsWith(".js") && !EXCLUDED.has(f)).sort();
  const parts = [`engine:${ENGINE_VERSION}`];
  for (const file of files) {
    const source = await readFile(path.join(dir, file), "utf8");
    parts.push(`${file}:${source.length}:${sha256(source)}`);
  }
  return sha256(parts.join("\n"));
}
