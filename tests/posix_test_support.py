"""Marks for tests of behaviour only POSIX has."""
import os

import pytest

# Windows reports every file as 0o666 and every directory as 0o777, and chmod there only flips
# the read-only attribute: privacy comes from the ACL of the user's profile instead.
modes = pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits; Windows keeps a profile private by ACL")
