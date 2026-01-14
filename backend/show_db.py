import sqlite3
import os

DB_PATH = os.path.join(os.getenv("DATA_DIR", "data"), "telemetry.db")

def show_tables():
    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        tables = cur.fetchall()
        print("\nAvailable tables:")
        print("----------------")
        for (table,) in tables:
            print(table)
            # Show sample data
            try:
                cur = conn.execute(f"SELECT * FROM {table} LIMIT 5")
                cols = [description[0] for description in cur.description]
                print("\nColumns:", ", ".join(cols))
                rows = cur.fetchall()
                if rows:
                    print("\nSample rows:")
                    for row in rows:
                        print(row)
                else:
                    print("\nNo data yet")
                print("\n" + "-"*50)
            except sqlite3.Error as e:
                print(f"Error querying {table}: {e}\n")

if __name__ == "__main__":
    show_tables()
