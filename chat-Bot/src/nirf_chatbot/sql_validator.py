import sqlglot
from sqlglot import exp
ALLOWED_TABLE = "NIRF_2025"
def validate_sql(query: str):
    try:
        parsed = sqlglot.parse(query, read="postgres")
        if len(parsed) != 1:
            raise ValueError("Only one SQL statement is allowed")
        statement = parsed[0]
        if not isinstance(statement, exp.Select):
            raise ValueError("Only SELECT queries are allowed")
        tables = statement.find_all(exp.Table)
        for table in tables:
            if table.name != ALLOWED_TABLE:
                raise ValueError("Access to this table is not allowed")
        return True
    except Exception as e:
        raise ValueError(f"Invalid SQL: {e}")