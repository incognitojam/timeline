"""Validate generated LaunchAgents with a real plist parser on Linux or macOS."""
import os
import plistlib
import sys
from pathlib import Path

def check(condition, message):
    if not condition:
        raise RuntimeError(message)


app = Path(sys.argv[1])
for name in ("service", "recall", "tailscale"):
    path = app / "Contents/Library/LaunchAgents" / f"dev.incognitojam.timeline-{name}.plist"
    with path.open("rb") as stream:
        plist = plistlib.load(stream)
    check(plist["Label"] == f"dev.incognitojam.timeline-{name}", f"{name}: label")
    check(plist["BundleProgram"] == "Contents/MacOS/TimelineAgent", f"{name}: bundle program")
    check(plist["ProgramArguments"] == ["TimelineAgent", name], f"{name}: arguments")
    check(plist["AssociatedBundleIdentifiers"] == ["com.incognitojam.timeline"], f"{name}: bundle identity")
    for key in ("Program", "StandardOutPath", "StandardErrorPath", "EnvironmentVariables", "WorkingDirectory"):
        check(key not in plist, f"{name}: unexpected {key}")
    check(os.environ["HOME"] not in path.read_text(), f"{name}: embedded home directory")
    if name == "recall":
        for key in ("StartInterval", "RunAtLoad", "KeepAlive", "ProcessType"):
            check(key not in plist, f"{name}: unexpected {key}")
    else:
        check(plist["RunAtLoad"] is True, f"{name}: run at load")
        check(plist["KeepAlive"] is True, f"{name}: keep alive")
    if name == "tailscale":
        check(plist["ProcessType"] == "Background", f"{name}: priority")
    else:
        check("ProcessType" not in plist, f"{name}: priority")
print("OK: generated LaunchAgent identities, arguments, priorities and inert Recall agent")
