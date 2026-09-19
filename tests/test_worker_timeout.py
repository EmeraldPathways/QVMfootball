import unittest

from worker_timeout import MIN_SITE_SYNC_TIMEOUT_SECONDS, site_sync_timeout_seconds


class WorkerTimeoutTests(unittest.TestCase):
    def test_site_sync_timeout_is_longer_than_the_provider_timeout(self):
        self.assertEqual(MIN_SITE_SYNC_TIMEOUT_SECONDS, 300)
        self.assertEqual(site_sync_timeout_seconds(10), 300)
        self.assertEqual(site_sync_timeout_seconds(180), 300)
        self.assertEqual(site_sync_timeout_seconds(450), 450)


if __name__ == "__main__":
    unittest.main()
