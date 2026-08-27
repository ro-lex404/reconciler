import duckdb
import os

def execute_text_to_sql(csv_file_path: str, sql_query: str) -> str:
    """
    Creates an in-memory DuckDB instance, loads the CSV as 'user_data', 
    and runs the generated SQL against it.
    """
    # Ensure the file actually exists before we try to query it
    if not os.path.exists(csv_file_path):
        return f"Error: Could not find the file at {csv_file_path}"
        
    try:
        # Create an ephemeral DuckDB connection in memory
        con = duckdb.connect(database=':memory:')
        
        # This is the magic! It maps the physical CSV file to a virtual 
        # table named 'user_data' so the LLM can query it normally.
        con.execute(f"CREATE VIEW user_data AS SELECT * FROM read_csv_auto('{csv_file_path}')")
        
        # Execute the LLM's SQL query and fetch the results as a Pandas DataFrame
        result_df = con.execute(sql_query).df()
        
        # Return the DataFrame as a formatted string for the Synthesizer node to read
        return result_df.to_string()
        
    except Exception as e:
        return f"DuckDB Execution Error: {str(e)}"
        
    finally:
        # Always close the connection to prevent memory leaks
        con.close()