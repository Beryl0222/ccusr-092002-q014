import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fingerprint } from "./util.js";

const DEFAULT_CONTRACT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "contracts",
  "workforce_scenario.json",
);

/**
 * 以 contracts/workforce_scenario.json 的目标与统计定义为公共基线。
 * 所有提交、情景与发布都引用同一基线编号及其指纹；
 * 基线变更必须通过新版本契约进行，已发布快照仍指向旧指纹。
 */
export async function loadBaseline(contractPath = DEFAULT_CONTRACT) {
  const raw = await readFile(contractPath, "utf8");
  const contract = JSON.parse(raw);
  const b = contract.baseline;
  const variables = new Map(b.variables.map((v) => [v.key, v]));
  return {
    contract,
    ...b,
    contract_path: contractPath,
    contract_fingerprint: fingerprint({
      baseline_id: b.baseline_id,
      baseline_year: b.baseline_year,
      target_year: b.target_year,
      definitions: b.definitions,
      national_targets: b.national_targets,
      canonical_units: b.canonical_units,
      variables: b.variables,
      region_taxonomy: b.region_taxonomy,
      temporal_policy: b.temporal_policy,
      citation_policy: b.citation_policy,
      confidence_policy: b.confidence_policy,
      metrics: b.metrics,
    }),
    variables,
  };
}

export { DEFAULT_CONTRACT, pathToFileURL };
