export interface ObservedSelection { runtimeId: string; storedId: string }

/** 只上报页面实际选中值；观测失败不能影响恢复、切换或生成。 */
export class SelectionObserver {
  private selected: ObservedSelection = { runtimeId: '', storedId: '' }
  private generation = 0

  constructor(private readonly connected: () => boolean,
    private readonly send: (params: Record<string, unknown>) => Promise<unknown>) {}

  select(value: ObservedSelection) {
    this.selected = { runtimeId: value.runtimeId, storedId: value.storedId }
    this.flush()
  }

  flush() {
    if (!this.connected()) return
    const selected = this.selected
    void this.send({ generation: ++this.generation,
      runtime_id: selected.runtimeId || null, stored_session_id: selected.storedId || null }).catch(() => {})
  }

  reset() { this.selected = { runtimeId: '', storedId: '' } }
}
