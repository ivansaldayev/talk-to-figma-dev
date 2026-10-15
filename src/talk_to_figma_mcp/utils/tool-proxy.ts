/**
 * Tool proxy for automatically adding transform parameter to read tools
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { transformFigmaNode } from '../transformers/node-transformer.js';
import { coerceSchemaFields } from './schema-coercion.js';

/**
 * List of read tools that should have transform parameter added
 */
export const READ_TOOLS = [
  'get_document_info',
  'get_selection',
  'read_my_design',
  'get_node_info',
  'get_node_info_raw',
  'get_nodes_info',
  'get_styles',
  'get_local_components',
  'scan_text_nodes',
  'scan_nodes_by_types',
  'get_annotations',
  'get_instance_overrides',
  'get_reactions',
] as const;

export type ReadToolName = typeof READ_TOOLS[number];

/**
 * Read tools whose response is a Figma node tree (or an array of
 * {nodeId, document} trees). Only these get the full transform parameter:
 * the node transformer would wipe out wrappers and flat lists.
 */
export const NODE_TREE_TOOLS: readonly ReadToolName[] = [
  'get_document_info',
  'read_my_design',
  'get_node_info',
  'get_node_info_raw',
  'get_nodes_info',
];

/**
 * Read tools that return flat lists, with the top-level arrays to paginate.
 * Their transform supports only pagination. A payload that is itself an
 * array (chunked scan results) is paginated as a whole.
 */
const LIST_TOOLS: Partial<Record<ReadToolName, readonly string[]>> = {
  get_selection: ['selection'],
  get_styles: ['colors', 'texts', 'effects', 'grids'],
  get_local_components: ['components'],
  scan_text_nodes: ['textNodes'],
  scan_nodes_by_types: ['matchingNodes'],
  get_annotations: ['annotatedNodes', 'annotations'],
  get_reactions: ['nodes'],
};

/**
 * Page cache for preloaded document data
 */
interface PageCache {
  documentInfo: any | null;
  timestamp: number;
  channel: string | null;
}

const pageCache: PageCache = {
  documentInfo: null,
  timestamp: 0,
  channel: null,
};

let isPreloading = false;
let getDocumentInfoHandler: Function | null = null;

/**
 * Zod schema for transform parameter
 */
const transformSchema = z.object({
  maxDepth: z.number().min(0).optional()
    .describe('Maximum depth to traverse the node tree'),
  maxChildren: z.number().min(1).optional()
    .describe('Maximum number of children per node'),
  typeFilter: z.object({
    include: z.array(z.string()).optional()
      .describe('Only include these node types (whitelist)'),
    exclude: z.array(z.string()).optional()
      .describe('Exclude these node types (blacklist)'),
    excludeMode: z.enum(['remove', 'stub']).optional()
      .describe('How to handle excluded nodes: remove or keep as stub'),
  }).optional()
    .describe('Filter nodes by type'),
  propertyFilter: z.object({
    include: z.array(z.string()).optional()
      .describe('Only include these properties'),
    exclude: z.array(z.string()).optional()
      .describe('Exclude these properties'),
  }).optional()
    .describe('Filter node properties'),
  simplifyStyles: z.boolean().optional()
    .describe('Simplify fills/strokes to minimal format'),
  includeMetadata: z.boolean().optional()
    .describe('Add metadata: _path, _truncated, _childrenCount'),
  pagination: z.object({
    page: z.number().min(0)
      .describe('Page number (0-based)'),
    pageSize: z.number().min(1).max(100)
      .describe('Number of children per page'),
  }).optional()
    .describe('Paginate children array'),
}).optional().describe('Options for filtering and transforming the response');

/**
 * Zod schema for transform parameter on list tools (pagination only)
 */
const listTransformSchema = z.object({
  pagination: z.object({
    page: z.number().min(0)
      .describe('Page number (0-based)'),
    pageSize: z.number().min(1).max(100)
      .describe('Number of items per page'),
  }).optional()
    .describe('Paginate the list; _pagination reports totals and totalPages'),
}).optional().describe('Options for limiting the list response');

