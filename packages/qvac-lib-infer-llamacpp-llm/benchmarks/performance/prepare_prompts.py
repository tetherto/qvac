#!/usr/bin/env python3
"""
Generate test prompts for LLM benchmark.

Creates static prompts of varying lengths:
- Short: ~50 tokens
- Medium: ~200 tokens
- Long: ~1000 tokens
- Context-filling: long static prompt designed to test context limits
- Batch-spanning: long static prompt designed to span multiple batches

Note: Prompts are generated once with default ctx-size/batch-size values and used statically.
Dynamic prompt generation based on runtime parameters is not currently implemented.
"""

import argparse
import json
import sys
from pathlib import Path


def generate_short_prompt():
    """Generate a short prompt (~50 tokens)."""
    return {
        "id": "short",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Answer concisely."},
            {"role": "user", "content": "What is the capital of France? Provide a brief answer."}
        ]
    }


def generate_medium_prompt():
    """Generate a medium prompt (~200 tokens)."""
    return {
        "id": "medium",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {
                "role": "user",
                "content": "Explain the difference between TCP and UDP protocols. Cover reliability, ordering, connection management, and typical use cases for each. Provide a detailed explanation."
            }
        ]
    }


def generate_long_prompt():
    """Generate a long prompt (~1000 tokens)."""
    passage = """In the spring of 1978, a coastal city commissioned a multi-year study to understand why its fishing yields had fallen by nearly 30% over a decade. The study combined dockside surveys, ocean temperature records, and interviews with ship captains. Researchers observed that the average time at sea increased, yet the total catch per vessel decreased. At the same time, they discovered a gradual but measurable shift in sea surface temperatures, especially in the shallow bays where juvenile fish typically feed.

The research team proposed three possible contributors. First, intensified trawling in the mid-1970s damaged reef habitats and reduced spawning grounds. Second, unusually warm summers in two consecutive years appeared to change the migration paths of the most common species. Third, new regulations in a neighboring region displaced fleets into the city's waters, increasing competition. None of these factors alone accounted for the full decline, but in combination they correlated strongly with the timing of reduced yields."""
    
    return {
        "id": "long",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant."},
            {
                "role": "user",
                "content": f"Summarize the passage below into 6-8 concise bullet points that capture the main facts, timeline, and conclusions. Keep the summary factual and avoid adding new information.\n\nPassage:\n{passage}"
            }
        ]
    }


