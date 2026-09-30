// Typed error taxonomy. Mapped deterministically to HTTP responses in apps/api.
import { Data } from "effect"

export class NotAuthenticated extends Data.TaggedError("NotAuthenticated") {}
export class Forbidden extends Data.TaggedError("Forbidden") {}
export class BusinessNotFound extends Data.TaggedError("BusinessNotFound") {}
export class FactNotFound extends Data.TaggedError("FactNotFound") {}
export class FactAuthorityConflict extends Data.TaggedError("FactAuthorityConflict")<{
  readonly conflicts: ReadonlyArray<{ readonly a: string; readonly b: string }>
}> {}
export class InvalidFactValue extends Data.TaggedError("InvalidFactValue")<{
  readonly reason: string
}> {}
export class InvalidValidityWindow extends Data.TaggedError("InvalidValidityWindow")<{
  readonly reason: string
}> {}
export class QuestionNotFound extends Data.TaggedError("QuestionNotFound") {}
export class CheckRunNotFound extends Data.TaggedError("CheckRunNotFound") {}
export class ProviderRateLimited extends Data.TaggedError("ProviderRateLimited")<{
  readonly detail?: string
}> {}
export class ProviderAuthenticationFailed extends Data.TaggedError("ProviderAuthenticationFailed") {}
export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly detail?: string
}> {}
export class ProviderTimeout extends Data.TaggedError("ProviderTimeout") {}
export class ProviderMalformedResponse extends Data.TaggedError("ProviderMalformedResponse")<{
  readonly detail?: string
}> {}
export class WorkerFailed extends Data.TaggedError("WorkerFailed")<{
  readonly detail?: string
}> {}
export class WorkerContractMismatch extends Data.TaggedError("WorkerContractMismatch")<{
  readonly detail?: string
}> {}
export class ObservationNotFound extends Data.TaggedError("ObservationNotFound") {}
export class ClaimNotFound extends Data.TaggedError("ClaimNotFound") {}
export class JudgmentNotFound extends Data.TaggedError("JudgmentNotFound") {}

export const httpStatusFor = (tag: string): number => {
  switch (tag) {
    case "NotAuthenticated":
      return 401
    case "Forbidden":
      return 403
    case "BusinessNotFound":
    case "FactNotFound":
    case "QuestionNotFound":
    case "CheckRunNotFound":
    case "ObservationNotFound":
    case "ClaimNotFound":
    case "JudgmentNotFound":
      return 404
    case "FactAuthorityConflict":
    case "InvalidFactValue":
    case "InvalidValidityWindow":
      return 422
    case "ProviderRateLimited":
      return 429
    case "ProviderAuthenticationFailed":
      return 502
    case "ProviderUnavailable":
    case "ProviderTimeout":
    case "ProviderMalformedResponse":
    case "WorkerFailed":
    case "WorkerContractMismatch":
      return 502
    default:
      return 500
  }
}
