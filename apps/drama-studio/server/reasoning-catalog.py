"""读取原生推理档位定义，不连接模型或返回任何凭证。"""
import json
from pathlib import Path
import re
import sys


def enrich(catalog, home):
    from agent.model_metadata import openai_model_rejects_reasoning
    from agent.reasoning_effort import EFFORT_LADDER, codex_supported_efforts, model_id_encodes_reasoning_effort
    from hermes_cli.config import read_user_config_raw

    config = read_user_config_raw(Path(home) / "config.yaml")
    configured = config.get("providers") or {}
    images = (config.get("image_gen") or {}).get("studio_endpoints") or {}
    for row in catalog.get("providers") or []:
        slug = str(row.get("slug", "")).removeprefix("custom:")
        provider = configured.get(slug, {})
        row["image_models"] = list(images.get(slug, {}).get("models") or [])
        row["image_model"] = images.get(slug, {}).get("model", "")
        mode = provider.get("api_mode") or provider.get("transport")
        capabilities = row.setdefault("capabilities", {})
        for model in row.get("models") or []:
            caps = dict(capabilities.get(model) or {})
            metadata = (provider.get("models") or {}).get(model, {}) if isinstance(provider.get("models"), dict) else {}
            declared = metadata.get("supported_efforts", caps.get("supported_efforts"))
            efforts = [level for level in EFFORT_LADDER if level != "ultra" and isinstance(declared, list) and level in declared]
            bare = model.lower().rsplit("/", 1)[-1]
            if model_id_encodes_reasoning_effort(model) and not efforts and mode == "chat_completions":
                efforts = ["none", "low", "medium", "high", "xhigh"]
            elif not efforts and mode in {"codex_responses", "responses", "chat_completions"} and re.match(r"^(gpt-[56](?:[.-]|$)|o[134](?:[.-]|$))", bare):
                efforts = list(codex_supported_efforts(model))
            if (not efforts
                    and not isinstance(declared, list) and mode == "chat_completions" and caps.get("reasoning") is not False):
                # 兼容接口的原生目录不列档位，不能把缺少元数据误判为禁止调节。
                efforts = ["low", "medium", "high"]
            if (caps.get("reasoning") is False and not metadata.get("supported_efforts")) or openai_model_rejects_reasoning(model):
                efforts = []
            if caps.get("can_disable_reasoning") is False:
                efforts = [level for level in efforts if level != "none"]
            caps.update(supported_efforts=efforts, reasoning=bool(efforts), can_disable_reasoning="none" in efforts)
            if metadata.get('default_reasoning_effort') in efforts:
                caps['default_reasoning_effort'] = metadata['default_reasoning_effort']
            if isinstance(metadata.get('context_length'), int) and metadata['context_length'] > 0:
                caps['context_length'] = metadata['context_length']
            capabilities[model] = caps
    return catalog


if __name__ == "__main__":
    print(json.dumps(enrich(json.load(sys.stdin), sys.argv[1]), ensure_ascii=False))
