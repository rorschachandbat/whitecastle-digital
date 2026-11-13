"""验证训练张量、屏蔽、数据划分和检查点，不调用编译或构建。"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

import torch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from ai_model import PolicyValue, batch_tensors, load_checkpoint, load_frozen_checkpoint, save_checkpoint

SPEC = importlib.util.spec_from_file_location("train_policy", ROOT / "scripts/train-policy.py")
TRAIN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRAIN)


class ModelTests(unittest.TestCase):
    def test_masked_candidates_and_gradients(self):
        rows = [{"state": [0.1, 0.2], "candidates": [[1, 0], [0, 1]]},
                {"state": [0.3, 0.4], "candidates": [[1, 1]]}]
        model = PolicyValue(2, 2)
        logits, values = model(*batch_tensors(rows))
        self.assertEqual(tuple(logits.shape), (2, 2))
        self.assertLess(logits[1, 1].item(), -1e8)
        loss = torch.nn.functional.cross_entropy(logits, torch.tensor([0, 0])) + values.square().mean()
        loss.backward()
        self.assertTrue(all(parameter.grad is None or torch.isfinite(parameter.grad).all()
                            for parameter in model.parameters()))

    def test_game_split_has_no_shared_positions(self):
        rows = [{"game": f"game-{game}", "step": step} for game in range(8) for step in range(3)]
        train, validation, _ = TRAIN.split_games(rows, TRAIN.random.Random(7))
        self.assertFalse({row["game"] for row in train} & {row["game"] for row in validation})
        self.assertEqual(len(train) + len(validation), len(rows))

    def test_parts_head_gradients_targets_and_checkpoint_reload(self):
        parts = dict(zip(TRAIN.SCORE_PARTS, [10, 2, 3, 30, 40, 11, 4]))
        rows = [{"state": [0.1, 0.2], "finalScore": 100, "finalParts": parts}]
        model = PolicyValue(2, 2, score_parts=True)
        loss = TRAIN.auxiliary_loss(model, rows)
        loss.backward()
        self.assertTrue(torch.isfinite(loss))
        self.assertIsNotNone(model.parts[2].weight.grad)
        self.assertIsNotNone(model.state_encoder[0].weight.grad)
        self.assertAlmostEqual(TRAIN.parts_targets(rows).sum().item(), 1.25)
        with self.assertRaisesRegex(ValueError, "BAD_PARTS_TARGET"):
            TRAIN.parts_targets([{**rows[0], "finalScore": 99}])
        with self.assertRaisesRegex(ValueError, "BAD_PARTS_TARGET"):
            TRAIN.parts_targets([{**rows[0], "finalParts": {**parts, "warrior": float("nan")}}])
        meta = {key: "parts-test" for key in TRAIN.META_KEYS}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "parts.pt"
            save_checkpoint(path, model, meta)
            restored, checkpoint = load_checkpoint(path, meta)
            self.assertTrue(checkpoint["scoreParts"])
            self.assertTrue(torch.equal(model.predict_parts(torch.tensor([[0.1, 0.2]])),
                                        restored.predict_parts(torch.tensor([[0.1, 0.2]]))))

    def test_checkpoint_reload_and_config_rejection(self):
        meta = {key: "v1" for key in TRAIN.META_KEYS}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.pt"
            model = PolicyValue(2, 3)
            save_checkpoint(path, model, meta)
            reloaded, _ = load_checkpoint(path, meta)
            for old, new in zip(model.parameters(), reloaded.parameters()):
                self.assertTrue(torch.equal(old, new))
            with self.assertRaisesRegex(ValueError, "CONFIG_MISMATCH"):
                load_checkpoint(path, {**meta, "catalogHash": "changed"})
            with self.assertRaisesRegex(ValueError, "CONFIG_MISMATCH:encoderHash"):
                load_checkpoint(path, {**meta, "encoderHash": "changed-code"})
            save_checkpoint(path, model, {key: value for key, value in meta.items() if key != "encoderHash"})
            with self.assertRaisesRegex(ValueError, "CONFIG_MISMATCH:encoderHash"):
                load_checkpoint(path, meta)

    def test_frozen_opponent_ignores_only_setup_version(self):
        meta = {key: "v1" for key in TRAIN.META_KEYS}
        meta["setupVersion"] = "room-colors-v1"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "old.pt"
            save_checkpoint(path, PolicyValue(2, 2), meta)
            current = {**meta, "setupVersion": "tile-inventory-v3"}
            with self.assertRaisesRegex(ValueError, "CONFIG_MISMATCH:setupVersion"):
                load_checkpoint(path, current)
            load_frozen_checkpoint(path, current)
            with self.assertRaisesRegex(ValueError, "FROZEN_OPPONENT_MISMATCH:encoderHash"):
                load_frozen_checkpoint(path, {**current, "encoderHash": "changed"})


if __name__ == "__main__":
    torch.set_num_threads(2)
    unittest.main()
