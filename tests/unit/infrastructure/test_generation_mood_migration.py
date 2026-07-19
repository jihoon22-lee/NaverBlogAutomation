"""Focused coverage for the data-only generation mood migration helpers."""

import json
from importlib import import_module
from typing import Any

import pytest

MIGRATION: Any = import_module(
    "naver_blog_assistant.infrastructure.database.migrations.versions.20260719_0004_generation_mood"
)


def test_upgrade_helper_adds_only_the_implicit_warm_mood() -> None:
    legacy = {"relationship": "friendly", "speech": "honorific", "length": "medium"}

    assert MIGRATION._with_default_mood(legacy) == {**legacy, "mood": "warm"}
    assert MIGRATION._with_default_mood({**legacy, "mood": "lively"}) == {
        **legacy,
        "mood": "lively",
    }
    with pytest.raises(RuntimeError, match="generation preferences are invalid"):
        MIGRATION._with_default_mood({"relationship": "friendly"})


def test_downgrade_helper_preserves_legacy_and_removes_only_warm() -> None:
    legacy = {"relationship": "friendly", "speech": "honorific", "length": "medium"}

    assert MIGRATION._without_default_mood(legacy) == legacy
    assert MIGRATION._without_default_mood({**legacy, "mood": "warm"}) == legacy
    with pytest.raises(RuntimeError, match="non-default generation mood"):
        MIGRATION._without_default_mood({**legacy, "mood": "calm"})
    with pytest.raises(RuntimeError, match="generation preferences are invalid"):
        MIGRATION._without_default_mood({"mood": "warm"})


def test_json_helpers_reject_malformed_persisted_values() -> None:
    assert MIGRATION._load_object(b'{"speech":"honorific"}', "preferences") == {
        "speech": "honorific"
    }
    assert json.loads(MIGRATION._dump({"mood": "warm", "length": "medium"})) == {
        "length": "medium",
        "mood": "warm",
    }

    for value in (None, 1, "not-json", "[]", '{"mood":'):
        with pytest.raises(RuntimeError, match="stored preferences is invalid"):
            MIGRATION._load_object(value, "preferences")
    with pytest.raises(RuntimeError, match="stored preferences is invalid"):
        MIGRATION._require_mapping({1: "warm"}, "preferences")
