"""Use-case behavior for reading and saving web app settings."""

from __future__ import annotations

from typing import Any

import pytest

from naver_blog_assistant.application.settings import ReadAppSetting, SaveAppSetting
from naver_blog_assistant.domain import (
    DEFAULT_SETTING_PAYLOADS,
    AppSetting,
    AppSettingKind,
    DomainValidationError,
    default_setting,
)


class FakeRepository:
    """In-memory settings store for the use-case tests."""

    def __init__(self) -> None:
        self.records: dict[AppSettingKind, AppSetting] = {}
        self.saves = 0

    def get(self, kind: AppSettingKind) -> AppSetting | None:
        return self.records.get(kind)

    def save(self, setting: AppSetting) -> AppSetting:
        self.saves += 1
        self.records[setting.kind] = setting
        return setting


def test_reading_an_unsaved_kind_returns_its_default() -> None:
    repository = FakeRepository()

    setting = ReadAppSetting(repository).execute(AppSettingKind.CLOSING_PHRASE)

    assert setting.payload == {"phrase": ""}
    assert setting.updated_at is None


def test_reading_a_saved_kind_returns_the_stored_record() -> None:
    repository = FakeRepository()
    repository.records[AppSettingKind.CLOSING_PHRASE] = AppSetting(
        kind=AppSettingKind.CLOSING_PHRASE, schema_version=1, payload={"phrase": "저장됨"}
    )

    setting = ReadAppSetting(repository).execute(AppSettingKind.CLOSING_PHRASE)

    assert setting.payload == {"phrase": "저장됨"}


def test_saving_normalizes_before_persisting() -> None:
    repository = FakeRepository()

    saved = SaveAppSetting(repository).execute(
        AppSettingKind.CLOSING_PHRASE, {"phrase": "  다듬어짐  "}
    )

    assert saved.payload == {"phrase": "다듬어짐"}
    assert repository.saves == 1


def test_saving_rejects_an_invalid_payload_without_persisting() -> None:
    repository = FakeRepository()

    with pytest.raises(DomainValidationError):
        SaveAppSetting(repository).execute(AppSettingKind.CLOSING_PHRASE, {"phrase": "가" * 51})
    assert repository.saves == 0


@pytest.mark.parametrize("payload", ["text", 3, None, ["a"]])
def test_saving_rejects_a_non_object_payload(payload: Any) -> None:
    repository = FakeRepository()

    with pytest.raises(DomainValidationError, match="must be an object"):
        SaveAppSetting(repository).execute(AppSettingKind.CLOSING_PHRASE, payload)


def test_every_kind_can_be_saved_from_its_default() -> None:
    repository = FakeRepository()
    save = SaveAppSetting(repository)

    for kind in AppSettingKind:
        save.execute(kind, dict(DEFAULT_SETTING_PAYLOADS[kind]))

    assert repository.saves == len(AppSettingKind)
    for kind in AppSettingKind:
        assert repository.records[kind] == default_setting(kind)
