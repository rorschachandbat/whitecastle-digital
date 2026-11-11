"""读取本地网页导出的存档，输出策略候选及条件续行；不把策略权重冒充胜率。"""
import argparse
import json
from pathlib import Path

import torch

from ai_model import ROOT, RulesProcess, infer, load_checkpoint


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("save", type=Path)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--top", type=int, default=5)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--catalog")
    parser.add_argument("--weights")
    args = parser.parse_args()
    if args.top < 1 or args.out.exists():
        parser.error("top >= 1; output must not exist")
    torch.set_num_threads(2)
    save = json.loads(args.save.read_text(encoding="utf-8"))
    with RulesProcess(args.catalog, args.weights) as rules:
        meta = rules.request(op="info")
        model, _ = load_checkpoint(args.model, meta)
        observation = rules.request(op="load", save=save)
        if observation["done"]:
            raise ValueError("AI_POSITION_FINISHED")
        actor = observation["actor"]
        with torch.no_grad():
            logits, value = infer(model, observation)
            weights = logits.softmax(-1)
        count = observation["completedActions"]
        candidates = []
        for index in weights.argsort(descending=True)[:args.top].tolist():
            current = rules.request(op="load", save=save)
            continuation = []
            chosen = index
            while not current["done"] and current["completedActions"] == count:
                continuation.append({"index": chosen, "choice": current["choices"][chosen]})
                current = rules.request(op="step", index=chosen)
                if not current["done"] and current["completedActions"] == count:
                    with torch.no_grad():
                        next_logits, _ = infer(model, current)
                        chosen = next_logits.argmax().item()
            replay = rules.request(op="replay")
            candidates.append({"index": index, "policyWeight": weights[index].item(),
                               "choice": observation["choices"][index], "continuation": continuation,
                               "completedAction": replay["actions"][count]})
        result = {"meta": meta, "actor": actor, "model": str(args.model), "method": "policy-only",
                  "rawValue": value.item(), "candidates": candidates,
                  "limitations": ["not-win-probability", "not-mcts", "atomic-action-ranking",
                                  "local-replay-only", "unvalidated-playing-strength"]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(args.out), "method": "policy-only", "candidates": len(candidates)}))


if __name__ == "__main__":
    main()
