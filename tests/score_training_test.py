"""终局高分奖励、搜索采样与晋级目标回归；不执行项目编译。"""
import gzip
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from ai_model import PolicyValue, META_KEYS, REWARD_VERSION, infer, load_checkpoint


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


TRAIN = module("score_train", "train-policy.py")
LOOP = module("score_loop", "train-loop.py")


class FakeRules:
    def request(self, op, **kwargs):
        if op == "search":
            return {"policy": [0.25, 0.75], "searched": True, "nodes": 4}
        if op == "reset":
            self.step = 0
        elif op == "step":
            self.step += 1
        if self.step == 2:
            return {"done": True, "placements": 18, "decisions": 2,
                    "score": {"complete": True, "winner": "1",
                              "players": {"0": {"total": 60}, "1": {"total": 95}}}}
        return {"done": False, "actor": str(self.step), "state": [0.2, 0.3],
                "candidates": [[1, 0], [0, 1]], "heuristic": [0, 1], "request": "root"}


class ScoreTests(unittest.TestCase):
    def test_both_seats_learn_own_score_even_when_losing_and_above_eighty(self):
        meta = {key: "test" for key in META_KEYS}
        meta["rewardVersion"] = REWARD_VERSION
        model = PolicyValue(2, 2)
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            result = TRAIN.reinforce(model, optimizer, FakeRules(), 1, "score-test", folder / "model.pt",
                                     meta, set(), experience_dir=folder / "experience",
                                     search_config={"width": 2})
            shard = next((folder / "experience").glob("*.jsonl.gz"))
            with gzip.open(shard, "rt", encoding="utf-8") as handle:
                rows = [json.loads(line) for line in handle]
            self.assertEqual([row["z"] for row in rows], [0.75, 1.1875])
            self.assertEqual([row["finalScore"] for row in rows], [60, 95])
            self.assertEqual(result[0]["searchNodes"], 8)
            self.assertEqual(result[0]["learnerSeats"], ["0", "1"])
            _, checkpoint = load_checkpoint(folder / "model.pt", meta)
            self.assertEqual(checkpoint["scoreStats"], {
                "count": 2, "total": 155, "max": 95, "atLeast60": 2, "atLeast80": 1, "average": 77.5})
            TRAIN.reinforce(model, optimizer, FakeRules(), 1, "score-test", folder / "resumed.pt",
                            meta, set(checkpoint["seenGames"]), resume=checkpoint)
            _, resumed = load_checkpoint(folder / "resumed.pt", meta)
            self.assertEqual(resumed["scoreStats"]["count"], 3)
            self.assertEqual(resumed["scoreStats"]["total"], 215)

    def test_value_head_can_predict_more_than_eighty(self):
        model = PolicyValue(2, 2)
        for parameter in model.parameters():
            parameter.data.zero_()
        model.value[2].bias.data.fill_(1.5)
        _, value = infer(model, {"state": [0, 0], "candidates": [[0, 0]]})
        self.assertEqual(value.item() * 80, 120)

    def test_selection_prefers_score_instead_of_only_wins(self):
        config = {"selectionObjective": "own-final-score", "minimumPromotionPairs": 16,
                  "minimumScoreImprovement": 0.25}
        def report(score, wins):
            return {"summary": {"guide": {"games": 32, "averageScore": score, "winRate": wins},
                                "imitation": {}}}
        self.assertTrue(LOOP.promotion(report(65, 0.4), report(40, 0.8), config)["promoted"])
        self.assertFalse(LOOP.promotion(report(39, 0.9), report(40, 0.5), config)["promoted"])
        self.assertFalse(LOOP.promotion(report(40, 0.9), report(40, 0.5), config)["promoted"])


if __name__ == "__main__":
    torch.set_num_threads(2)
    unittest.main()
