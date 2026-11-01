from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from nirf_chatbot.llm import llm
answer_prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        """
        You are an NIRF ranking assistant.

        Answer the user's question using only the
        database results provided.

        Rules:
        1. Do not invent rankings or scores.
        2. Do not add information absent from the results.
        3. Present numerical information accurately.
        4. If the results are empty, explain that no
           matching records were found.
        5. Keep answers clear and informative.
        """
    ),
    (
        "human",
        """
        User Question:
        {question}

        Database Results:
        {results}

        Generate a natural-language answer.
        """
    )
])

answer_chain = answer_prompt | llm | StrOutputParser()


def generate_answer(question: str, results: dict):
    return answer_chain.invoke({
        "question": question,
        "results": results
    })
if __name__=="__main__":
    response = generate_answer(
        question="Which is the best institute?",
        results=test_sql.result
    )
    print(response)