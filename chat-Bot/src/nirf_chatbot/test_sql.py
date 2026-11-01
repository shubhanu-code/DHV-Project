from nirf_chatbot.llm import llm

print("Testing Sarvam API...")

response = llm.invoke("Reply with only: Hello")

print("Sarvam response:", response.content)