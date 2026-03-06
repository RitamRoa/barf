from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    redis_url: str = "redis://localhost:6379/0"
    allowed_origins: str = "*"
    max_upload_size_bytes: int = 10 * 1024 * 1024
    pairing_token_secret: str = "change-me-in-production"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
