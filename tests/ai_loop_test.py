"""检查长期循环的晋级、互斥与原子状态，不依赖长时间训练或构建。"""
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("training_loop", ROOT / "scripts/train-loop.py")
LOOP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LOOP)


class LoopTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / "data/ai-training-loop.json").read_text(encoding="utf-8"))
        self.baseline = {"summary": {"guide": {"winRate": 0.5}}}

    def report(self, wins=0.75, games=32, margin=2, guide=0.5):
        return {"summary": {"imitation": {"winRate": wins, "games": games, "averageMargin": margin},
                            "guide": {"winRate": guide}}}

    def test_promotion_rejects_small_samples_and_regression(self):
        # 旧胜负目标仍能读取历史评估；新得分目标由专门回归测试覆盖。
        self.config.pop("selectionObjective", None)
        self.assertFalse(LOOP.promotion(self.report(games=4), self.baseline, self.config)["promoted"])
        self.assertFalse(LOOP.promotion(self.report(guide=0.2), self.baseline, self.config)["promoted"])
        self.assertFalse(LOOP.promotion(self.report(wins=0.5), self.baseline, self.config)["promoted"])
        self.assertFalse(LOOP.promotion(self.report(margin=0), self.baseline, self.config)["promoted"])
        self.assertTrue(LOOP.promotion(self.report(), self.baseline, self.config)["promoted"])

    def test_atomic_state_and_lock_release(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            LOOP.atomic_json(path, {"generation": 2})
            LOOP.atomic_json(path, {"generation": 3})
            self.assertEqual(LOOP.read(path)["generation"], 3)
            self.assertFalse(Path(str(path) + ".tmp").exists())
            lock = Path(directory) / "loop.lock"
            with LOOP.exclusive(lock):
                with self.assertRaisesRegex(RuntimeError, "ALREADY_RUNNING"):
                    with LOOP.exclusive(lock):
                        self.fail("同一目录不应启动第二个训练进程")
            with LOOP.exclusive(lock):
                pass

    def test_configuration_validation(self):
        LOOP.validate(self.config)
        with self.assertRaisesRegex(ValueError, "BAD_INTEGER"):
            LOOP.validate({**self.config, "gamesPerGeneration": 0})
        with self.assertRaisesRegex(ValueError, "BAD_THRESHOLD"):
            LOOP.validate({**self.config, "promotionWinRate": 0.4})


if __name__ == "__main__":
    unittest.main()
