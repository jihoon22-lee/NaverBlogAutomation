"""The extension boundary check: what it flags and what it lets through."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "check_extension_boundary.py"


def load() -> ModuleType:
    """Import the standalone script as a module."""
    spec = importlib.util.spec_from_file_location("check_extension_boundary", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def checker() -> ModuleType:
    return load()


class TestTypeScript:
    @pytest.mark.parametrize(
        "line",
        [
            'import { extract } from "../../extension/src/extract";',
            "import { extract } from '../extension/src/extract';",
            'export { thing } from "extension/src/thing";',
            'const mod = require("../../extension/src/extract");',
            'import "./extension/src/side-effect";',
        ],
    )
    def test_it_flags_an_import_from_the_extension(
        self, checker: ModuleType, tmp_path: Path, line: str
    ) -> None:
        path = tmp_path / "module.ts"
        path.write_text(line, encoding="utf-8")

        assert checker.violations(path) != []

    @pytest.mark.parametrize(
        "line",
        [
            'import { extract } from "../api/client";',
            'import type { Thing } from "./types";',
            "// the extension/src copy stays independent on purpose",
            'const label = "extension/src is frozen";',
        ],
    )
    def test_it_allows_everything_else(
        self, checker: ModuleType, tmp_path: Path, line: str
    ) -> None:
        path = tmp_path / "module.ts"
        path.write_text(line, encoding="utf-8")

        assert checker.violations(path) == []


class TestPython:
    @pytest.mark.parametrize(
        "line",
        ["import extension", "from extension import thing", "from extension.src import thing"],
    )
    def test_it_flags_a_python_import(self, checker: ModuleType, tmp_path: Path, line: str) -> None:
        path = tmp_path / "module.py"
        path.write_text(line, encoding="utf-8")

        assert checker.violations(path) != []

    def test_it_allows_a_similar_name(self, checker: ModuleType, tmp_path: Path) -> None:
        path = tmp_path / "module.py"
        path.write_text("from extensions import thing\nimport extension_helper\n", encoding="utf-8")

        assert checker.violations(path) == []

    def test_a_mention_in_a_docstring_is_not_an_import(
        self, checker: ModuleType, tmp_path: Path
    ) -> None:
        path = tmp_path / "module.py"
        path.write_text('"""Ported from extension/src/extract.ts."""\n', encoding="utf-8")

        assert checker.violations(path) == []


class TestRepository:
    def test_the_repository_currently_has_no_violations(self, checker: ModuleType) -> None:
        assert checker.main() == 0

    def test_it_watches_both_the_web_app_and_the_service(self, checker: ModuleType) -> None:
        assert "client/src" in checker.WATCHED
        assert "src" in checker.WATCHED

    def test_it_scans_typescript_and_python(self, checker: ModuleType) -> None:
        paths = list(checker.watched_files())

        assert any(path.suffix == ".ts" for path in paths)
        assert any(path.suffix == ".py" for path in paths)
