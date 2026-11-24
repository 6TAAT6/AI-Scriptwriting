export const ORGANIZATIONS = Object.freeze({ hangzhou: '横店', chongqing: '重庆', unassigned: '系统/测试' })
export const organizationIds = Object.freeze(Object.keys(ORGANIZATIONS))
export const validOrganization = value => typeof value === 'string' && Object.hasOwn(ORGANIZATIONS, value)
export const validScope = value => Array.isArray(value) && value.every(validOrganization) && new Set(value).size === value.length

export function authorizedOrganizations(actor) {
  return ['super_admin', 'admin'].includes(actor?.role) ? [...organizationIds] : []
}
