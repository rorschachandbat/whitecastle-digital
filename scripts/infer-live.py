"""只加载持续训练冠军，校验编码指纹后输出主网络策略，不输出未校准价值。"""
import argparse
import json
import re
import sys
from pathlib import Path

import torch

from ai_model import META_KEYS, infer, load_checkpoint


def champion_checkpoint(loop, state, generation):
    """只接受循环目录内的候选或初始模仿检查点，不跟随外部路径。"""
    loop = loop.resolve()
    if generation is None:
        parts = str(state["champion"]).replace("\\", "/").split("/")
        if parts[-2:] == ["initial", "imitation.pt"]:
            generation = "initial"
        else:
            if len(parts) < 2 or parts[-1] != "candidate.pt":
                raise ValueError("AI_CHAMPION_INVALID")
            generation = parts[-2]
    if generation != "initial" and not re.fullmatch(r"generation-\d{5}", generation or ""):
        raise ValueError("AI_CHAMPION_INVALID")
    checkpoint = (loop / ("initial/imitation.pt" if generation == "initial" else f"{generation}/candidate.pt")).resolve()
    if loop not in checkpoint.parents or not checkpoint.is_file():
        raise ValueError("AI_CHAMPION_INVALID")
    return checkpoint, generation


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", type=Path, required=True)
    parser.add_argument("--generation", default=None)
    parser.add_argument("--stream", action="store_true")
    parser.add_argument("--allow-legacy-setup", action="store_true")
    parser.add_argument("--allow-feature-compat", action="store_true")
    args = parser.parse_args()
    request = json.loads(sys.stdin.readline()) if args.stream else json.load(sys.stdin)
    state = json.loads((args.loop / "loop-state.json").read_text(encoding="utf-8"))
    keys = [key for key in META_KEYS if not (args.allow_legacy_setup and key == "setupVersion")]
    if args.allow_feature_compat:
        if state["meta"].get("featureVersion") not in ("public-decisions-v2", "public-decisions-v3"):
            raise ValueError("AI_MODEL_CONFIG_MISMATCH")
        keys = [key for key in keys if key not in ("featureVersion", "encoderHash")]
    if any(state["meta"].get(key) != request["meta"].get(key) for key in keys):
        raise ValueError("AI_MODEL_CONFIG_MISMATCH")
    # 指定代数时固定该检查点；未指定时仍只解析当前冠军的目录内相对尾部。
    checkpoint_path, generation = champion_checkpoint(args.loop, state, args.generation)
    torch.set_num_threads(2)
    # 兼容旧冠军时只跳过编码版本；其余元数据仍核对，避免静默混用目录或启发式。
    model, checkpoint = load_checkpoint(checkpoint_path)
    if args.allow_feature_compat and (model.state_size != 2345 or model.option_size != 160
                                     or checkpoint["meta"] != state["meta"]):
        raise ValueError("AI_MODEL_CONFIG_MISMATCH")
    for key in keys:
        if checkpoint["meta"].get(key) != request["meta"].get(key):
            raise ValueError(f"AI_MODEL_CONFIG_MISMATCH:{key}")
    while True:
        if any(state["meta"].get(key) != request["meta"].get(key) for key in keys):
            raise ValueError("AI_MODEL_CONFIG_MISMATCH")
        observations = request.get("observations") or [request["observation"]]
        if not 1 <= len(observations) <= 12:
            raise ValueError("AI_FEATURE_SIZE")
        policies = []
        with torch.inference_mode():
            for observation in observations:
                if len(observation["state"]) != model.state_size or not observation["candidates"]:
                    raise ValueError("AI_FEATURE_SIZE")
                if any(len(option) != model.option_size for option in observation["candidates"]):
                    raise ValueError("AI_FEATURE_SIZE")
                logits, _ = infer(model, observation)
                policies.append(logits.softmax(-1))
            policy = torch.stack(policies).mean(0)
        if not bool(torch.isfinite(policy).all()):
            raise ValueError("AI_NONFINITE_POLICY")
        print(json.dumps({"model": generation, "source": "continuous-champion",
                          "method": "policy-only", "policy": policy.tolist()}), flush=True)
        if not args.stream:
            break
        line = sys.stdin.readline()
        if not line:
            break
        request = json.loads(line)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # 不把本机路径、权重内容或原始输入回传到浏览器。
        print(json.dumps({"error": str(error).split(":")[0]
                          if str(error).startswith("AI_") else "AI_INFERENCE_FAILED"}))
        sys.exit(1)
