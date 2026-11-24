"""有实际来源的续写补充世界一致性审查；世界观与人物的权威依据见设定库（story_bible）。"""
from copy import deepcopy


def source_world_requirements(contract,reads):
    """有实际来源的续写显式检查新增世界规则，不能仅检查几个修仙禁词。"""
    if not reads or not (contract.get('current_task') or {}).get('creative'):
        return contract
    result=deepcopy(contract)
    scope=(contract.get('current_task') or {}).get('episode_range')
    result['active_requirements'].append({'id':'source-world-continuity','kind':'source_world_continuity',
        'value':'对照真实source_evidence逐项列查新出现的身份、能力、种族生理、药物因果、疗法、物品功能与制度权限。用户未授权扩大规则时，来源未建立的新机制不能用来解释旧伏笔；未知应保留未知，可新增正常动作对白与选择，不可冒充来源事实。人物收费、承诺、物权和证据结论须有一致因果。',
        'scope':{'lifetime':'turn','episodes':scope,'document_id':None},'status':'active','origin':'source_consistency_policy',
        'source_turn_id':contract['turn_id'],'quote':'依据用户要求采用本轮指定的实际来源，保持已确认世界和人物因果。'})
    return result
