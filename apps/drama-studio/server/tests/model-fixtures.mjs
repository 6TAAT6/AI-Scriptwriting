/** 模拟原生真实目录握手，使用默认品牌绑定，不绕过品牌选择校验。 */
const model='gemini-pro-agent'
export function fixtureModelEndpoints(req,res,extra=[]){
  if(new URL(req.url,'http://localhost').pathname!=='/api/studio/model-endpoints')return false
  res.setHeader('content-type','application/json')
  res.end(JSON.stringify({endpoints:[{id:'fixture-provider',name:'隔离测试接入',is_current:true,models:[model]},...extra]}))
  return true
}
export function fixtureModelCatalog(profile,catalog={providers:[]}){
  const result=structuredClone(catalog),slug=profile==='jubao-drama'?'fixture-provider':'studio-inference'
  const row=result.providers.find(row=>row.slug===slug)
  if(row)row.models=[...new Set([model,...row.models])]
  else result.providers.push({slug,aliases:[],name:'隔离测试接入',authenticated:true,models:[model],image_models:[]})
  return {...result,model,provider:slug}
}
