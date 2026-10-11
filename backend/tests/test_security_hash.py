import pytest

from app import security


@pytest.fixture(params=["argon2", "scrypt"])
def mode(request, monkeypatch):
    if request.param == "scrypt":
        monkeypatch.setattr(security, "_hasher", None)
    elif security._hasher is None:
        pytest.skip("argon2-cffi not installed")
    return request.param


def test_roundtrip_and_rejections(mode):
    h = security.hash_password("correct horse battery")
    assert h.startswith("scrypt$" if mode == "scrypt" else "$argon2")
    assert security.verify_password("correct horse battery", h)
    assert not security.verify_password("wrong", h)
    assert not security.verify_password("x", None)
    assert not security.verify_password("x", "garbage")


def test_scrypt_hashes_verify_when_argon2_is_present(monkeypatch):
    monkeypatch.setattr(security, "_hasher", None)
    h = security.hash_password("pw-123456")
    monkeypatch.undo()
    assert security.verify_password("pw-123456", h)
