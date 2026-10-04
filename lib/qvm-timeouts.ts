export const QVM_TIMEOUTS_MS = {
  dataLoad: 180_000,
  action: 300_000,
  provider: 30_000,
  ai: 180_000,
} as const;

export type QvmTimeoutKind = keyof typeof QVM_TIMEOUTS_MS;

export function qvmTimeoutMs(kind: QvmTimeoutKind) {
  return QVM_TIMEOUTS_MS[kind];
}
