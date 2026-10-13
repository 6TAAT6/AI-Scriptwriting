import { createInferenceBroker } from '../inference-broker.mjs'
const broker = await createInferenceBroker({ baseUrl: process.argv[2], apiKey: 'fixture-upstream-key', models: ['gemini-3.8-flash-high'], defaultModel: 'gemini-3.8-flash-high', apiMode: 'chat_completions' })
console.log(JSON.stringify(broker.scope('native-child-fixture')))
process.once('SIGTERM', () => { void broker.close().then(() => process.exit(0)) })
