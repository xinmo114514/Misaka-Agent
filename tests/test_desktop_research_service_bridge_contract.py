"""Production frontend service -> real Python JSONL bridge -> fixture HTTP model.

No mocked bridge commands, task claims, receipts or persistence. The isolated
directory is retained by pytest on failure; no real user research is touched.
"""
import json
import os
import subprocess
import sys
from pathlib import Path


def test_research_service_real_bridge_contract(tmp_path):
    root = Path(__file__).resolve().parents[1]
    desktop = root / "desktop"
    bundle = tmp_path / "service-contract.cjs"
    esbuild = next((desktop / "node_modules/.pnpm").glob("esbuild@*/node_modules/esbuild/lib/main.js"))
    build = subprocess.run([
        "node", "-e", ("require(process.argv[1]).buildSync({entryPoints:[process.argv[2]],"
                       "outfile:process.argv[3],bundle:true,platform:'node',format:'cjs',external:['jsdom']})"),
        str(esbuild), str(desktop / "e2e/researchServiceBridgeContract.ts"), str(bundle),
    ], cwd=desktop, capture_output=True, text=True, encoding="utf-8", timeout=30, check=False)
    assert build.returncode == 0, build.stderr
    profile = tmp_path / "isolated-desktop-contract"
    profile.mkdir()
    result = subprocess.run(["node", str(bundle), str(profile), sys.executable], cwd=desktop,
                            capture_output=True, text=True, encoding="utf-8", timeout=240,
                            env={**os.environ, "MISAKA_OFFLINE": "1", "NODE_PATH": str(desktop / "node_modules")},
                            check=False)
    (tmp_path / "contract-stdout.txt").write_text(result.stdout, encoding="utf-8")
    (tmp_path / "contract-stderr.txt").write_text(result.stderr, encoding="utf-8")
    report_file = profile / "contract-report.json"
    report = json.loads(report_file.read_text(encoding="utf-8")) if report_file.exists() else {}
    assert result.returncode == 0, f"{result.stderr}\n{json.dumps(report, ensure_ascii=False, indent=2)}"
    assert report["result"] == "passed"
    assert report["receipt"]["state"] in {"accepted", "applied"}
