import unittest
from types import SimpleNamespace
from urllib.error import URLError
from unittest.mock import Mock

from sync_routing_group import reconcile


GROUP = "groups/routing-test"
NEW = "new@example.test"
STAY = "stay@example.test"
STALE = "stale@example.test"
OWNER = "gateway@cloud-project.iam.gserviceaccount.com"


def member(address, resource_id, *, member_type="USER", role="MEMBER"):
    return {
        "preferredMemberKey": {"id": address},
        "name": f"{GROUP}/memberships/{resource_id}",
        "type": member_type,
        "roles": [{"name": role}],
    }


class RoutingGroupTest(unittest.TestCase):
    def setUp(self):
        self.config = SimpleNamespace(
            routing_group=GROUP, workspace_sender=lambda address: address.endswith("@example.test"),
        )
        self.post = Mock(return_value={"senders": [NEW, STAY]})

    def test_adds_and_removes_across_pages_then_has_no_work_on_retry(self):
        existing = {
            STAY: member(STAY, "stay"), STALE: member(STALE, "stale"),
            OWNER: member(OWNER, "owner", member_type="SERVICE_ACCOUNT", role="OWNER"),
        }
        calls = []

        def request(method, path, body=None):
            calls.append((method, path))
            if method == "GET" and "pageToken" not in path:
                return {"memberships": [existing[STAY]], "nextPageToken": "next"}
            if method == "GET":
                return {"memberships": [record for email, record in existing.items() if email != STAY]}
            if method == "DELETE":
                self.assertEqual(path, f"{GROUP}/memberships/stale")
                del existing[STALE]
            if method == "POST":
                self.assertEqual(body, {
                    "preferredMemberKey": {"id": NEW},
                    "roles": [{"name": "MEMBER"}],
                    "deliverySetting": "NONE",
                })
                existing[NEW] = member(NEW, "new")

        self.assertEqual(reconcile(self.config, request, post=self.post, apply=False), (2, 1, 1))
        self.assertEqual([method for method, _ in calls], ["GET", "GET"])
        self.assertEqual(reconcile(self.config, request, post=self.post), (2, 1, 1))
        self.assertEqual(reconcile(self.config, request, post=self.post), (2, 0, 0))
        self.assertEqual(set(existing), {STAY, NEW, OWNER})

    def test_no_mutation_on_unavailable_or_invalid_snapshot(self):
        request = Mock()
        self.post.side_effect = URLError("CRM unavailable")
        with self.assertRaises(URLError):
            reconcile(self.config, request, post=self.post)
        self.post.side_effect = None
        self.post.return_value = {"senders": ["person@external.test"]}
        with self.assertRaises(ValueError):
            reconcile(self.config, request, post=self.post)
        request.assert_not_called()

    def test_never_mutates_an_unmanaged_or_nested_group(self):
        for unsafe in (
            member(STALE, "manager", role="MANAGER"),
            member(STALE, "nested", member_type="GROUP"),
            member("member@other.test", "outside"),
        ):
            with self.subTest(member=unsafe):
                request = Mock(return_value={"memberships": [unsafe]})
                with self.assertRaises(ValueError):
                    reconcile(self.config, request, post=self.post)
                request.assert_called_once()


if __name__ == "__main__":
    unittest.main()
