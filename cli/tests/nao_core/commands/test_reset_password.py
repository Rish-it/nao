import hashlib
import sqlite3
import unicodedata
from unittest.mock import patch

import pytest

from nao_core.commands.reset_password import (
    SCRYPT_DKLEN,
    SCRYPT_MAXMEM,
    SCRYPT_N,
    SCRYPT_P,
    SCRYPT_R,
    _hash_password,
    _resolve_db_path,
    _validate_password,
    reset_password,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

REQUIRED_USER_COLUMNS = "id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, requires_password_reset INTEGER NOT NULL DEFAULT 0"
REQUIRED_ACCOUNT_COLUMNS = (
    "id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL, password TEXT"
)


@pytest.fixture
def test_db(tmp_path):
    """Create a test SQLite database with user and account tables."""
    db_path = tmp_path / "db.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.execute(f"CREATE TABLE user ({REQUIRED_USER_COLUMNS})")
    conn.execute(f"CREATE TABLE account ({REQUIRED_ACCOUNT_COLUMNS})")
    conn.execute(
        "INSERT INTO user (id, name, email, requires_password_reset) VALUES (?, ?, ?, 0)",
        ("user-1", "Test User", "test@example.com"),
    )
    conn.execute(
        "INSERT INTO account (id, account_id, provider_id, user_id, password) VALUES (?, ?, ?, ?, ?)",
        ("acc-1", "user-1", "credential", "user-1", "oldsalt:oldkey"),
    )
    conn.commit()
    conn.close()
    return db_path


# ---------------------------------------------------------------------------
# _validate_password
# ---------------------------------------------------------------------------


class TestValidatePassword:
    def test_valid_password(self):
        assert _validate_password("MyP@ss1234") is True

    def test_missing_uppercase(self):
        assert _validate_password("myp@ss1234") is False

    def test_missing_lowercase(self):
        assert _validate_password("MYP@SS1234") is False

    def test_missing_number(self):
        assert _validate_password("MyP@ssword") is False

    def test_missing_special_char(self):
        assert _validate_password("MyPass1234") is False

    def test_too_short(self):
        assert _validate_password("M@1aaaa") is False

    def test_exactly_8_chars_valid(self):
        assert _validate_password("M@1aaaaa") is True


# ---------------------------------------------------------------------------
# _hash_password
# ---------------------------------------------------------------------------


class TestHashPassword:
    def test_hash_format(self):
        result = _hash_password("testpassword")
        salt_hex, key_hex = result.split(":")
        assert len(salt_hex) == 32
        assert len(key_hex) == 128
        assert all(c in "0123456789abcdef" for c in salt_hex)
        assert all(c in "0123456789abcdef" for c in key_hex)

    def test_hash_is_verifiable(self):
        password = "MyP@ss1234"
        result = _hash_password(password)
        salt_hex, key_hex = result.split(":")
        normalized = unicodedata.normalize("NFKC", password)
        expected_key = hashlib.scrypt(
            normalized.encode("utf-8"),
            salt=salt_hex.encode("utf-8"),
            n=SCRYPT_N,
            r=SCRYPT_R,
            p=SCRYPT_P,
            dklen=SCRYPT_DKLEN,
            maxmem=SCRYPT_MAXMEM,
        )
        assert key_hex == expected_key.hex()

    def test_different_passwords_different_hashes(self):
        h1 = _hash_password("password1")
        h2 = _hash_password("password2")
        assert h1 != h2

    def test_same_password_different_salts(self):
        h1 = _hash_password("samepassword")
        h2 = _hash_password("samepassword")
        assert h1 != h2


# ---------------------------------------------------------------------------
# _resolve_db_path
# ---------------------------------------------------------------------------


class TestResolveDbPath:
    def test_default_path(self, tmp_path, monkeypatch):
        """Default path is bin_dir/db.sqlite resolved from the command module."""
        monkeypatch.delenv("DB_URI", raising=False)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        db_file = bin_dir / "db.sqlite"
        db_file.touch()

        with patch("nao_core.commands.reset_password.Path") as mock_path_cls:
            # Path(__file__).parent.parent → tmp_path (so that / "bin" gives bin_dir)
            mock_path_cls.return_value.parent.parent = tmp_path
            result = _resolve_db_path()
            assert result == db_file

    def test_postgres_uri_exits(self, monkeypatch):
        monkeypatch.setenv("DB_URI", "postgres://user:pass@localhost/mydb")
        with pytest.raises(SystemExit) as exc_info:
            _resolve_db_path()
        assert exc_info.value.code == 1

    def test_missing_db_file_exits(self, tmp_path, monkeypatch):
        monkeypatch.setenv("DB_URI", f"sqlite:{tmp_path / 'nonexistent.sqlite'}")
        with pytest.raises(SystemExit) as exc_info:
            _resolve_db_path()
        assert exc_info.value.code == 1

    def test_custom_sqlite_uri(self, tmp_path, monkeypatch):
        db_file = tmp_path / "custom.db"
        db_file.touch()
        monkeypatch.setenv("DB_URI", f"sqlite:{db_file}")
        result = _resolve_db_path()
        assert result == db_file


# ---------------------------------------------------------------------------
# reset_password command
# ---------------------------------------------------------------------------


class TestResetPasswordCommand:
    def test_successful_reset(self, test_db, monkeypatch):
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")

        ask_responses = iter(
            [
                "test@example.com",  # email
                "NewP@ss1234",  # new password
                "NewP@ss1234",  # confirm password
            ]
        )
        confirm_responses = iter([True])

        with (
            patch("nao_core.commands.reset_password.ask_text", side_effect=lambda *a, **kw: next(ask_responses)),
            patch("nao_core.commands.reset_password.ask_confirm", side_effect=lambda *a, **kw: next(confirm_responses)),
            patch("nao_core.commands.reset_password.console"),
        ):
            reset_password()

        conn = sqlite3.connect(str(test_db))
        new_hash = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        reset_flag = conn.execute("SELECT requires_password_reset FROM user WHERE id = 'user-1'").fetchone()[0]
        conn.close()

        assert new_hash != "oldsalt:oldkey"
        assert ":" in new_hash
        assert reset_flag == 0

    def test_user_not_found(self, test_db, monkeypatch):
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")

        with (
            patch("nao_core.commands.reset_password.ask_text", return_value="nobody@example.com"),
            pytest.raises(SystemExit) as exc_info,
            patch("nao_core.commands.reset_password.console"),
        ):
            reset_password()

        assert exc_info.value.code == 1

    def test_no_credential_account(self, test_db, monkeypatch):
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")

        conn = sqlite3.connect(str(test_db))
        conn.execute("UPDATE account SET provider_id = 'google' WHERE id = 'acc-1'")
        conn.commit()
        conn.close()

        with (
            patch("nao_core.commands.reset_password.ask_text", return_value="test@example.com"),
            pytest.raises(SystemExit) as exc_info,
            patch("nao_core.commands.reset_password.console"),
        ):
            reset_password()

        assert exc_info.value.code == 1

    def test_user_cancels(self, test_db, monkeypatch):
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")

        ask_responses = iter(
            [
                "test@example.com",  # email
                "NewP@ss1234",  # new password
                "NewP@ss1234",  # confirm password
            ]
        )

        with (
            patch("nao_core.commands.reset_password.ask_text", side_effect=lambda *a, **kw: next(ask_responses)),
            patch("nao_core.commands.reset_password.ask_confirm", return_value=False),
            patch("nao_core.commands.reset_password.console"),
        ):
            reset_password()

        conn = sqlite3.connect(str(test_db))
        stored = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        conn.close()
        assert stored == "oldsalt:oldkey"

    def test_weak_password_then_valid(self, test_db, monkeypatch):
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")

        ask_responses = iter(
            [
                "test@example.com",  # email
                "weak",  # weak password
                "MyStr0ng!Pass",  # valid password
                "MyStr0ng!Pass",  # confirm password
            ]
        )
        confirm_responses = iter([True])

        with (
            patch("nao_core.commands.reset_password.ask_text", side_effect=lambda *a, **kw: next(ask_responses)),
            patch("nao_core.commands.reset_password.ask_confirm", side_effect=lambda *a, **kw: next(confirm_responses)),
            patch("nao_core.commands.reset_password.console"),
        ):
            reset_password()

        conn = sqlite3.connect(str(test_db))
        new_hash = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        conn.close()
        assert new_hash != "oldsalt:oldkey"

    def test_password_mismatch_then_match(self, test_db, monkeypatch):
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")

        ask_responses = iter(
            [
                "test@example.com",  # email
                "MyStr0ng!Pass",  # new password
                "Different1!",  # wrong confirm
                "MyStr0ng!Pass",  # retry new password
                "MyStr0ng!Pass",  # correct confirm
            ]
        )
        confirm_responses = iter([True])

        with (
            patch("nao_core.commands.reset_password.ask_text", side_effect=lambda *a, **kw: next(ask_responses)),
            patch("nao_core.commands.reset_password.ask_confirm", side_effect=lambda *a, **kw: next(confirm_responses)),
            patch("nao_core.commands.reset_password.console"),
        ):
            reset_password()

        conn = sqlite3.connect(str(test_db))
        new_hash = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        conn.close()
        assert new_hash != "oldsalt:oldkey"