def generate_context_filling_prompt(target_tokens):
    """Generate a prompt that fills context (target_tokens - 100 tokens for generation)."""
    # Estimate ~4 characters per token, so we need roughly target_tokens * 4 characters
    # We'll create a repetitive but meaningful prompt
    base_content = """You are given a long briefing that combines a fictional case study, supporting data, and open questions. Produce a detailed analysis that includes: (1) a structured summary by section, (2) a list of assumptions and uncertainties, (3) a risk assessment with likelihood and impact, (4) a prioritized set of recommendations, and (5) a short executive memo. The output should be long and exhaustive.

Briefing:
Section A: Background
A regional transportation authority launched a five-year modernization program to reduce congestion, improve safety, and cut emissions. The program includes replacing aging buses, upgrading rail signals, and introducing demand-responsive microtransit in underserved neighborhoods. The authority serves a diverse metro area with a dense urban core, a ring of mid-density suburbs, and an outer belt of small towns. Ridership has been recovering unevenly since a sharp decline two years ago. Weekday commuter trips are still down, but weekend and off-peak usage have begun to rebound.

Section B: Current Performance Data
Over the last 12 months, average bus on-time performance improved from 68% to 74%, with the largest gains on routes that received dedicated bus lanes. Rail on-time performance improved from 81% to 88% after targeted signal replacements at three bottleneck stations. However, reported safety incidents per million passenger miles increased slightly on rail due to a cluster of minor door malfunctions. The authority attributes this to deferred maintenance during the supply chain disruptions of the prior year. Emissions from the fleet fell 12% as older diesel buses were retired, but the authority remains short of its 2026 emissions target by an estimated 8%.

Section C: Financial Constraints
The modernization program is funded by a mix of federal grants (45%), local taxes (35%), and fare revenue (20%). Federal grants require quarterly reporting and adherence to specific procurement rules that can extend timelines. Local tax revenue is stable but cannot exceed a capped growth rate. Fare revenue depends on ridership, which remains uncertain due to changes in commuting patterns and the rise of hybrid work. The authority forecasts a 5% operating deficit next year unless costs are reduced or ridership exceeds current projections. Operating costs are rising due to labor agreements, fuel price volatility, and insurance premiums.

Section D: Microtransit Pilot Results
The microtransit pilot covered three neighborhoods with limited fixed-route service. It offered app-based ride requests with dynamic routing. Average wait time was 12 minutes, with a 78% on-time pickup rate. Surveys showed high satisfaction among riders who previously lacked reliable access to jobs and healthcare. However, the cost per passenger trip was high, nearly 2.5x the cost of a standard bus trip. The pilot reduced missed medical appointments by 18% in the service area, but it did not significantly reduce private car usage, suggesting it may have served latent demand rather than replacing car trips.

Section E: Infrastructure Readiness
The authority plans to deploy 80 electric buses over the next 18 months. Charging infrastructure at depots is 60% complete, with utility upgrades delayed by permitting. The grid operator requires a phased rollout to avoid peak load spikes, and the authority must coordinate charging schedules across depots. A separate plan to install regenerative braking on older rail units is still in the design phase, with uncertainty about the cost-benefit ratio given the remaining lifespan of those units.

Section F: Equity and Accessibility
Community advisory panels emphasized the need to prioritize accessibility upgrades in older stations, many of which lack elevators or tactile guidance. An audit found that 23% of stations are not fully ADA compliant. The authority has set a goal to reduce that number to 10% within three years. Advocates also requested language-accessible communications and real-time service alerts, noting that riders with limited English proficiency often rely on station signage and are less likely to use mobile apps.

Section G: Future Scenarios
Scenario analysis considers three ridership trajectories: conservative (flat ridership), moderate (3% annual growth), and optimistic (7% annual growth driven by downtown redevelopment). Each scenario affects capital planning differently. Under conservative assumptions, the authority would need to slow procurement of electric buses and defer some rail upgrades. Under optimistic assumptions, the authority could accelerate station renovations and expand microtransit to six additional neighborhoods.

Section H: Open Questions
1. Should microtransit remain a targeted equity intervention despite higher costs, or should it be scaled only where cost recovery improves?
2. How should the authority balance near-term emissions goals with long-term grid constraints?
3. What governance model best supports regional coordination across neighboring jurisdictions to reduce duplication and align fare policies?
4. How should service plans adapt to hybrid work patterns that shift peak demand to mid-day?
5. Which performance metrics should be prioritized to evaluate success beyond ridership (e.g., access to jobs, safety, equity, emissions)?

Section I: Supplementary Data
- Average bus fare: $2.25
- Average rail fare: $3.00
- Annual operating budget: $820M
- Capital program budget: $2.4B over five years
- Average trip length: bus 4.2 miles, rail 9.6 miles
- Workforce size: 6,800 employees
- Customer satisfaction (overall): 76%
- Customer satisfaction (microtransit pilot): 88%
- Annual missed trips due to maintenance: 3.1% of scheduled rail trips
- Emissions baseline year: 2018
- Emissions reduction achieved to date: 12%

Section J: Stakeholder Perspectives
Business groups support faster downtown rail upgrades but worry about construction disruptions. Neighborhood organizations prioritize accessibility and local bus frequency, even if rail expansions slow. Environmental coalitions advocate for rapid electrification and demand stricter emissions milestones. Labor unions emphasize workforce stability and training for electric fleet maintenance.

Section K: Comparative Benchmarks
Peer cities with similar population sizes have achieved bus on-time performance between 72% and 80%, and rail on-time performance between 85% and 92%. Microtransit pilots in two comparable regions reported cost per trip between 1.8x and 2.2x of standard bus service, but higher rates of replacing car trips. One peer authority reduced emissions by 20% within four years by accelerating electric bus deployment, though it faced short-term service reductions due to depot construction.

Section L: Additional Considerations
The authority's customer service channels are fragmented; riders may need to use a phone line for some issues and a separate app for others. Consolidating channels could improve satisfaction but would require a new vendor contract. Security staffing has been increased at three stations due to recent incidents, raising operating costs. The authority is exploring partnerships with universities to analyze passenger flow data, but data-sharing agreements are still under negotiation.

Section M: Data Integrity and Monitoring
The current data pipeline for on-time performance relies on GPS pings that sometimes drop in tunnels and dense urban canyons. Analysts estimate a 2-3% undercount of late arrivals due to data gaps. A modernization of the telemetry system is planned but not funded in the current budget. Real-time dashboards exist but are used inconsistently across divisions.

Section N: Risk Register (Initial)
- Risk 1: Delays in charging infrastructure due to permitting (Likelihood: High; Impact: Medium)
- Risk 2: Continued ridership volatility (Likelihood: Medium; Impact: High)
- Risk 3: Supply chain issues for electric bus components (Likelihood: Medium; Impact: Medium)
- Risk 4: Workforce training gaps for new technology (Likelihood: Medium; Impact: Medium)
- Risk 5: Community opposition to service changes (Likelihood: Low; Impact: Medium)

Section O: Timeline
Year 1: Complete 40% of electric bus procurement, replace signals at three stations, launch microtransit in three neighborhoods.
Year 2: Expand microtransit to two more neighborhoods, begin accessibility upgrades at five stations, complete 60% of depot charging infrastructure.
Year 3: Reach 80% electric bus deployment, complete accessibility upgrades at 10 stations, integrate service alerts across channels.
Year 4: Full deployment of electric buses, complete signal upgrades system-wide, expand microtransit based on evaluation.
Year 5: Review program impact, update long-term capital plan, and set new emissions targets.

Section P: Required Outputs
Provide a comprehensive analysis as requested above, but keep your final executive memo to 8-10 sentences. Use headings for each section and produce a well-structured response. Include a short list of key metrics to monitor quarterly."""
    
    # Estimate current length and pad if needed
    current_chars = len(base_content)
    estimated_tokens = current_chars // 4
    
    if estimated_tokens < target_tokens:
        # Pad with repetitive but meaningful content
        padding_needed = (target_tokens - estimated_tokens) * 4
        padding = "\n\n" + "Please provide a comprehensive analysis. " * (padding_needed // 30)
        base_content += padding
    
    return {
        "id": "ctx-filling",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Be detailed and exhaustive."},
            {"role": "user", "content": base_content}
        ],
        "dynamic": True,
        "targetTokens": "ctx_size - 100"
    }