/**
 * Apply transform options to a tool's JSON payload according to its kind
 */
function transformPayload(name: ReadToolName, data: any, transform: any): any {
  if (NODE_TREE_TOOLS.includes(name)) {
    const transformed = transformFigmaNode(data, transform);
    // get_document_info's root is the current page, but it also carries
    // file-level summaries that are not node properties
    if (name === 'get_document_info' && transformed && typeof transformed === 'object') {
      return { ...transformed, currentPage: data.currentPage, pages: data.pages };
    }
    return transformed;
  }

  const listKeys = LIST_TOOLS[name];
  if (listKeys && transform.pagination) {
    return paginateList(data, listKeys, transform.pagination);
  }
  return data;
}

/**
 * Paginate the given top-level arrays of a list response (or the payload
 * itself when it is an array) and report their totals in _pagination
 */
function paginateList(
  data: any,
  keys: readonly string[],
  { page, pageSize }: { page: number; pageSize: number }
): any {
  const source = Array.isArray(data) ? { items: data } : data;
  if (!source || typeof source !== 'object') {
    return data;
  }

  const start = page * pageSize;
  const paged: any = { ...source };
  const totals: Record<string, number> = {};
  for (const key of Array.isArray(data) ? ['items'] : keys) {
    if (Array.isArray(source[key])) {
      totals[key] = source[key].length;
      paged[key] = source[key].slice(start, start + pageSize);
    }
  }
  if (Object.keys(totals).length === 0) {
    return data;
  }

  const largest = Math.max(...Object.values(totals));
  paged._pagination = { page, pageSize, totals, totalPages: Math.ceil(largest / pageSize) };
  return paged;
}

/**
 * Locate the JSON payload of a tool result: the last text item that parses
 * as JSON (scan tools put status and summary text before it, get_reactions
 * a hint after it). Error messages are not JSON, so they have no payload.
 */
function findPayload(result: any): { index: number; data: any } | null {
  const content: any[] = result?.content ?? [];
  for (let index = content.length - 1; index >= 0; index--) {
    if (content[index]?.type !== 'text') continue;
    try {
      return { index, data: JSON.parse(content[index].text) };
    } catch {
      // Not JSON: status line, hint or error message
    }
  }
  return null;
}

/**
 * Replace the text of one content item, keeping the rest of the result
 */
function replacePayload(result: any, index: number, text: string): any {
  const content = [...result.content];
  content[index] = { type: 'text', text };
  return { ...result, content };
}

/**
 * One-level outline of a JSON value: arrays become "[N items]", objects
 * "{N keys}", long strings are cut. Enough to plan reading the saved file.
 */
function describeShape(data: any): any {
  const outline = (value: any): any => {
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).length} keys}`;
    if (typeof value === 'string' && value.length > 80) return `${value.slice(0, 80)}…`;
    return value;
  };
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, outline(value)]));
  }
  return outline(data);
}

/**
 * Write the response's JSON payload to savePath and return a short summary in
 * its place, so large responses stay out of the conversation. Responses
 * without a JSON payload, such as error messages, are returned unchanged.
 */
async function saveResponse(result: any, savePath: string): Promise<any> {
  const payload = findPayload(result);
  if (!payload) {
    return result;
  }

  const text: string = result.content[payload.index].text;
  const filePath = path.resolve(savePath);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, 'utf-8');
  } catch (error) {
    return {
      content: [{
        type: 'text',
        text: `Failed to save response to ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      }],
      isError: true,
    };
  }

  const summary = {
    savedTo: filePath,
    chars: text.length,
    shape: describeShape(payload.data),
  };
  return replacePayload(result, payload.index, JSON.stringify(summary));
}

/**
 * Create a proxy wrapper for server.tool that automatically adds transform parameter
 * to read tools and applies transformation to responses
 */
