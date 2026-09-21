"""plugin_loader: optional modules named by a manifest, absent from a plain clone."""

import logging
import sys
from pathlib import Path

import pytest

from plugin_loader import DEFAULT_MANIFEST, load_plugin_modules, plugin_names


@pytest.fixture
def plugin_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A directory on sys.path holding throwaway plugin modules."""
    monkeypatch.syspath_prepend(str(tmp_path))
    return tmp_path


def _manifest(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "plugins.toml"
    path.write_text(text, encoding="utf-8")
    return path


def test_no_manifest_means_no_plugins(tmp_path: Path) -> None:
    assert plugin_names("routers", tmp_path / "missing.toml") == []
    assert load_plugin_modules("routers", tmp_path / "missing.toml") == []


def test_plain_clone_has_no_default_manifest() -> None:
    """The repo itself must not ship a manifest — that is what makes every hook a no-op."""
    assert not DEFAULT_MANIFEST.exists()
    assert load_plugin_modules("routers") == []
    assert load_plugin_modules("tool_impls") == []


def test_loads_only_the_requested_kind_in_manifest_order(plugin_dir: Path) -> None:
    (plugin_dir / "plug_a.py").write_text("router = 'a'\n")
    (plugin_dir / "plug_b.py").write_text("router = 'b'\n")
    (plugin_dir / "plug_tools.py").write_text("EXTRA_TOOL_IMPLS = {'t': (None, [])}\n")
    manifest = _manifest(plugin_dir, 'routers = ["plug_b", "plug_a"]\ntool_impls = ["plug_tools"]\n')
    assert [m.router for m in load_plugin_modules("routers", manifest)] == ["b", "a"]
    assert "plug_tools" not in sys.modules  # asking for routers must not import the tool_impls modules
    assert load_plugin_modules("tool_impls", manifest)[0].EXTRA_TOOL_IMPLS == {"t": (None, [])}
    assert load_plugin_modules("nothing_listed", manifest) == []


def test_an_unimportable_plugin_is_skipped_and_logged(plugin_dir: Path, caplog: pytest.LogCaptureFixture) -> None:
    (plugin_dir / "plug_ok.py").write_text("router = 'ok'\n")
    (plugin_dir / "plug_broken.py").write_text("import a_module_that_does_not_exist_anywhere\n")
    manifest = _manifest(plugin_dir, 'routers = ["plug_absent", "plug_broken", "plug_ok"]\n')
    with caplog.at_level(logging.WARNING, logger="plugin_loader"):
        modules = load_plugin_modules("routers", manifest)
    assert [m.router for m in modules] == ["ok"]
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 2
    assert any("'plug_absent'" in w for w in warnings)
    assert any("'plug_broken'" in w for w in warnings)


@pytest.mark.parametrize(
    "text",
    ["routers = [", 'routers = "planner"', "routers = [1, 2]"],
    ids=["bad-toml", "not-a-list", "not-strings"],
)
def test_a_malformed_manifest_fails_loudly(tmp_path: Path, text: str) -> None:
    with pytest.raises(ValueError, match="invalid plugin manifest"):
        plugin_names("routers", _manifest(tmp_path, text))
