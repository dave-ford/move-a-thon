import base64
import hashlib
import hmac
import time
from typing import Literal

from .config import settings


Role = Literal["admin", "official"]


def hash_secret(value: str, salt: str) -> str:
    return hmac.new(salt.encode(), value.encode(), hashlib.sha256).hexdigest()


def verify_secret(value: str, salt: str, digest: str) -> bool:
    return hmac.compare_digest(hash_secret(value, salt), digest)


def sign_token(role: Role, ttl_seconds: int = 60 * 60 * 12) -> str:
    expires = int(time.time()) + ttl_seconds
    body = f"{role}:{expires}"
    sig = hmac.new(settings.secret_key.encode(), body.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(body.encode() + b"." + sig).decode()


def verify_token(token: str | None, role: Role) -> bool:
    if not token:
        return False
    try:
        raw = base64.urlsafe_b64decode(token.encode())
        body, sig = raw.rsplit(b".", 1)
        expected = hmac.new(settings.secret_key.encode(), body, hashlib.sha256).digest()
        decoded_role, expires = body.decode().split(":", 1)
    except Exception:
        return False
    return (
        hmac.compare_digest(sig, expected)
        and decoded_role == role
        and int(expires) >= int(time.time())
    )
