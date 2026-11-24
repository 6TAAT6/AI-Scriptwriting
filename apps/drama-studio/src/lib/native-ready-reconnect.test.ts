import { afterEach,expect,it,vi } from 'vitest'
import { StudioGateway } from './gateway'

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers()})

it('员工尚未原生就绪时即使前端已连接七秒，失败重连仍累积退避',async()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(.5)
  class Socket extends EventTarget{
    static OPEN=1;static CONNECTING=0;static CLOSED=3;static rows:Socket[]=[];readyState=0
    constructor(_url:string){super();Socket.rows.push(this)}
    send(_text:string){}
    open(){this.readyState=1;this.dispatchEvent(new Event('open'))}
    close(){this.readyState=3;this.dispatchEvent(new CloseEvent('close',{code:1011}))}
  }
  vi.stubGlobal('WebSocket',Socket)
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({profile:'account-a'})))
  const gateway=new StudioGateway()
  try{
    const start=gateway.start();await vi.advanceTimersByTimeAsync(0);Socket.rows[0].open();await start
    await vi.advanceTimersByTimeAsync(7000);Socket.rows[0].close()
    await vi.advanceTimersByTimeAsync(500);expect(Socket.rows).toHaveLength(2)
    Socket.rows[1].open();await vi.advanceTimersByTimeAsync(7000);Socket.rows[1].close()
    await vi.advanceTimersByTimeAsync(500);expect(Socket.rows).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(500);expect(Socket.rows).toHaveLength(3)
  }finally{gateway.stop()}
})

it('原生就绪并稳定后，下一次失败可回到首档退避',async()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(.5)
  class Socket extends EventTarget{
    static OPEN=1;static CONNECTING=0;static CLOSED=3;static rows:Socket[]=[];readyState=0
    constructor(_url:string){super();Socket.rows.push(this)}
    send(_text:string){}
    open(){this.readyState=1;this.dispatchEvent(new Event('open'))}
    ready(){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({jsonrpc:'2.0',method:'event',params:{type:'gateway.ready',payload:{}}})}))}
    close(){this.readyState=3;this.dispatchEvent(new CloseEvent('close',{code:1011}))}
  }
  vi.stubGlobal('WebSocket',Socket)
  vi.stubGlobal('fetch',async()=>new Response(JSON.stringify({profile:'account-a'})))
  const gateway=new StudioGateway()
  try{
    const start=gateway.start();await vi.advanceTimersByTimeAsync(0);Socket.rows[0].open();await start
    Socket.rows[0].close();await vi.advanceTimersByTimeAsync(500)
    Socket.rows[1].open();Socket.rows[1].ready()
    await vi.advanceTimersByTimeAsync(7000);Socket.rows[1].close()
    await vi.advanceTimersByTimeAsync(500);expect(Socket.rows).toHaveLength(3)
  }finally{gateway.stop()}
})
