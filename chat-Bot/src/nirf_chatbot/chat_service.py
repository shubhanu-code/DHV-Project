from nirf_chatbot.llm import llm
from nirf_chatbot.sql_engine import sql_prompt
from nirf_chatbot.sql_executor import exicute_sql
from nirf_chatbot.answer_engine import generate_answer

from langchain_core.output_parsers import StrOutputParser


sql_chain = sql_prompt | llm | StrOutputParser()

def process_question(question: str):

    print("STEP 1: Generating SQL...")

    generated_sql = sql_chain.invoke({
        "question": question
    })

    print("STEP 2: SQL generated:", generated_sql)

    print("STEP 3: Executing SQL...")

    results = execute_sql(generated_sql)

    print("STEP 4: SQL executed successfully")

    print("STEP 5: Generating final answer...")

    answer = generate_answer(
        question=question,
        results=results
    )

    print("STEP 6: Final answer generated")

    return {
        "question": question,
        "generated_sql": generated_sql,
        "results": results,
        "answer": answer
    }
def process_question(question: str):

    # Step 1: Generate SQL
    generated_sql = sql_chain.invoke({
        "question": question,
        "schema": "Your NIRF_2025 database schema"
    })

    # Step 2: Execute SQL
    results = exicute_sql(generated_sql)

    # Step 3: Generate final answer
    answer = generate_answer(
        question=question,
        results=results
    )

    return {
        "question": question,
        "generated_sql": generated_sql,
        "results": results,
        "answer": answer
    }