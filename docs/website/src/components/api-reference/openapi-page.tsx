'use client';

import { createOpenAPIPage } from 'fumadocs-openapi/ui';

/**
 * Fumadocs' own OpenAPI page: every operation's parameters, request body,
 * responses, code samples, and playground, rendered from an OpenAPI document.
 * `OpenApiReference` hands it the document of the page's documentation line.
 */
export const OpenAPIPage = createOpenAPIPage();