export function createToolProxy(originalTool: Function): Function {
  return function proxyTool(
    name: string,
    description: string,
    rawSchema: Record<string, any>,
    handler: Function
  ) {
    // Accept JSON-stringified arrays/numbers at the top level (some MCP
    // clients stringify complex args, which makes Zod reject them with
    // invalid_type before the handler ever runs).
    const schema = coerceSchemaFields(rawSchema);

    // Store get_document_info handler for preloading
    if (name === 'get_document_info') {
      getDocumentInfoHandler = handler;
    }

    // Check if this is a read tool that needs transform, savePath and noCache
    if (READ_TOOLS.includes(name as ReadToolName)) {
      const isNodeTree = NODE_TREE_TOOLS.includes(name as ReadToolName);
      const isList = LIST_TOOLS[name as ReadToolName] !== undefined;

      // Extend schema with transform, savePath, and noCache parameters
      const extendedSchema = {
        ...schema,
        ...(isNodeTree ? { transform: transformSchema } : {}),
        ...(isList ? { transform: listTransformSchema } : {}),
        savePath: z.string().optional()
          .describe('Save the full JSON response to this file and return only a summary (path, size, top-level shape) instead of the data'),
        noCache: z.boolean().optional().describe('Skip cache and fetch fresh data'),
      };

      // Extend description
      const extendedDescription = isNodeTree
        ? `${description}. Supports optional 'transform' parameter for filtering/limiting the response.`
        : isList
          ? `${description}. Supports optional 'transform.pagination' for paging through the list.`
          : description;

      // Wrap handler to apply transformation and optional file saving
      const wrappedHandler = async (params: any) => {
        const { transform, savePath, noCache, ...originalParams } = params || {};

        let result: any;
        if (name === 'get_document_info' && !noCache && !isPreloading && pageCache.documentInfo) {
          // Serve get_document_info from cache
          result = {
            content: [{
              type: 'text',
              text: JSON.stringify(pageCache.documentInfo),
            }],
          };
        } else {
          // Clear cache if noCache is true
          if (noCache && name === 'get_document_info') {
            pageCache.documentInfo = null;
          }

          // Call original handler; always pass an object, handlers destructure
          // their params (get_instance_overrides has only optional ones)
          result = await handler(originalParams);

          // Cache the result for get_document_info
          if (name === 'get_document_info' && result?.content?.[0]?.text) {
            try {
              pageCache.documentInfo = JSON.parse(result.content[0].text);
              pageCache.timestamp = Date.now();
            } catch {
              // Ignore parse errors
            }
          }
        }

        // Apply transformation if transform options provided
        const payload = transform ? findPayload(result) : null;
        if (payload) {
          try {
            const transformed = transformPayload(name as ReadToolName, payload.data, transform);
            result = replacePayload(result, payload.index, JSON.stringify(transformed));
          } catch {
            // If transformation fails, use original result
          }
        }

        return savePath ? saveResponse(result, savePath) : result;
      };

      return originalTool(name, extendedDescription, extendedSchema, wrappedHandler);
    }

    // Invalidate the document cache when the current page changes,
    // otherwise get_document_info keeps serving the previous page
    if (name === 'set_current_page') {
      const wrappedPageHandler = async (params: any) => {
        const result = await handler(params);
        pageCache.documentInfo = null;
        return result;
      };
      return originalTool(name, description, schema, wrappedPageHandler);
    }

    // Intercept join_channel for preloading
    if (name === 'join_channel') {
      const wrappedJoinHandler = async (params: any) => {
        const result = await handler(params);

        // After successful join - preload document info
        if (result?.content?.[0]?.text?.includes('Successfully joined') && getDocumentInfoHandler) {
          isPreloading = true;
          try {
            pageCache.channel = params.channel;
            const docResult = await getDocumentInfoHandler({});
            if (docResult?.content?.[0]?.text) {
              pageCache.documentInfo = JSON.parse(docResult.content[0].text);
              pageCache.timestamp = Date.now();
            }
          } catch {
            // Preload failed, cache will be populated on first request
          } finally {
            isPreloading = false;
          }
        }

        return result;
      };
      return originalTool(name, description, schema, wrappedJoinHandler);
    }

    // For non-read tools, pass through without modification
    return originalTool(name, description, schema, handler);
  };
}
