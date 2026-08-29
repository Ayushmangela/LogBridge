# Research — multi-agent communication

Papers downloaded for the A2A redesign. Read `../AGENT-ARCHITECTURE.md` for the
analysis and the resulting design; this folder is the evidence behind it.

| File | Paper | Why it matters here |
|---|---|---|
| `2503.13657-MAST-why-multiagent-fails.pdf` | **Why Do Multi-Agent LLM Systems Fail?** (Cemri, Pan, Yang et al., 2025) | 1,600+ annotated traces across 7 MAS frameworks → a 14-mode failure taxonomy. **The most directly useful paper**: our observed failures map onto it almost exactly, and they land in the categories that are fixable by architecture |
| `2505.02279.pdf` | **A Survey of Agent Interoperability Protocols** (MCP, ACP, A2A, ANP) | The protocol landscape and a phased adoption roadmap. Tells us which layer we actually need at three agents versus thirty |
| `2502.14321.pdf` | **Beyond Self-Talk: A Communication-Centric Survey of LLM-Based MAS** | Separates system-level communication (architecture, goals, protocols) from internal (strategies, paradigms). Names the four open challenges: efficiency, security, benchmarking, scalability |
| `2506.19676.pdf` | **LLM-Driven AI Agent Communication: Protocols, Security Risks, Defences** | Security of agent channels — relevant because our transport already carries sealed payloads and now carries sessions |
| `2506.05364.pdf` | **Survey of LLM Agent Communication with MCP: Design-Pattern Centric** | Classical software design patterns applied to agent comms; useful for the delivery-guarantee layer |
| `2606.19135-protocol-taxonomy.pdf` | **A Technical Taxonomy of LLM Agent Communication Protocols** | Cross-check on the protocol comparison |

## Headline finding used in the design

MAST groups failures into **foundation-model**, **system-design**, and
**agent-interaction** categories. Ours are almost entirely the latter two —
which is the good news, because those are architecture problems, not model
problems.
