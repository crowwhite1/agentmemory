#!/usr/bin/env python3
"""Standalone tests: no AgentMemory, LM Studio or Codex instance required."""
import importlib.util
import sys
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("migrate-from-proxy.py"))
migration = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(migration)


class MigrationConfigTests(unittest.TestCase):
    def test_env_preserves_model_and_comments(self):
        original = "# custom\nOPENAI_MODEL=qwen3-4b-instruct-2507-mlx\nOPENAI_BASE_URL=http://127.0.0.1:3114/v1\n"
        result = migration.update_env(original, {"OPENAI_BASE_URL": "http://127.0.0.1:1234/v1"})
        self.assertIn("OPENAI_MODEL=qwen3-4b-instruct-2507-mlx", result)
        self.assertIn("# custom", result)
        self.assertEqual(result.count("OPENAI_BASE_URL="), 1)

    def test_codex_preserves_unrelated_servers(self):
        original = 'model="gpt-5"\n[mcp_servers.github]\ncommand="gh"\n[mcp_servers.agentmemory]\ncommand="npx"\n[mcp_servers.agentmemory.env]\nAGENTMEMORY_URL="http://127.0.0.1:3112"\n'
        result = migration.update_codex_toml(original, "/bin/npx")
        self.assertIn('model="gpt-5"', result)
        self.assertIn('[mcp_servers.github]', result)
        self.assertEqual(result.count("[mcp_servers.agentmemory]"), 1)
        self.assertIn("http://127.0.0.1:3111", result)
        self.assertNotIn("http://127.0.0.1:3112", result)

    def test_invalid_config_fails_closed(self):
        with self.assertRaises(ValueError):
            migration.update_codex_toml("[missing\n", "npx")

    def test_preserves_legacy_workdir_state_location(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            old = Path(folder)
            (old / "data").mkdir()
            (old / "data" / "state_store.db").touch()
            resolved = migration.prior_data_directory(old, {})
            self.assertEqual(resolved, old / "data")
            self.assertTrue(migration.under_path(resolved, old))

    def test_explicit_absolute_state_location_has_precedence(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            old = Path(folder)
            external = old.parent / "a-separate-agentmemory-state"
            self.assertEqual(
                migration.prior_data_directory(old, {"AGENTMEMORY_DATA_DIR": str(external)}),
                external,
            )

    def test_hooks_change_only_agentmemory_commands(self):
        original = '{"hooks": [{"command": "AGENTMEMORY_URL=http://127.0.0.1:3112 npx agentmemory"}, {"command": "curl http://127.0.0.1:3112"}]}'
        result = migration.update_hooks(original)
        self.assertIn("http://127.0.0.1:3111", result)
        self.assertIn("curl http://127.0.0.1:3112", result)


if __name__ == "__main__":
    unittest.main()
