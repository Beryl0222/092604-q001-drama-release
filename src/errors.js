/** 领域错误：携带机器可读代码，便于接口层映射。 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

export const ErrorCode = {
  NOT_FOUND: "NOT_FOUND",
  ALREADY_EXISTS: "ALREADY_EXISTS",
  CONFLICT: "CONFLICT",
  VALIDATION: "VALIDATION",
  FORBIDDEN: "FORBIDDEN",
  FROZEN: "FROZEN",
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  WRONG_STATE: "WRONG_STATE",
};
