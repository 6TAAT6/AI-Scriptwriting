interface RegionMember { id: string; organization?: 'chongqing' | 'hangzhou' | 'unassigned'; organization_policy?: boolean }
export interface RegionGroup<T> { id: 'chongqing' | 'hangzhou' | 'unassigned'; label: string; members: T[] }

// 使用账号标识保留地区归属，姓名修改不会影响人员分组。
const chongqingMembers = new Set([
  '18311314-470b-471f-a907-199af477d6cb',
  'd64dc6c0-9fc6-4c8f-911c-61957f4a4c63',
  '6c393c30-d527-4ce8-a3a1-b16e961ce737',
  'c7ca9715-8f4c-47bb-9e2f-111dad7397f5',
  '8d4f3a54-f513-40db-9afa-c36494f4e816',
  '1c2c7a40-fa40-43cc-8976-2343228410d2',
  'c8188a90-823d-4be8-a7ae-944f7a7a5796',
  '38cdb4be-9d49-4e55-8ab1-228b62f345b4',
  '5709ff89-bca5-4ccb-b862-7d3273d301fd',
  '5ad26313-6806-4c42-b711-3e79312eee35',
  '28682fdf-7bfc-4dea-bf79-9640bf6ecffc',
  '7a58a8ca-eb93-4b6e-9de5-16e973dcda86'
])

export function groupByRegion<T>(items: T[], identify: (item: T) => RegionMember): RegionGroup<T>[] {
  const chongqing: RegionGroup<T> = { id: 'chongqing', label: '重庆', members: [] }
  const hangzhou: RegionGroup<T> = { id: 'hangzhou', label: '横店', members: [] }
  const unassigned: RegionGroup<T> = { id: 'unassigned', label: '系统/测试', members: [] }
  for (const item of items) {
    const member = identify(item)
    const group = member.organization === 'chongqing' ? chongqing : member.organization === 'hangzhou' ? hangzhou
      : member.organization_policy || member.organization === 'unassigned' ? unassigned : chongqingMembers.has(member.id) ? chongqing : hangzhou
    group.members.push(item)
  }
  return unassigned.members.length ? [chongqing, hangzhou, unassigned] : [chongqing, hangzhou]
}
