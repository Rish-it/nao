"""Unit tests for the reset_password command."""

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

REQUIRED_USER_COLUMNS = "id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, requires_password_reset INTEGER NOT NULL DEFAULT 0"
REQUIRED_ACCOUNT_COLUMNS = (
    "id TEXT PRIMARY KEY, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL, password TEXT"
)


def _create_test_db(tmp_path, requires_password_reset=0, with_rows=True):
    """Create a test SQLite database with user and account tables."""
    db_path = tmp_path / "db.sqlite"
    conn = sqlite3.connect(str(db_path))
    conn.execute(f"CREATE TABLE user ({REQUIRED_USER_COLUMNS})")
    conn.execute(f"CREATE TABLE account ({REQUIRED_ACCOUNT_COLUMNS})")
    if with_rows:
        conn.execute(
            "INSERT INTO user (id, name, email, requires_password_reset) VALUES (?, ?, ?, ?)",
            ("user-1", "Test User", "test@example.com", requires_password_reset),
        )
        conn.execute(
            "INSERT INTO account (id, account_id, provider_id, user_id, password) VALUES (?, ?, ?, ?, ?)",
            ("acc-1", "user-1", "credential", "user-1", "oldsalt:oldkey"),
        )
    conn.commit()
    conn.close()
    return db_path


@pytest.fixture
def test_db(tmp_path):
    """Create a test SQLite database with user and account tables."""
    return _create_test_db(tmp_path)


@pytest.fixture
def test_db_with_reset_flag(tmp_path):
    """Create a test database where the user requires a password reset."""
    return _create_test_db(tmp_path, requires_password_reset=1)


@pytest.fixture
def empty_db(tmp_path):
    """Create a test database with schema but no rows."""
    return _create_test_db(tmp_path, with_rows=False)


class TestValidatePassword:
    """Tests for password validation logic."""

    def test_valid_password(self):
        """Strong password passes all checks."""
        assert _validate_password("MyP@ss1234") is True

    def test_missing_uppercase(self):
        """Password without uppercase fails."""
        assert _validate_password("myp@ss1234") is False

    def test_missing_lowercase(self):
        """Password without lowercase fails."""
        assert _validate_password("MYP@SS1234") is False

    def test_missing_number(self):
        """Password without a digit fails."""
        assert _validate_password("MyP@ssword") is False

    def test_missing_special_char(self):
        """Password without a special character fails."""
        assert _validate_password("MyPass1234") is False

    def test_too_short(self):
        """Password under 8 characters fails."""
        assert _validate_password("M@1aaaa") is False

    def test_exactly_8_chars_valid(self):
        """Exactly 8 character strong password passes."""
        assert _validate_password("M@1aaaaa") is True


class TestHashPassword:
    """Tests for scrypt password hashing."""

    def test_hash_format(self):
        """Hash output is hex_salt:hex_key format."""
        result = _hash_password("testpassword")
        salt_hex, key_hex = result.split(":")
        assert len(salt_hex) == 32
        assert len(key_hex) == 128
        assert all(c in "0123456789abcdef" for c in salt_hex)
        assert all(c in "0123456789abcdef" for c in key_hex)

    def test_hash_is_verifiable(self):
        """Hash can be independently recomputed from salt and password."""
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
        """Different passwords produce different hashes."""
        h1 = _hash_password("password1")
        h2 = _hash_password("password2")
        assert h1 != h2

    def test_same_password_different_salts(self):
        """Same password produces different hashes due to random salt."""
        h1 = _hash_password("samepassword")
        h2 = _hash_password("samepassword")
        assert h1 != h2


class TestResolveDbPath:
    """Tests for database path resolution."""

    def test_default_path(self, tmp_path, monkeypatch):
        """Default path is bin_dir/db.sqlite resolved from the command module."""
        monkeypatch.delenv("DB_URI", raising=False)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        db_file = bin_dir / "db.sqlite"
        db_file.touch()

        with patch("nao_core.commands.reset_password.Path") as mock_path_cls:
            mock_path_cls.return_value.parent.parent = tmp_path
            result = _resolve_db_path()
            assert result == db_file

    def test_postgres_uri_exits(self, monkeypatch):
        """PostgreSQL URI triggers an error exit."""
        monkeypatch.setenv("DB_URI", "postgres://user:pass@localhost/mydb")
        with pytest.raises(SystemExit) as exc_info:
            _resolve_db_path()
        assert exc_info.value.code == 1

    def test_missing_db_file_exits(self, tmp_path, monkeypatch):
        """Non-existent database file triggers an error exit."""
        monkeypatch.setenv("DB_URI", f"sqlite:{tmp_path / 'nonexistent.sqlite'}")
        with pytest.raises(SystemExit) as exc_info:
            _resolve_db_path()
        assert exc_info.value.code == 1

    def test_custom_sqlite_uri(self, tmp_path, monkeypatch):
        """Custom sqlite: URI is resolved to the correct path."""
        db_file = tmp_path / "custom.db"
        db_file.touch()
        monkeypatch.setenv("DB_URI", f"sqlite:{db_file}")
        result = _resolve_db_path()
        assert result == db_file


