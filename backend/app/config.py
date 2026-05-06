import os


class Settings:
    database_url: str = os.getenv("DATABASE_URL", "postgresql://moveathon:moveathon@localhost:5432/moveathon")
    admin_pin: str = os.getenv("ADMIN_PIN", "1234")
    secret_key: str = os.getenv("SECRET_KEY", "dev-secret-change-me")
    cors_origin: str = os.getenv("CORS_ORIGIN", "")


settings = Settings()
