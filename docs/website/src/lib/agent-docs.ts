/**
 * Where the page telling a coding agent how to pick a corpus is published.
 *
 * A module of its own, holding nothing else, so the address can be read
 * without loading the content layer. Three places need it — the agent
 * artifacts that cite it, the navbar menu that links it, and the test holding
 * those two to one value — and the third cannot import the module that builds
 * the artifacts, which pulls in the MDX collections the test runner does not
 * resolve.
 */
export const AGENT_DOCS_URL = '/resources/docs-for-ai-agents';
