"""Reconcile the dedicated Gmail routing group with active WFCRM Gmail grants."""

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener

from crm_transport import CrmConfig, NoRedirect, crm_post


IDENTITY = "https://cloudidentity.googleapis.com/v1/"
METADATA_TOKEN = (
    "http://metadata.google.internal/computeMetadata/v1/instance/"
    "service-accounts/default/token"
)


def request_json(request, *handlers):
    with build_opener(NoRedirect(), *handlers).open(request, timeout=10) as response:
        result = json.loads(response.read(262_144))
    if not isinstance(result, dict):
        raise ValueError("Expected a Google API JSON object")
    return result


def metadata_token():
    result = request_json(
        Request(METADATA_TOKEN, headers={"Metadata-Flavor": "Google"}), ProxyHandler({}),
    )
    token = result.get("access_token")
    if not isinstance(token, str) or not token:
        raise ValueError("Gateway VM has no Google access token")
    return token


def group_request(token, method, path, body=None):
    request = Request(
        IDENTITY + path,
        data=json.dumps(body).encode("utf-8") if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    try:
        result = request_json(request)
    except HTTPError as error:
        if (method, error.code) in {("POST", 409), ("DELETE", 404)}:
            return {}
        raise
    if result.get("error"):
        code = result["error"].get("code")
        if (method, code) not in {("POST", 6), ("DELETE", 5)}:
            raise ValueError(f"Cloud Identity membership operation failed (code {code})")
    return result


def current_members(request, group):
    members = {}
    page_tokens = set()
    params = {"view": "FULL", "pageSize": 100}
    while True:
        page = request("GET", f"{group}/memberships?{urlencode(params)}")
        for member in page.get("memberships", []):
            address = member["preferredMemberKey"]["id"].lower()
            name = member["name"]
            if address in members or not re.fullmatch(
                re.escape(group) + r"/memberships/[a-zA-Z0-9_-]+", name
            ):
                raise ValueError("Unexpected group membership identity")
            members[address] = member
        token = page.get("nextPageToken")
        if not token:
            return members
        if token in page_tokens:
            raise ValueError("Repeated Cloud Identity page token")
        page_tokens.add(token)
        params["pageToken"] = token


def reconcile(config, request, *, post=crm_post, apply=True):
    group = config.routing_group
    if not group:
        raise ValueError("No routing group configured")
    result = post(config, "connected-senders", {})
    senders = result.get("senders")
    if not isinstance(senders, list) or not all(
        isinstance(sender, str) and config.workspace_sender(sender) for sender in senders
    ):
        raise ValueError("Invalid CRM enrollment snapshot")

    desired = set(senders)
    existing = current_members(request, group)
    managed = {}
    for address, member in existing.items():
        # Service identities manage the group. Only direct work mailbox members
        # may belong to the routing audience, including during rollout.
        if member.get("type") == "SERVICE_ACCOUNT" and not config.workspace_sender(address):
            continue
        if (not config.workspace_sender(address) or member.get("type") != "USER"
                or {role["name"] for role in member["roles"]} != {"MEMBER"}):
            raise ValueError("Routing group has a nested or unmanaged membership")
        managed[address] = member["name"]

    remove = managed.keys() - desired
    add = desired - managed.keys()
    if apply:
        for address in sorted(remove):
            request("DELETE", managed[address])
        for address in sorted(add):
            request("POST", f"{group}/memberships", {
                "preferredMemberKey": {"id": address},
                "roles": [{"name": "MEMBER"}],
                "deliverySetting": "NONE",
            })
    return len(desired), len(add), len(remove)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        config = CrmConfig(**json.loads(args.config.read_text(encoding="utf-8")))
        token = metadata_token()
        desired, add, remove = reconcile(
            config, lambda *values: group_request(token, *values), apply=not args.dry_run,
        )
    except HTTPError as error:
        print(f"Routing group sync will retry (HTTP {error.code})", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Routing group sync will retry ({type(error).__name__})", file=sys.stderr)
        return 1
    print(f"Routing group sync: {desired} eligible, {add} additions, {remove} removals"
          + (" (dry run)" if args.dry_run else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
