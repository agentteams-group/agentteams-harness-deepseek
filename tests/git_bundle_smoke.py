"""Verify the final runtime can independently check out an accepted offline bundle."""
from pathlib import Path
import subprocess
import tempfile


def git(directory, *arguments):
    return subprocess.check_output(["git", "-C", str(directory), *arguments], text=True, stderr=subprocess.STDOUT).strip()


def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "source"
        source.mkdir()
        git(source, "init", "-b", "fixture")
        (source / "page.html").write_text("<!doctype html><title>Bundle fixture</title>")
        git(source, "add", "page.html")
        git(source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
            "commit", "-m", "bundle fixture")
        head = git(source, "rev-parse", "HEAD")
        bundle = root / "accepted.bundle"
        git(source, "bundle", "create", str(bundle), "HEAD")
        checkout = root / "review"
        git(root, "clone", str(bundle), str(checkout))
        assert git(checkout, "rev-parse", "HEAD") == head
        assert (checkout / "page.html").read_bytes() == (source / "page.html").read_bytes()
        assert not git(checkout, "status", "--porcelain")
    print("PASS: final runtime Git can independently clone an offline bundle and verify exact HEAD/content")


if __name__ == "__main__":
    main()