def generate_batch_spanning_prompt(target_batch_size):
    """Generate a prompt that spans multiple batches."""
    # Estimate ~4 characters per token, batch-size is in tokens
    # We want prompt length > batch_size * 2 to ensure multiple batches
    target_chars = target_batch_size * 4 * 2  # Double the batch size
    
    base_content = """You are given a comprehensive technical document that requires detailed analysis. Please read through the entire document carefully and provide a thorough response.

Document Content:
This is a detailed technical specification document covering multiple aspects of a complex system. The document includes architecture overview, implementation details, performance characteristics, security considerations, scalability requirements, monitoring and observability strategies, deployment procedures, testing methodologies, documentation standards, and maintenance guidelines.

Architecture Overview:
The system is designed as a distributed microservices architecture with multiple independent components that communicate through well-defined APIs. Each service is responsible for a specific domain of functionality and can be developed, deployed, and scaled independently. The architecture follows principles of loose coupling, high cohesion, and separation of concerns.

Implementation Details:
The implementation uses modern programming languages and frameworks that support asynchronous processing, concurrent execution, and efficient resource utilization. Code is organized into modules with clear interfaces and minimal dependencies. Error handling is comprehensive with proper logging and monitoring at every layer.

Performance Characteristics:
The system is designed to handle high throughput with low latency. Performance optimization techniques include caching, connection pooling, batch processing, and efficient data structures. Load testing has been conducted to validate performance under various conditions.

Security Considerations:
Security is implemented at multiple layers including network security, application security, data encryption, access control, and audit logging. Regular security audits and penetration testing are conducted to identify and address vulnerabilities.

Scalability Requirements:
The system is designed to scale horizontally by adding more instances of services as needed. Auto-scaling policies are configured based on metrics such as CPU utilization, memory usage, and request queue length. Database sharding and replication strategies are employed to handle increasing data volumes.

Monitoring and Observability:
Comprehensive monitoring is implemented using industry-standard tools and practices. Metrics, logs, and traces are collected and analyzed to provide visibility into system behavior, performance, and health. Alerting is configured for critical conditions.

Deployment Procedures:
Deployment is automated using CI/CD pipelines with multiple stages including build, test, staging, and production. Rollback procedures are in place to quickly revert to previous versions if issues are detected. Blue-green and canary deployment strategies are supported.

Testing Methodologies:
Testing includes unit tests, integration tests, end-to-end tests, performance tests, and security tests. Test coverage targets are set and monitored. Automated testing is integrated into the development workflow.

Documentation Standards:
Documentation is maintained for architecture, APIs, deployment procedures, operational runbooks, and troubleshooting guides. Documentation is kept up-to-date and reviewed regularly.

Maintenance Guidelines:
Regular maintenance activities include dependency updates, security patches, performance tuning, and capacity planning. Change management processes are followed for all modifications."""
    
    # Pad if needed
    current_chars = len(base_content)
    if current_chars < target_chars:
        padding_needed = target_chars - current_chars
        padding = "\n\n" + "Please continue reading and analyzing the document. " * (padding_needed // 50)
        base_content += padding
    
    return {
        "id": "batch-spanning",
        "messages": [
            {"role": "system", "content": "You are a helpful assistant. Analyze thoroughly."},
            {"role": "user", "content": base_content}
        ],
        "dynamic": True,
        "targetTokens": "batch_size * 2"
    }


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate test prompts for LLM parameter sweep benchmark."
    )
    parser.add_argument(
        "--output",
        type=str,
        default=str(Path(__file__).parent / "test-prompts.json"),
        help="Output JSON file path (default: test-prompts.json).",
    )
    parser.add_argument(
        "--ctx-size",
        type=int,
        default=4096,
        help="Context size for generating context-filling prompt (default: 4096).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=2048,
        help="Batch size for generating batch-spanning prompt (default: 2048).",
    )
    return parser.parse_args()


def main():
    args = parse_args()
    
    prompts = [
        generate_short_prompt(),
        generate_medium_prompt(),
        generate_long_prompt(),
        generate_context_filling_prompt(args.ctx_size - 100),
        generate_batch_spanning_prompt(args.batch_size)
    ]
    
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(prompts, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8"
    )
    
    print(f"Generated {len(prompts)} test prompts to {output_path}")
    for prompt in prompts:
        print(f"  - {prompt['id']}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"prepare_prompts.py failed: {exc}", file=sys.stderr)
        sys.exit(1)
