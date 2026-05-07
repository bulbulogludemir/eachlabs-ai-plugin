#!/usr/bin/env python3
"""Credential-free smoke check for the public each::labs model listing API."""

from __future__ import annotations

import json
import ssl
import subprocess
import sys
import urllib.error
import urllib.request


MODELS_URL = "https://api.eachlabs.ai/v1/models?limit=3"


def main() -> int:
    try:
        payload = fetch_models()
    except urllib.error.HTTPError as exc:
        print(f"each::labs model listing failed with HTTP {exc.code}", file=sys.stderr)
        return 1
    except (urllib.error.URLError, TimeoutError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"each::labs model listing failed: {exc}", file=sys.stderr)
        return 1

    if not isinstance(payload, list):
        print("Unexpected response: expected a list of models", file=sys.stderr)
        return 1

    print(f"Fetched {len(payload)} public each::labs models")
    for model in payload:
        title = model.get("title", "<untitled>") if isinstance(model, dict) else "<invalid>"
        slug = model.get("slug", "<missing-slug>") if isinstance(model, dict) else "<invalid>"
        print(f"- {title} ({slug})")

    return 0


def fetch_models() -> object:
    request = urllib.request.Request(
        MODELS_URL,
        headers={"Accept": "application/json", "User-Agent": "codex-eachlabs-plugin-smoke/0.1"},
    )

    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.URLError as exc:
        if not is_certificate_error(exc):
            raise

    # Some macOS Python installations do not have a configured certificate
    # bundle. Fall back to system curl, which uses the OS trust store.
    result = subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", MODELS_URL],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    return json.loads(result.stdout)


def is_certificate_error(exc: urllib.error.URLError) -> bool:
    reason = getattr(exc, "reason", None)
    return isinstance(reason, ssl.SSLCertVerificationError)


if __name__ == "__main__":
    raise SystemExit(main())
