/**
 * 测试辅助：构造通过门禁的完整假设集。
 */
export const HOSPITAL = { constituency: "hospital", org: "测试医院联合体" };
export const PRIMARY = { constituency: "primary_care", org: "测试基层网络" };
export const EDU = { constituency: "education", org: "测试教育部门" };
export const FINANCE = { constituency: "finance", org: "测试财政部门" };

const SRC = { title: "测试统计资料", publisher: "测试机构", year: 2025 };

export function assumption(overrides = {}) {
  return {
    variable: "retirement_rate",
    workforce: "physicians",
    region: "CN",
    year_start: 2026,
    year_end: 2030,
    point: 0.025,
    ci: { low: 0.02, high: 0.035 },
    unit: "fraction_per_year",
    source: { ...SRC },
    submitter: HOSPITAL,
    ...overrides,
  };
}

/** 提交某地区某支队伍完整六变量，返回 id 列表。 */
export function submitFullSet(gate, { region = "CN", workforce = "physicians", submitter = {}, stock = 4000000 } = {}) {
  const s = { ...HOSPITAL, ...submitter };
  const defs = [
    {
      variable: "stock", year_start: 2025, year_end: 2025, point: stock,
      ci: { low: stock * 0.96, high: stock * 1.04 }, unit: "persons", submitter: s,
    },
    {
      variable: "retirement_rate", point: 0.025, ci: { low: 0.02, high: 0.035 },
      unit: "fraction_per_year", submitter: s,
    },
    {
      variable: "training_intake", point: 500000, ci: { low: 450000, high: 550000 },
      unit: "persons_per_year", submitter: { ...EDU, ...submitter },
    },
    {
      variable: "completion_rate", point: 0.55, ci: { low: 0.48, high: 0.62 },
      unit: "fraction", submitter: { ...EDU, ...submitter },
    },
    {
      variable: "net_inflow_rate", point: 0, ci: { low: 0, high: 0 },
      unit: "fraction_per_year", submitter: { ...PRIMARY, ...submitter },
    },
    {
      variable: "efficiency_index", point: 1, ci: { low: 0.94, high: 1.08 },
      unit: "index_2025_1", submitter: { ...FINANCE, ...submitter },
    },
  ];
  return defs.map((d) =>
    gate.submit(
      assumption({ workforce, region, year_start: 2026, year_end: 2030, source: { ...SRC }, ...d }),
    ).id,
  );
}
