"""PDUMind Predictive Maintenance Agentic AI package.

This subpackage houses the LangChain tools, agent definition and an
optional autonomous scheduler that periodically evaluates telemetry and
stores alerts.  All modules are **import-safe**; heavy imports such as
`pandas` or `sklearn` only take place when their functions are actually
invoked so that the main Flask API keeps a fast cold-start.
"""
