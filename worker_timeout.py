"""Timeout policy for the Windows worker's hosted Site synchronisation."""

MIN_SITE_SYNC_TIMEOUT_SECONDS = 300


def site_sync_timeout_seconds(request_timeout_seconds: float) -> float:
    """Allow the Site sync to outlast short provider requests."""

    return max(float(request_timeout_seconds), MIN_SITE_SYNC_TIMEOUT_SECONDS)
