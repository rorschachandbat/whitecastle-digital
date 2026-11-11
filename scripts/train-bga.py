"""用已核对的BGA选牌决策微调现有策略，同时复习本地样本；另存模型，不覆盖持续训练。"""
import argparse
import copy
import hashlib
import importlib.util
import json
import random
import time
from pathlib import Path

import torch
from torch import nn
from ai_model import ROOT, RulesProcess, batch_tensors, load_checkpoint, save_checkpoint

SPEC = importlib.util.spec_from_file_location("bga_train_policy", ROOT / "scripts/train-policy.py")
TRAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAIN)


def split_bga(rows):
    """桌号稳定分区，新增玩家或增加回放后不会把原验证桌号移进训练集。"""
    held_out = {row["game"] for row in rows
                if int(hashlib.sha256(row["game"].encode()).hexdigest()[:8], 16) % 4 == 0}
    train = [row for row in rows if row["game"] not in held_out]
    validation = [row for row in rows if row["game"] in held_out]
    if len({row["game"] for row in train}) < 3 or len(held_out) < 1:
        raise ValueError("AI_BGA_NEED_MORE_TRAIN_AND_VALIDATION_TABLES")
    return train, validation, sorted(held_out)


def mixed_loss(model, rows):
    logits, values = model(*batch_tensors(rows))
    labels = torch.tensor([row["teacher"] for row in rows])
    targets = torch.tensor([row["z"] for row in rows], dtype=torch.float32)
    weights = torch.tensor([row.get("valueWeight", 1) for row in rows], dtype=torch.float32)
    policy = nn.functional.cross_entropy(logits, labels)
    value = ((values - targets).square() * weights).sum() / weights.sum().clamp_min(1)
    return policy + 0.25 * value


@torch.no_grad()
def policy_metrics(model, rows):
    model.eval()
    loss = correct = count = 0
    for offset in range(0, len(rows), 64):
        batch = rows[offset:offset + 64]
        logits, _ = model(*batch_tensors(batch))
        labels = torch.tensor([row["teacher"] for row in batch])
        loss += nn.functional.cross_entropy(logits, labels, reduction="sum").item()
        nontrivial = torch.tensor([len(row["candidates"]) > 1 for row in batch])
        correct += ((logits.argmax(-1) == labels) & nontrivial).sum().item()
        count += nontrivial.sum().item()
    return {"policyLoss": loss / len(rows), "teacherTop1Nontrivial": correct / max(1, count),
            "nontrivialDecisions": count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--base-data", type=Path, default=ROOT / ".local/ai/guide-r4.jsonl.gz")
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=4)
    parser.add_argument("--catalog")
    parser.add_argument("--weights")
    args = parser.parse_args()
    if args.epochs < 1:
        parser.error("epochs >= 1")
    if (args.out_dir / "imitation.pt").exists() or (args.out_dir / "training-report.json").exists():
        raise ValueError("AI_OUTPUT_EXISTS")
    started = time.monotonic()
    torch.set_num_threads(2)
    torch.manual_seed(17)
    rng = random.Random(17)
    rows, meta, dimensions = TRAIN.load_dataset(args.input, allow_partial=True)
    manifest = json.loads(Path(str(args.input) + ".report.json").read_text(encoding="utf-8"))
    if manifest.get("datasetFormat") != "bga-verified-draft-v1":
        raise ValueError("AI_BGA_EXPECTED_PARTIAL_DATA")
    rehearsal, base_meta, base_dimensions = TRAIN.load_dataset(args.base_data)
    with RulesProcess(args.catalog, args.weights) as rules:
        if meta != rules.request(op="info") or meta != base_meta or dimensions != base_dimensions:
            raise ValueError("AI_DATA_CONFIG_MISMATCH")
    model, checkpoint = load_checkpoint(args.checkpoint, meta)
    if (model.state_size, model.option_size) != dimensions:
        raise ValueError("AI_RESUME_DIMENSION_MISMATCH")
    train, validation, validation_games = split_bga(rows)
    if set(validation_games) & set(checkpoint.get("seenGames", [])):
        raise ValueError("AI_BGA_BASELINE_ALREADY_SAW_VALIDATION")
    base_validation_games = set(checkpoint.get("bgaBaseValidationGames", []))
    base_train, base_validation, base_held_out = TRAIN.split_games(rehearsal, random.Random(7))
    if base_validation_games and base_validation_games != set(base_held_out):
        raise ValueError("AI_BGA_REHEARSAL_SPLIT_CHANGED")
    optimizer = torch.optim.Adam(model.parameters(), lr=0.0001)
    before = {"bga": policy_metrics(model, validation), "local": policy_metrics(model, base_validation)}
    best_loss = before["bga"]["policyLoss"]
    best_state = copy.deepcopy(model.state_dict())
    best_epoch = 0
    history = []
    for epoch in range(args.epochs):
        model.train()
        rng.shuffle(train)
        for offset in range(0, len(train), 8):
            # 每批最多8条真人选牌与24条本地决策；真人样本不监督价值头。
            batch = train[offset:offset + 8] + rng.sample(base_train, min(24, len(base_train)))
            loss = mixed_loss(model, batch)
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1)
            optimizer.step()
        result = {"epoch": epoch + 1, "bga": policy_metrics(model, validation),
                  "local": policy_metrics(model, base_validation)}
        history.append(result)
        if result["bga"]["policyLoss"] < best_loss:
            best_loss = result["bga"]["policyLoss"]
            best_state = copy.deepcopy(model.state_dict())
            best_epoch = epoch + 1
        print(json.dumps(result), flush=True)
    model.load_state_dict(best_state)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    scope = {"scope": "starting-draft-only", "valueSupervision": False,
             "fullBgaGamesReplayed": False, "teacherPlayers": manifest["teacherPlayers"]}
    save_checkpoint(args.out_dir / "imitation.pt", model, meta, phase="bga-draft-adaptation",
                    seenGames=sorted(set(checkpoint.get("seenGames", [])) | {row["game"] for row in train}
                                     | {row["game"] for row in base_train}),
                    bgaValidationGames=validation_games, bgaBaseValidationGames=base_held_out,
                    bgaAdaptation=scope, selfplayTotal=checkpoint.get("selfplayTotal", 0))
    load_checkpoint(args.out_dir / "imitation.pt", meta)
    loop_config = json.loads((ROOT / "data/ai-training-loop.json").read_text(encoding="utf-8"))
    loop_config.update(input=str(args.base_data.resolve()), initialCheckpoint=str((args.out_dir / "imitation.pt").resolve()),
                       catalog=args.catalog, weights=args.weights, prefix="ai-bga-" + args.out_dir.name[-20:])
    (args.out_dir / "next-loop-config.json").write_text(json.dumps(loop_config, indent=2), encoding="utf-8")
    report = {"meta": meta, **scope, "checkpoint": str(args.checkpoint.resolve()),
              "dataset": str(args.input.resolve()), "datasetSha256": manifest["datasetSha256"],
              "trainDecisions": len(train), "validationDecisions": len(validation),
              "trainGames": sorted({row["game"] for row in train}), "validationGames": validation_games,
              "before": before, "after": {"bga": policy_metrics(model, validation),
                                         "local": policy_metrics(model, base_validation)},
              "bestEpoch": best_epoch, "history": history, "seconds": time.monotonic() - started,
              "strengthEvaluated": False, "promotedToChampion": False}
    (args.out_dir / "training-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"checkpoint": str(args.out_dir / "imitation.pt"), "bestEpoch": best_epoch,
                      "seconds": report["seconds"], "strengthEvaluated": False}), flush=True)


if __name__ == "__main__":
    main()
