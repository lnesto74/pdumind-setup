"""Train and save IsolationForest model for anomaly detection."""
import os
import sqlite3
import pandas as pd
from sklearn.ensemble import IsolationForest
import joblib

# Get database path from env or use default
DB_PATH = os.path.join("/Users/lnesto/CascadeProjects/PDUMind/data", "telemetry.db")

# Connect to database and get features for all outlets
with sqlite3.connect(DB_PATH) as conn:
    df = pd.read_sql(
        """
        SELECT outlet_id, current_a FROM outlet_telemetry
        WHERE current_a IS NOT NULL
        """,
        conn,
    )

# Compute mean and std per outlet
features = (
    df.groupby("outlet_id")
      .current_a
      .agg(["mean", "std"])
      .fillna(0.0)
)

# Train IsolationForest
model = IsolationForest(
    n_estimators=100,
    contamination=0.1,  # Expect ~10% anomalies
    random_state=42
)
model.fit(features[["mean", "std"]].values)

# Create models directory if it doesn't exist
os.makedirs(os.path.join("ml", "models"), exist_ok=True)

# Save model
model_path = os.path.join("ml", "models", "iso_forest.joblib")
joblib.dump(model, model_path)
print(f"Model saved to {model_path}")

# Test model
scores = model.decision_function(features[["mean", "std"]].values)
features["score"] = scores
print("\nTop 5 most anomalous outlets:")
print(features.sort_values("score").head())
