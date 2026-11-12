"""只加载持续训练冠军，校验编码指纹后输出主网络策略，不输出未校准价值。"""
import argparse
import json
import sys
from pathlib import Path

import torch

from ai_model import META_KEYS, infer, load_checkpoint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", type=Path, required=True)
    args = parser.parse_args()
    request = json.load(sys.stdin)
    state = json.loads((args.loop / "loop-state.json").read_text(encoding="utf-8"))
    if any(state["meta"].get(key) != request["meta"].get(key) for key in META_KEYS):
        raise ValueError("AI_MODEL_CONFIG_MISMATCH")
    # 只解析此循环自己的冠军；复制分支后旧绝对路径按目录内相对尾部定位。
    champion = Path(state["champion"])
    parts = str(champion).replace("\\", "/").split("/")
    checkpoint_path = args.loop / parts[-2] / parts[-1]
    if parts[-1] != "candidate.pt" or not parts[-2].startswith("generation-"):
        raise ValueError("AI_CHAMPION_INVALID")
    torch.set_num_threads(2)
    model, _ = load_checkpoint(checkpoint_path, request["meta"])
    observation = request["observation"]
    if len(observation["state"]) != model.state_size or not observation["candidates"]:
        raise ValueError("AI_FEATURE_SIZE")
    if any(len(option) != model.option_size for option in observation["candidates"]):
        raise ValueError("AI_FEATURE_SIZE")
    with torch.inference_mode():
        logits, _ = infer(model, observation)
        policy = logits.softmax(-1)
    if not bool(torch.isfinite(policy).all()):
        raise ValueError("AI_NONFINITE_POLICY")
    print(json.dumps({"model": parts[-2], "source": "continuous-champion",
                      "method": "policy-only", "policy": policy.tolist()}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # 不把本机路径、权重内容或原始输入回传到浏览器。
        print(json.dumps({"error": str(error).split(":")[0]
                          if str(error).startswith("AI_") else "AI_INFERENCE_FAILED"}))
        sys.exit(1)
