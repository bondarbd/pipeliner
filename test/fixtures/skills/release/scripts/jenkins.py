#!/usr/bin/env python3
"""Mock of work-skills jenkins.py run-one. Project 'flaky' fails when MOCK_FAIL_ONCE marker is absent."""
import argparse, os, sys
ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd")
p = sp.add_parser("run-one"); p.add_argument("--project", required=True); p.add_argument("--branch", required=True); p.add_argument("--commit"); p.add_argument("--out", required=True); p.add_argument("--max-retries", type=int)
a = ap.parse_args()
if a.cmd != "run-one": sys.exit(f"unexpected {a.cmd}")
if os.environ.get("JENKINS_TOKEN") != "tok": sys.exit("no JENKINS_TOKEN in env")
marker = os.path.join(os.path.dirname(a.out), ".failed-once")
if a.project == "flaky" and not os.path.exists(marker):
    open(marker, "w").close(); print("attempt 1 FAILURE"); sys.exit(2)
print(f"build_url=https://jenkins/job/{a.project}/42/"); print("number=42"); print("result=SUCCESS"); print(f"commit={a.commit}"); print(f"dist=https://nexus/{a.project}-0.1.zip"); print("attempts=1")
