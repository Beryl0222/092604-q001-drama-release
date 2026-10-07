/** 处理进程内 JSON 请求。 */
import { Service } from "./service.js";

const ACTIONS = {
  health: (service) => service.health(),
  register: (service, body) => service.register(String(body.recordId), String(body.ownerId)),
  find: (service, body) => service.find(String(body.recordId)),
  createSession: (service, body) => service.createSession(body),
  updateSessionStatus: (service, body) => service.updateSessionStatus(String(body.sessionId), String(body.status), body.by),
  freezeSession: (service, body) => service.freezeSession(String(body.sessionId), body.by),
  unfreezeSession: (service, body) => service.unfreezeSession(String(body.sessionId), body.by),
  sessionInfo: (service, body) => service.sessionInfo(String(body.sessionId)),
  createDocument: (service, body) => service.createDocument(body),
  submitVersion: (service, body) => service.submitVersion(body),
  lockVersion: (service, body) => service.lockVersion(String(body.versionId), body.by),
  submitReview: (service, body) => service.submitReview(body),
  versionInfo: (service, body) => service.versionInfo(String(body.versionId)),
  proposeTerm: (service, body) => service.proposeTerm(body),
  ratifyTerm: (service, body) => service.ratifyTerm(String(body.termId), body.by),
  termConsistency: (service, body) => service.termConsistency(String(body.versionId)),
  openDispute: (service, body) => service.openDispute(body),
  resolveDispute: (service, body) => service.resolveDispute(body),
  disputes: (service, body) => service.disputesFor(body),
  publishVersion: (service, body) => service.publishVersion(body),
  jobInfo: (service, body) => service.jobInfo(String(body.jobId)),
  withdrawVersion: (service, body) => service.withdrawVersion(body),
  rebindSession: (service, body) => service.rebindSession(body),
  rollbackSession: (service, body) => service.rollbackSession(body),
  rollbackDetails: (service, body) => service.rollbackDetails(String(body.rollbackId)),
  sessionFinal: (service, body) => service.sessionFinal(String(body.sessionId), body),
  sessionDiff: (service, body) => service.sessionDiff(String(body.sessionId), body.materialKind ?? null),
  expiringLicenses: (service, body) => service.expiringLicenses(String(body.sessionId)),
  listEvents: (service) => service.listEvents(),
};

export function handle(raw, service = new Service()) {
  const body = JSON.parse(raw);
  const action = ACTIONS[body.action];
  if (!action) throw new Error("不支持的请求动作");
  return JSON.stringify(action(service, body));
}