class TestResetPasswordCommand:
    """Tests for the reset_password command flow."""

    @patch("nao_core.commands.reset_password.ask_confirm")
    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_successful_reset(self, mock_ui, mock_ask_text, mock_ask_confirm, test_db, monkeypatch):
        """Full happy path: email lookup, valid password, confirm, DB updated."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")
        mock_ask_text.side_effect = ["test@example.com", "NewP@ss1234", "NewP@ss1234"]
        mock_ask_confirm.return_value = True

        reset_password()

        conn = sqlite3.connect(str(test_db))
        new_hash = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        reset_flag = conn.execute("SELECT requires_password_reset FROM user WHERE id = 'user-1'").fetchone()[0]
        conn.close()

        assert new_hash != "oldsalt:oldkey"
        assert ":" in new_hash
        assert reset_flag == 0

    @patch("nao_core.commands.reset_password.ask_confirm")
    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_clears_password_reset_flag(
        self, mock_ui, mock_ask_text, mock_ask_confirm, test_db_with_reset_flag, monkeypatch
    ):
        """Requires_password_reset flag is cleared from 1 to 0."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db_with_reset_flag}")
        mock_ask_text.side_effect = ["test@example.com", "NewP@ss1234", "NewP@ss1234"]
        mock_ask_confirm.return_value = True

        reset_password()

        conn = sqlite3.connect(str(test_db_with_reset_flag))
        reset_flag = conn.execute("SELECT requires_password_reset FROM user WHERE id = 'user-1'").fetchone()[0]
        conn.close()

        assert reset_flag == 0

    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_user_not_found(self, mock_ui, mock_ask_text, test_db, monkeypatch):
        """Exits with error when email does not match any user."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")
        mock_ask_text.return_value = "nobody@example.com"

        with pytest.raises(SystemExit) as exc_info:
            reset_password()

        assert exc_info.value.code == 1

    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_empty_database(self, mock_ui, mock_ask_text, empty_db, monkeypatch):
        """Exits with error when database has no users."""
        monkeypatch.setenv("DB_URI", f"sqlite:{empty_db}")
        mock_ask_text.return_value = "anyone@example.com"

        with pytest.raises(SystemExit) as exc_info:
            reset_password()

        assert exc_info.value.code == 1

    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_no_credential_account(self, mock_ui, mock_ask_text, test_db, monkeypatch):
        """Exits with error when user has no credential provider."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")

        conn = sqlite3.connect(str(test_db))
        conn.execute("UPDATE account SET provider_id = 'google' WHERE id = 'acc-1'")
        conn.commit()
        conn.close()

        mock_ask_text.return_value = "test@example.com"

        with pytest.raises(SystemExit) as exc_info:
            reset_password()

        assert exc_info.value.code == 1

    @patch("nao_core.commands.reset_password.ask_confirm")
    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_user_cancels(self, mock_ui, mock_ask_text, mock_ask_confirm, test_db, monkeypatch):
        """Password is unchanged when user declines confirmation."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")
        mock_ask_text.side_effect = ["test@example.com", "NewP@ss1234", "NewP@ss1234"]
        mock_ask_confirm.return_value = False

        reset_password()

        conn = sqlite3.connect(str(test_db))
        stored = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        conn.close()
        assert stored == "oldsalt:oldkey"

    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_keyboard_interrupt_during_email(self, mock_ui, mock_ask_text, test_db, monkeypatch):
        """Ctrl+C during email prompt leaves password unchanged."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")
        mock_ask_text.side_effect = KeyboardInterrupt

        with pytest.raises(KeyboardInterrupt):
            reset_password()

        conn = sqlite3.connect(str(test_db))
        stored = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        conn.close()
        assert stored == "oldsalt:oldkey"

    @patch("nao_core.commands.reset_password.ask_confirm")
    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_weak_password_then_valid(self, mock_ui, mock_ask_text, mock_ask_confirm, test_db, monkeypatch):
        """Retry loop accepts password after initial weak attempt."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")
        mock_ask_text.side_effect = ["test@example.com", "weak", "MyStr0ng!Pass", "MyStr0ng!Pass"]
        mock_ask_confirm.return_value = True

        reset_password()

        conn = sqlite3.connect(str(test_db))
        new_hash = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        conn.close()
        assert new_hash != "oldsalt:oldkey"

    @patch("nao_core.commands.reset_password.ask_confirm")
    @patch("nao_core.commands.reset_password.ask_text")
    @patch("nao_core.commands.reset_password.UI")
    def test_password_mismatch_then_match(self, mock_ui, mock_ask_text, mock_ask_confirm, test_db, monkeypatch):
        """Retry loop accepts password after initial mismatch."""
        monkeypatch.setenv("DB_URI", f"sqlite:{test_db}")
        mock_ask_text.side_effect = [
            "test@example.com",
            "MyStr0ng!Pass",
            "Different1!",
            "MyStr0ng!Pass",
            "MyStr0ng!Pass",
        ]
        mock_ask_confirm.return_value = True

        reset_password()

        conn = sqlite3.connect(str(test_db))
        new_hash = conn.execute("SELECT password FROM account WHERE id = 'acc-1'").fetchone()[0]
        conn.close()
        assert new_hash != "oldsalt:oldkey"
