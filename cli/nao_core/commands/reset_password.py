"""Reset a local user's password directly in the SQLite database."""

import hashlib
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

from nao_core.tracking import track_command
from nao_core.ui import UI, ask_confirm, ask_text

SCRYPT_N = 16384
SCRYPT_R = 16
SCRYPT_P = 1
SCRYPT_DKLEN = 64
SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2

PASSWORD_REGEX = re.compile(r"^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*\-]).{8,}$")


def _hash_password(password: str) -> str:
    """Hash a password using scrypt, matching better-auth's format."""
    salt_hex = os.urandom(16).hex()
    normalized = unicodedata.normalize("NFKC", password)
    key = hashlib.scrypt(
        normalized.encode("utf-8"),
        salt=salt_hex.encode("utf-8"),
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=SCRYPT_DKLEN,
        maxmem=SCRYPT_MAXMEM,
    )
    return f"{salt_hex}:{key.hex()}"


def _validate_password(password: str) -> bool:
    """Check password meets strength requirements."""
    return bool(PASSWORD_REGEX.match(password))


def _resolve_db_path() -> Path:
    """Locate the SQLite database file."""
    db_uri = os.environ.get("DB_URI", "")

    if db_uri.startswith("postgres://") or db_uri.startswith("postgresql://"):
        UI.error("This command only works with local SQLite databases.")
        UI.print("[dim]For PostgreSQL, reset the password directly in your database.[/dim]")
        sys.exit(1)

    if db_uri.startswith("sqlite:"):
        db_path = Path(db_uri[len("sqlite:") :])
    elif db_uri:
        db_path = Path(db_uri)
    else:
        bin_dir = Path(__file__).parent.parent / "bin"
        db_path = bin_dir / "db.sqlite"

        if not db_path.exists():
            dev_path = Path(__file__).parent.parent.parent.parent / "apps" / "backend" / "db.sqlite"
            if dev_path.exists():
                db_path = dev_path

    if not db_path.exists():
        UI.error(f"Database not found at {db_path}")
        UI.print("[dim]Make sure you have started the app at least once with 'nao chat'.[/dim]")
        sys.exit(1)

    return db_path


@track_command("reset-password")
def reset_password():
    """Reset a local user's password.

    Directly updates the password in the local SQLite database.
    Use this when SMTP is not configured and you've forgotten your password.
    """
    UI.print("\n[bold cyan]🔑 Password Reset[/bold cyan]\n")

    db_path = _resolve_db_path()
    UI.success(f"Found database at {db_path}")

    email = ask_text("Email address:", required_field=True)

    conn = sqlite3.connect(str(db_path))
    try:
        row = conn.execute(
            "SELECT u.id, u.name FROM user u WHERE u.email = ?",
            (email,),
        ).fetchone()

        if not row:
            UI.error(f"No user found with email: {email}")
            sys.exit(1)

        user_id, user_name = row

        account = conn.execute(
            "SELECT id FROM account WHERE user_id = ? AND provider_id = 'credential'",
            (user_id,),
        ).fetchone()

        if not account:
            UI.error("This user does not use password authentication (e.g. signed up via Google/GitHub).")
            sys.exit(1)

        account_id = account[0]
        UI.info(f"Found user: {user_name} ({email})")

        while True:
            new_password = ask_text("New password:", password=True, required_field=True)
            if not new_password or not _validate_password(new_password):
                if new_password is not None:
                    UI.warn(
                        "Password must be at least 8 characters and include "
                        "uppercase, lowercase, number, and special character."
                    )
                continue

            confirm_password = ask_text("Confirm password:", password=True, required_field=True)
            if not new_password or not confirm_password or new_password != confirm_password:
                UI.warn("Passwords do not match. Try again.")
                continue

            break

        if not ask_confirm(f"Reset password for {user_name} ({email})?"):
            UI.print("Cancelled.")
            return

        hashed = _hash_password(new_password)

        conn.execute("UPDATE account SET password = ? WHERE id = ?", (hashed, account_id))
        conn.execute("UPDATE user SET requires_password_reset = 0 WHERE id = ?", (user_id,))
        conn.commit()

        UI.success("Password has been reset. You can now log in with your new password.")

    except sqlite3.Error as e:
        UI.error(f"Database error: {e}")
        sys.exit(1)
    finally:
        conn.close()
