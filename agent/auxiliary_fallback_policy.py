"""辅助任务可禁止隐式主模型回退，显式备用链继续按原顺序处理。"""
from collections.abc import Mapping


def main_model_fallback_allowed(task_config: Mapping) -> bool:
    # 默认兼容既有任务；显式关闭或格式错误都不能意外放行到主会话连接。
    return task_config.get('allow_main_model_fallback', True) is True
