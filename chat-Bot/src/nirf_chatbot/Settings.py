import os
from dotenv import load_dotenv
load_dotenv()
def gemini():
    return os.getenv("SARVAM")
    