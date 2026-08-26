export class AuditBoth {}
export interface AuditType {
  readonly value: string;
}
export const AuditValue = 1;

export function AuditMerged(): void {}
export declare namespace AuditMerged {
  type Member = string;
}

export declare namespace AuditDeclaredNamespace {
  type Member = string;
}

export default class AuditDefault {}
