/** 其他业务测试按正式流程激活员工，不绕过新登录规则。 */
export async function fixtureActivationCode(store, username, rootPassword) {
  const user = store.listUsers().find(row => row.username === username)
  if (!user?.activation_required) return undefined
  const session = await store.login('root', rootPassword)
  const auth = { ...store.authenticate(session.token), token: session.token }
  try { return (await store.generateActivationCode(auth)).code }
  finally { await store.logout(session.token) }
}
