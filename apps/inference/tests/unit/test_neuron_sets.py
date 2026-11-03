"""Signed raw-neuron source sets (NEURON_SETS).

A raw-neuron set serves coordinate ``i`` of ``blocks.L.mlp.hook_post`` as feature ``i`` of
source ``"L-<set>"``, times the set's sign. The sign lets a SwiGLU neuron's negative pole be
served as a one-sided feature of its own, which is what every explainer and scorer expects.
"""

from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import torch

from neuronpedia_inference.config import Config, validate_neuron_sets
from neuronpedia_inference.endpoints.activation.single import process_neuron_activations
from neuronpedia_inference.sae_manager import SAE_TYPE, SAEManager

NUM_LAYERS = 4


def build_manager(neuron_sets: list[dict[str, Any]]) -> SAEManager:
    """A manager with no SAEs and the given raw-neuron sets."""
    config = Config(
        model_id="gpt2-small",
        sae_sets=[],
        neuron_sets=neuron_sets,
        secret="test_secret",
        token_limit=100,
        device="cpu",
    )
    with (
        patch("neuronpedia_inference.sae_manager.SaeLensSAE") as mock_sae_lens,
        patch("neuronpedia_inference.sae_manager.Config.get_instance", return_value=config),
    ):
        mock_sae_lens.load.return_value = (MagicMock(), "mock_hook")
        manager = SAEManager(num_layers=NUM_LAYERS, device="cpu")
        manager.load_saes()
        return manager


class TestValidateNeuronSets:
    def test_accepts_a_signed_pair(self):
        assert validate_neuron_sets([{"set": "fineweb10m", "sign": 1}, {"set": "fineweb10m-neg", "sign": -1}]) == [
            {"set": "fineweb10m", "sign": 1},
            {"set": "fineweb10m-neg", "sign": -1},
        ]

    def test_sign_defaults_to_positive(self):
        assert validate_neuron_sets([{"set": "scan"}]) == [{"set": "scan", "sign": 1}]

    @pytest.mark.parametrize(
        "entry",
        [
            {"set": "neurons", "sign": 1},
            {"set": "Upper", "sign": 1},
            {"set": "double--hyphen", "sign": 1},
            {"set": "trailing-", "sign": 1},
            {"set": "scan", "sign": 2},
            {"set": "scan", "sign": 0.5},
            {"set": "scan", "sign": True},
            {"sign": 1},
        ],
    )
    def test_rejects(self, entry: dict[str, Any]):
        with pytest.raises(ValueError, match="NEURON_SETS"):
            validate_neuron_sets([entry])

    def test_rejects_duplicates(self):
        with pytest.raises(ValueError, match="twice"):
            validate_neuron_sets([{"set": "scan", "sign": 1}, {"set": "scan", "sign": -1}])


class TestSignedNeuronSources:
    def test_registers_one_source_per_layer_with_its_sign(self):
        manager = build_manager([{"set": "scan", "sign": 1}, {"set": "scan-neg", "sign": -1}])

        assert manager.sae_set_to_saes["scan"] == [f"{layer}-scan" for layer in range(NUM_LAYERS)]
        assert manager.sae_set_to_saes["scan-neg"] == [f"{layer}-scan-neg" for layer in range(NUM_LAYERS)]
        for layer in range(NUM_LAYERS):
            for source, sign in ((f"{layer}-scan", 1.0), (f"{layer}-scan-neg", -1.0)):
                assert manager.get_sae_type(source) == SAE_TYPE.NEURONS
                assert manager.get_sae_hook(source) == f"blocks.{layer}.mlp.hook_post"
                assert manager.get_neuron_sign(source) == sign
        assert {"scan", "scan-neg"} <= set(manager.get_valid_sae_sets())

    def test_builtin_set_is_unchanged(self):
        manager = build_manager([{"set": "scan-neg", "sign": -1}])

        assert manager.sae_set_to_saes["neurons"] == [str(layer) for layer in range(NUM_LAYERS)]
        assert manager.get_neuron_sign("2") == 1.0
        assert manager.get_sae_hook("2") == "blocks.2.mlp.hook_post"

    def test_no_weights_are_loaded(self):
        manager = build_manager([{"set": "scan-neg", "sign": -1}])

        with patch.object(manager, "load_sae") as load_sae:
            assert manager.get_sae("3-scan-neg") is None
        load_sae.assert_not_called()

    def test_is_neuron_set(self):
        manager = build_manager([{"set": "scan-neg", "sign": -1}])

        assert manager.is_neuron_set("neurons")
        assert manager.is_neuron_set("scan-neg")
        assert not manager.is_neuron_set("res-jb")

    def test_sign_of_an_unknown_source_is_positive(self):
        manager = build_manager([])

        assert manager.get_neuron_sign("0-res-jb") == 1.0


class TestProcessNeuronActivations:
    """The read itself, against a brute-force pick from a fake capture."""

    @pytest.mark.parametrize("sign", [1.0, -1.0])
    def test_matches_a_direct_index(self, sign: float):
        torch.manual_seed(0)
        capture = torch.randn(1, 7, 16)  # [batch, seq, d_mlp]
        cache = {"blocks.1.mlp.hook_post": capture}

        result = process_neuron_activations(cache, "blocks.1.mlp.hook_post", 5, "cpu", sign)

        expected = (sign * capture[0, :, 5]).tolist()
        assert result.values == pytest.approx(expected)
        assert result.max_value == pytest.approx(max(expected))
        assert result.max_value_index == expected.index(max(expected))

    def test_default_sign_keeps_old_behaviour(self):
        capture = torch.arange(12, dtype=torch.float32).reshape(1, 3, 4)
        cache = {"h": capture}

        assert process_neuron_activations(cache, "h", 2, "cpu").values == [2.0, 6.0, 10.0]
