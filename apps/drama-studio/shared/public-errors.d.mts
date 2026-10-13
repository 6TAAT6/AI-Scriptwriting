export function publicError(value: unknown, fallback?: string): string
export function publicRuntimeFailure(value: unknown): string
export function errorEventPayload(type: string, payload: Record<string, unknown>): Record<string, unknown>
