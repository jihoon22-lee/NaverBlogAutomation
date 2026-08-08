"""Privacy and atomic-write coverage for desktop runtime configuration."""

from pathlib import Path

import pytest

from naver_blog_assistant.application.runtime_configuration import (
    RuntimeConfiguration,
    RuntimeConfigurationError,
)


def private_file(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)


def test_updating_a_secret_preserves_comments_unknown_keys_and_redacts_it(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "# local note\nCUSTOM_VALUE=keep\nOPENAI_MODEL=old\n")
    configuration = RuntimeConfiguration(
        target,
        environment={"COMMENT_GENERATOR_MODE": "openai", "OPENAI_MODEL": "old"},
    )

    snapshot = configuration.update({"OPENAI_API_KEY": "private-value", "OPENAI_MODEL": "new"})

    stored = target.read_text(encoding="utf-8")
    assert "# local note" in stored
    assert "CUSTOM_VALUE=keep" in stored
    assert "OPENAI_MODEL=new" in stored
    assert "OPENAI_API_KEY=private-value" in stored
    assert snapshot.providers[0] == ("openai", True, "new")
    assert "private-value" not in repr(snapshot)
    assert target.stat().st_mode & 0o077 == 0


def test_rejects_a_group_readable_private_file(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "OPENAI_MODEL=old\n")
    target.chmod(0o644)
    configuration = RuntimeConfiguration(target, environment={})

    with pytest.raises(RuntimeConfigurationError, match="0600"):
        configuration.update({"OPENAI_MODEL": "new"})


def test_rejects_a_private_file_without_the_exact_owner_read_write_mode(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "OPENAI_MODEL=old\n")
    target.chmod(0o700)
    configuration = RuntimeConfiguration(target, environment={})

    with pytest.raises(RuntimeConfigurationError, match="0600"):
        configuration.update({"OPENAI_MODEL": "new"})


def test_rejects_a_group_readable_private_directory(tmp_path: Path) -> None:
    private = tmp_path / "private"
    private.mkdir()
    private.chmod(0o750)
    configuration = RuntimeConfiguration(private / "env", environment={})

    with pytest.raises(RuntimeConfigurationError, match="0700"):
        configuration.update({"OPENAI_MODEL": "new"})


def test_rejects_duplicate_known_keys_before_overwriting(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "OPENAI_MODEL=old\nOPENAI_MODEL=older\n")
    configuration = RuntimeConfiguration(target, environment={})

    with pytest.raises(RuntimeConfigurationError, match="duplicate"):
        configuration.update({"OPENAI_MODEL": "new"})


def test_rejects_multiline_values_before_they_can_inject_dotenv_keys(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "OPENAI_MODEL=old\n")
    configuration = RuntimeConfiguration(target, environment={})

    with pytest.raises(RuntimeConfigurationError, match="single-line"):
        configuration.update({"OPENAI_API_KEY": "value\nWEBAPP_ACCESS_MODE=lan"})

    assert target.read_text(encoding="utf-8") == "OPENAI_MODEL=old\n"


def test_clearing_a_secret_removes_it_from_the_private_file_and_snapshot(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "OPENAI_API_KEY=previous-value\nOPENAI_MODEL=test-model\n")
    configuration = RuntimeConfiguration(
        target,
        environment={"OPENAI_API_KEY": "previous-value", "OPENAI_MODEL": "test-model"},
    )

    snapshot = configuration.update({"OPENAI_API_KEY": None})

    assert "OPENAI_API_KEY" not in target.read_text(encoding="utf-8")
    assert snapshot.providers[0] == ("openai", False, "test-model")
    assert "previous-value" not in repr(snapshot)


def test_access_mode_refuses_a_mismatched_or_nonstandard_bind_setting(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "WEBAPP_ACCESS_MODE=local\n")
    configuration = RuntimeConfiguration(target, environment={"WEBAPP_ACCESS_MODE": "local"})

    with pytest.raises(RuntimeConfigurationError, match="host"):
        configuration.update({"API_HOST": "0.0.0.0"})
    with pytest.raises(RuntimeConfigurationError, match="port"):
        configuration.update({"API_PORT": "9000"})


def test_provider_switch_requires_the_selected_provider_to_be_configured(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "COMMENT_GENERATOR_MODE=fake\n")
    configuration = RuntimeConfiguration(target, environment={"COMMENT_GENERATOR_MODE": "fake"})

    with pytest.raises(RuntimeConfigurationError, match="not configured"):
        configuration.update({"COMMENT_GENERATOR_MODE": "anthropic"})

    configuration.update(
        {
            "ANTHROPIC_API_KEY": "private-value",
            "COMMENT_GENERATOR_MODE": "anthropic",
        }
    )


def test_rejects_private_configuration_inside_a_symlinked_directory(tmp_path: Path) -> None:
    private = tmp_path / "private"
    private.mkdir()
    linked = tmp_path / "linked"
    try:
        linked.symlink_to(private, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks are not available in this environment")
    configuration = RuntimeConfiguration(linked / "env", environment={})

    with pytest.raises(RuntimeConfigurationError, match="directory cannot be a symlink"):
        configuration.update({"OPENAI_MODEL": "new"})


def test_snapshot_exposes_nonsecret_digest_addresses_but_not_passwords(tmp_path: Path) -> None:
    target = tmp_path / "env"
    private_file(target, "DIGEST_SMTP_PASSWORD=private\n")
    configuration = RuntimeConfiguration(
        target,
        environment={
            "DIGEST_SMTP_PASSWORD": "private",
            "DIGEST_EMAIL_FROM": "sender@example.test",
            "DIGEST_EMAIL_TO": "recipient@example.test",
        },
    )

    snapshot = configuration.snapshot()

    assert snapshot.digest_email_from == "sender@example.test"
    assert snapshot.digest_email_to == "recipient@example.test"
    assert "private" not in repr(snapshot)
