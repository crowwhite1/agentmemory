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

    def test_codex_preserves_agentmemory_secret_and_other_custom_config(self):
        original = (
            'model="gpt-6"\n'
            '[mcp_servers.agentmemory]\n'
            'command="npx"\n'
            'enabled=true\n'
            '[mcp_servers.agentmemory.env]\n'
            'AGENTMEMORY_URL="http://127.0.0.1:3112"\n'
            'AGENTMEMORY_SECRET="existing-local-token"\n'
            'AGENTMEMORY_AGENT_ID="crowisp"\n'
        )
        result = migration.update_codex_toml(original, "/bin/npx")
        self.assertIn('AGENTMEMORY_SECRET = "existing-local-token"', result)
        self.assertIn('AGENTMEMORY_AGENT_ID = "crowisp"', result)
        self.assertIn("enabled = true", result)
        self.assertIn('AGENTMEMORY_URL = "http://127.0.0.1:3111"', result)

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
            self.assertEqual(resolved, (old / "data").resolve())
            self.assertTrue(migration.under_path(resolved, old))

    def test_explicit_absolute_state_location_has_precedence(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            old = Path(folder)
            external = old.parent / "a-separate-agentmemory-state"
            self.assertEqual(
                migration.prior_data_directory(old, {"AGENTMEMORY_DATA_DIR": str(external)}),
                external.resolve(),
            )

    def test_path_containment_accepts_symlink_aliases(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            real = root / "private" / "var"
            real.mkdir(parents=True)
            alias = root / "var"
            alias.symlink_to(real, target_is_directory=True)
            data = real / "data"
            data.mkdir()
            self.assertTrue(migration.under_path(data.resolve(), alias))
            self.assertTrue(migration.under_path(alias / "data", real))
            self.assertTrue(migration.under_path(alias, real))
            self.assertFalse(migration.under_path(root / "other", alias))

    def test_directory_store_snapshot_and_runtime_metadata(self):
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            data = root / "data"
            store = data / "state_store.db"
            store.mkdir(parents=True)
            (store / "record").write_text("memory")
            compose = data / "compose" / "worker-compose.yaml"
            compose.parent.mkdir()
            compose.write_text(f"store_method: file_based\nfile_path: '{store}'\n")
            metadata = root / "engine-state.json"
            metadata.write_text(json.dumps({"kind": "compose", "restPort": 3111,
                "file": str(compose), "stateDir": str(data / "compose-state")}))
            self.assertEqual(migration.live_data_directory(metadata), data)
            snapshot = root / "backup"
            migration.snapshot_state_store(store, snapshot)
            self.assertEqual((snapshot / "record").read_text(), "memory")
            compose.write_text(f"store_method: file_based\nfile_path: '{root / 'other.db'}'\n")
            with self.assertRaises(migration.MigrationError):
                migration.live_data_directory(metadata)

    def test_directory_store_is_detected_in_legacy_workdir(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "data" / "state_store.db").mkdir(parents=True)
            self.assertEqual(migration.prior_data_directory(root, {}), (root / "data").resolve())

    def test_project_codex_config_has_no_fixed_url(self):
        original = '[mcp_servers.github]\ncommand="gh"\n[mcp_servers.agentmemory]\ncommand="npx"\n[mcp_servers.agentmemory.env]\nAGENTMEMORY_URL="http://127.0.0.1:3112"\n'
        parsed = migration.tomllib.loads(migration.update_codex_toml(original, "/bin/npx", project_mode=True))
        self.assertEqual(parsed["mcp_servers"]["github"]["command"], "gh")
        server = parsed["mcp_servers"]["agentmemory"]
        self.assertEqual(server["args"][-1], "mcp")
        self.assertNotIn("AGENTMEMORY_URL", server.get("env", {}))

    def test_project_hooks_preserve_unrelated_handler(self):
        import json
        payload = {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "echo hello"}, {"type": "command", "command": "python /tmp/agentmemory-proxy/hook.py"}]}]}}
        result = json.loads(migration.project_hooks(json.dumps(payload)))
        commands = [h["command"] for entry in result["hooks"]["Stop"] for h in entry["hooks"]]
        self.assertIn("echo hello", commands)
        self.assertTrue(any("project-memory.py" in command for command in commands))
        self.assertFalse(any("agentmemory-proxy" in command for command in commands))

    def test_scope_rejects_mixed_memory(self):
        import tempfile
        import subprocess
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            sessions = [{"cwd": str(root), "project": root.name}]
            self.assertEqual(migration.verify_project_scope(sessions, [{"project": root.name}], root / "data"), root)
            with self.assertRaises(migration.MigrationError):
                migration.verify_project_scope(sessions, [{"project": "other"}], root / "data")
            with self.assertRaises(migration.MigrationError):
                migration.verify_project_scope(sessions, [{}], root / "data")

    def test_runtime_settings_removed_not_model(self):
        text = "AGENTMEMORY_DATA_DIR=/old\nIII_REST_PORT=3111\nOPENAI_MODEL=qwen\n"
        self.assertEqual(migration.without_runtime_values(text), "OPENAI_MODEL=qwen\n")

    def test_hooks_change_only_agentmemory_commands(self):
        original = '{"hooks": [{"command": "AGENTMEMORY_URL=http://127.0.0.1:3112 npx agentmemory"}, {"command": "curl http://127.0.0.1:3112"}]}'
        result = migration.update_hooks(original)
        self.assertIn("http://127.0.0.1:3111", result)
        self.assertIn("curl http://127.0.0.1:3112", result)


if __name__ == "__main__":
    unittest.main()
