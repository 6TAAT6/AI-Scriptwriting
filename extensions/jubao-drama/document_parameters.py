"""仅标识可由工具调用方修正的读取起点和大小，不代表权限或文件状态。"""


class ReadParameterError(ValueError):
    """调整读取参数即可继续，无需用户重新授权。"""


class UnsupportedSheetError(ReadParameterError):
    """已校验可读的非工作簿文件误带工作表参数，可保留路径和分页参数纠正。"""
