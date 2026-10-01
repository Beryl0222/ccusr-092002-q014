import { loadBaseline } from "./baseline.js";
import { freshStore } from "./store.js";
import {
  addClarificationThread,
  listDisagreements,
  registerSource,
  resolveClarification,
  submitAssumption,
  supersedeSource
} from "./assumptions.js";
import {
  addDissent,
  buildInputSnapshot,
  createScenario,
  metricLineage,
  reproduceRun,
  runScenario
} from "./model.js";
import {
  bindRevisionScenario,
  castVote,
  discloseInterest,
  openRevision,
  proposeRelease,
  publishRelease,
  registerReviewer
} from "./governance.js";

/**
 * 假设审议与情景共识服务门面。所有数据均为机构级汇总：
 * 服务没有任何个人医护档案入口，指标血缘只回溯到机构假设与公开来源。
 */
export async function createApp({ store = freshStore(), now = new Date() } = {}) {
  const baseline = await loadBaseline();
  const clock = () => (typeof now === "function" ? now() : now);

  return {
    store,
    baseline,
    getBaseline: () => baseline,

    registerSource: (input) => registerSource(store, input),
    supersedeSource: (sourceId, replacementId) => supersedeSource(store, sourceId, replacementId),
    submitAssumption: (input) => submitAssumption(store, baseline, input, clock()),
    resolveClarification: (id, action, payload) => resolveClarification(store, baseline, id, action, payload, clock()),
    addClarificationThread: (id, orgType, message) => addClarificationThread(store, id, orgType, message),
    listClarifications: (status) => store.clarifications.filter((c) => !status || c.status === status),
    listAssumptions: (status) => [...store.assumptions.values()].filter((a) => !status || a.status === status),
    listDisagreements: () => listDisagreements([...store.assumptions.values()]),

    createScenario: (input) => createScenario(store, baseline, input, clock()),
    addDissent: (scenarioId, dissent) => addDissent(store, scenarioId, dissent, clock()),
    getScenario: (id) => store.scenarios.get(id) ?? null,
    listScenarios: () => [...store.scenarios.values()],

    runScenario: async (scenarioId, options) => runScenario(store, baseline, scenarioId, options ?? {}, clock()),
    getRun: (id) => store.runs.get(id) ?? null,
    listRuns: () => [...store.runs.values()],
    reproduceRun: (runId) => reproduceRun(store, runId, baseline),
    metricLineage: (runId, metric) => metricLineage(store, baseline, runId, metric),
    inputSnapshot: (assumptionIds) => buildInputSnapshot(store, baseline, assumptionIds),

    registerReviewer: (input) => registerReviewer(store, input),
    discloseInterest: (input) => discloseInterest(store, input, clock()),
    proposeRelease: async (input) => proposeRelease(store, baseline, input, clock()),
    castVote: (releaseId, input) => castVote(store, releaseId, input, clock()),
    publishRelease: async (releaseId) => publishRelease(store, releaseId, clock()),
    getProposal: (id) => store.release_proposals.get(id) ?? null,
    listReleases: () => [...store.releases.values()],
    getRelease: (id) => store.releases.get(id) ?? null,
    openRevision: (releaseId, input) => openRevision(store, releaseId, input, clock()),
    bindRevisionScenario: (revisionId, scenarioId) => bindRevisionScenario(store, revisionId, scenarioId, clock()),
    getRevision: (id) => store.revisions.get(id) ?? null,
    events: () => store.events
  };
}
