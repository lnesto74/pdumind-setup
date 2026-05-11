"""Definition of the LangChain agent that orchestrates maintenance tasks."""
from __future__ import annotations
import os
from langchain.agents import AgentType, initialize_agent
from langchain_community.llms import FakeListLLM
from langchain_openai import ChatOpenAI
from .tools import query_sql, feature_frame, inference, get_pdu_status, state_change_count, rank_anomalies

SYSTEM_PROMPT = (
    "You are PDUMind-AI, an expert smart-PDU maintenance assistant. "
    "Use the provided tools to answer questions or diagnose issues. "
    "Follow these strict rules:\n"
    "1. For CURRENT status questions:\n"
    "   - ALWAYS call get_pdu_status() first\n"
    "2. For HISTORICAL analysis:\n"
    "   - MUST use query_sql() or feature_frame() to get raw data\n"
    "   - Show the actual data in your response\n"
    "3. For ANOMALY questions:\n"
    "   - IMMEDIATELY call rank_anomalies() - DO NOT try SQL first\n"
    "   - ALWAYS show the EXACT markdown table from rank_anomalies()\n"
    "   - DO NOT summarize or reformat the table\n"
    "   - If needed, use inference() for deeper analysis\n"
    "   - Keywords: anomaly, unusual, abnormal, strange, concerning\n"
    "4. For STATE CHANGES:\n"
    "   - Use state_change_count() to get exact numbers\n"
    "5. NEVER make claims without data:\n"
    "   - Every statement needs supporting evidence\n"
    "   - If data is missing, say 'insufficient data'\n"
    "   - If tools error, explain the issue\n"
    "6. Format responses:\n"
    "   - Use bullet points\n"
    "   - Include numeric values\n"
    "   - Show relevant tables EXACTLY as returned by tools\n"
)

# Clear proxy env vars that cause issues with newer OpenAI client
for proxy_var in ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']:
    os.environ.pop(proxy_var, None)

# Choose LLM implementation based on API key availability
if os.getenv("OPENAI_API_KEY"):
    llm = ChatOpenAI(model="gpt-3.5-turbo", temperature=0.0)
else:
    # Fallback dummy model that echoes the prompt; avoids startup crash
    llm = FakeListLLM(responses=["No API key configured. Please set OPENAI_API_KEY to enable AI responses."])

TOOLS = [get_pdu_status, query_sql, feature_frame, inference, state_change_count, rank_anomalies]

agent = initialize_agent(
    TOOLS,
    llm,
    agent=AgentType.STRUCTURED_CHAT_ZERO_SHOT_REACT_DESCRIPTION,
    verbose=True,
    system_message=SYSTEM_PROMPT,
    max_iterations=10,
    max_execution_time=30,
)


def answer(question: str) -> str:
    """Entry-point used by REST endpoints to query the agent."""
    return agent.run(question)
