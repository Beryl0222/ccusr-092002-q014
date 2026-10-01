/**
 * 隐私红线：本服务只接受聚合统计假设，任何个人医护档案字段一律拒收，
 * 决策者只接触汇总指标，不接触可识别到个人的医护档案。
 */

const FORBIDDEN_KEY_PATTERNS = [
  /身份证/,
  /(^|_)id_?card(_|$)/i,
  /identity_?no/i,
  /证件号/,
  /病历/,
  /medical_?record/i,
  /record_?no/i,
  /patient/i,
  /就诊/,
  /住院号/,
  /处方/,
  /个人档案/,
];

// 18 位居民身份证号（末位可为 X）
const ID_CARD_VALUE = /\b\d{17}[\dXx]\b/;
const FORBIDDEN_VALUE_PATTERNS = [/身份证号/, /病历号/, ID_CARD_VALUE];

/**
 * 递归扫描提交内容。
 * @returns {Array<{path:string,reason:string}>} 命中的个人档案字段
 */
export function scanPersonalRecords(payload, path = "$") {
  const hits = [];
  if (payload === null || payload === undefined) return hits;

  if (typeof payload === "object" && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      const next = `${path}.${key}`;
      if (FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key))) {
        hits.push({ path: next, reason: "疑似个人医护档案标识字段" });
      }
      hits.push(...scanPersonalRecords(value, next));
    }
    return hits;
  }
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => hits.push(...scanPersonalRecords(item, `${path}[${i}]`)));
    return hits;
  }
  if (typeof payload === "string") {
    for (const re of FORBIDDEN_VALUE_PATTERNS) {
      if (re.test(payload)) {
        hits.push({ path, reason: "字段值疑似可识别个人身份信息" });
        break;
      }
    }
  }
  return hits;
}

export class PrivacyViolation extends Error {
  constructor(hits) {
    super("提交内容包含个人医护档案字段，聚合假设服务拒绝接收");
    this.code = "PRIVACY_VIOLATION";
    this.hits = hits;
  }
}

export function assertNoPersonalRecords(payload) {
  const hits = scanPersonalRecords(payload);
  if (hits.length > 0) throw new PrivacyViolation(hits);
}
