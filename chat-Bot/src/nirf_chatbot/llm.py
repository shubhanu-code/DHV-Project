from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from langchain_sarvam import ChatSarvam
BASE_DIR = Path(__file__).resolve().parents[2]
from . import Settings
llm = ChatSarvam(
    model="sarvam-105b",
    api_key=Settings.gemini(),
    temperature=0
)
