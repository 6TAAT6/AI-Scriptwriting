import type { IncomingMessage, ServerResponse } from 'node:http'
export function staticBoundary(request: IncomingMessage, response: ServerResponse, next: () => void): void
