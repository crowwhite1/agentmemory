#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

path = Path(__file__).with_name("project-memory.py")
spec = importlib.util.spec_from_file_location("projects", path)
projects = importlib.util.module_from_spec(spec)
spec.loader.exec_module(projects)


class ProjectRoutingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.a = self.root / "a"
        self.b = self.root / "b"
        for p in (self.a, self.b):
            p.mkdir()
            subprocess.run(["git", "init", "-q", str(p)], check=True)
        (self.a / "nested").mkdir()
        self.control = self.root / "control"
        self.control.mkdir()

    def test_nested_paths_and_distinct_roots(self):
        self.assertEqual(projects.root_from_candidates([str(self.a), str(self.a / "nested")]), str(self.a))
        with self.assertRaises(RuntimeError):
            projects.root_from_candidates([str(self.a), str(self.b)])

    def test_mcp_roots_only_accept_local_workspace(self):
        self.assertEqual(projects.mcp_roots({"roots": [{"uri": self.a.as_uri()}]}), str(self.a))
        for uri in ("https://example.com", "file://remote-host/tmp"):
            with self.assertRaises(RuntimeError):
                projects.mcp_roots({"roots": [{"uri": uri}]})

    def test_session_binding_rejects_cross_project(self):
        with patch.object(projects, "CONTROL", self.control):
            projects.bind_hook_session({"session_id": "same"}, str(self.a))
            projects.bind_hook_session({"session_id": "same"}, str(self.a))
            with self.assertRaises(RuntimeError):
                projects.bind_hook_session({"session_id": "same"}, str(self.b))

    def test_independent_store_and_port(self):
        with patch.object(projects, "DATA", self.control / "data"), patch.object(projects, "REGISTRY", self.control / "registry.json"), patch.object(projects, "CONTROL", self.control), patch.object(projects, "occupied", return_value=False):
            entries = {}
            a = projects.allocate(entries, str(self.a))
            b = projects.allocate(entries, str(self.b))
            self.assertNotEqual(projects.data_dir(a), projects.data_dir(b))
            self.assertNotEqual(projects.url(a), projects.url(b))
            self.assertEqual(projects.environment(a)["AGENTMEMORY_LLM_LOCK_FILE"], projects.environment(b)["AGENTMEMORY_LLM_LOCK_FILE"])
            self.assertEqual(projects.allocate(entries, str(self.a)), a)

    def test_no_roots_mcp_fails_closed(self):
        messages = [
            {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"capabilities": {}}},
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        ]
        result = subprocess.run([sys.executable, str(path), "mcp"],
            input="".join(json.dumps(m) + "\n" for m in messages),
            text=True, capture_output=True, check=True, timeout=10)
        responses = [json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(responses[0]["id"], 1)
        self.assertIn("no roots capability", responses[1]["error"]["message"])


if __name__ == "__main__":
    unittest.main()
