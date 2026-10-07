/** 角色定义与权限校验。 */
import { DomainError, ErrorCode } from "./errors.js";

export const Role = {
  CREATOR: "creator", // 主创：锁定普通措辞版本、裁决措辞争议
  TRANSLATOR: "translator", // 翻译：提交译稿
  HISTORY_ADVISOR: "history_advisor", // 史实顾问：复核史实改动、裁决史实争议、判定史实影响
  STAGE_MANAGER: "stage_manager", // 演出经理：排期、钉版、发布、冻结与撤回
};

export function memberLabel(role) {
  return {
    [Role.CREATOR]: "主创",
    [Role.TRANSLATOR]: "翻译",
    [Role.HISTORY_ADVISOR]: "史实顾问",
    [Role.STAGE_MANAGER]: "演出经理",
  }[role] || role;
}

export function requireRole(member, roles) {
  const wanted = Array.isArray(roles) ? roles : [roles];
  if (!member || !wanted.some((r) => member.roles.includes(r))) {
    throw new DomainError(
      ErrorCode.FORBIDDEN,
      `该操作需要以下角色之一: ${wanted.map(memberLabel).join("、")}`,
      { required: wanted, actual: member ? member.roles : [] },
    );
  }
}
