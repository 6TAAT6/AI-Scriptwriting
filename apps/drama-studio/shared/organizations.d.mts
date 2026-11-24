export type OrganizationId = 'hangzhou' | 'chongqing' | 'unassigned'
export const ORGANIZATIONS: Readonly<Record<OrganizationId, string>>
export const organizationIds: readonly OrganizationId[]
export function validOrganization(value: unknown): value is OrganizationId
export function validScope(value: unknown): value is OrganizationId[]
export function authorizedOrganizations(actor: { role: string } | null | undefined): OrganizationId[]
