from datetime import timedelta
import json
import os
import unittest
from unittest import mock

import sparkle_deltas
from test_edge_build import START, TAG, build_assets, release


class SourcesTests(unittest.TestCase):
    def sources(self, value, current):
        def read(*args):
            command = " ".join(args)
            if command.endswith(f"releases/tags/{TAG}"):
                return json.dumps(value)
            if "releases/latest" in command:
                return "v0.21.0"
            if "print-build-number" in command:
                return "1341"
            raise AssertionError(command)
        with mock.patch.object(sparkle_deltas, "read", read), mock.patch.dict(os.environ, {"GH_REPO": "example/timeline"}):
            return [build for build, _, _ in sparkle_deltas.sources(TAG, current)]

    def test_are_the_same_before_and_after_this_build_is_uploaded(self):
        # Build 1401 stood 5 hours; builds 1402-1406 were short-lived.
        times = {1400: START, 1401: START + timedelta(minutes=10)}
        times |= {b: times[1401] + timedelta(hours=5, minutes=10 * (b - 1402)) for b in range(1402, 1408)}
        names = ["appcast.xml", *build_assets(*range(1400, 1407))]
        before = release(names, times)
        after = release(names + build_assets(1407), times)
        for value in (before, after):
            for asset in value["assets"]:
                asset["state"] = "uploaded"
        self.assertEqual(self.sources(before, 1407), [1406, 1405, 1404, 1403, 1402, 1401, 1341])
        self.assertEqual(self.sources(after, 1407), self.sources(before, 1407))


if __name__ == "__main__":
    unittest.main()
