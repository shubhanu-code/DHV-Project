from sqlalchemy import text
from nirf_chatbot.database import engine
from nirf_chatbot.sql_validator import validate_sql
def exicute_sql(query:text):
    validate_sql(query)
    try:
        with engine.connect() as connection:
            with connection.begin():
                connection.execute(text("SET TRANSACTION READ ONLY"))
                connection.execute(
                    text("SET LOCAL statement_timeout = '5s'")
                )
                result = connection.execute(text(query))
                columns = list(result.keys())
                rows=result.mappings().fetchmany(100)
                return {
                    "columns": columns,
                    "rows": [dict(row) for row in rows]
                }
    except Exception as e:
        raise RuntimeError(f"SQL execution failed {e}")

