from sqlalchemy import create_engine,text
from sqlalchemy.orm import sessionmaker,declarative_base
from pydantic_settings import BaseSettings,SettingsConfigDict
class Settings(BaseSettings):
    DATABASE_URL:str
    model_config= SettingsConfigDict(
        env_file=".env",
        extra="ignore"
    )
settings=Settings()
engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True
)
SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)
Base= declarative_base()
def get_db():
    db=SessionLocal()
    try:
        yield db
    finally:
        db.close()
def check_db_connection():
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return True
    except Exception as e:
        print(f"Database error: {e}")
        return False