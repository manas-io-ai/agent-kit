/**
 * Tool implementations for the MCP server.
 * 
 * Each tool is a pure function — easy to test, no side effects.
 */

import { createHash } from 'crypto';

// ─── Tool 1: Word Count ─────────────────────────────────────────────────

export interface WordCountResult {
  characters: number;
  charactersNoSpaces: number;
  words: number;
  sentences: number;
  paragraphs: number;
  readingTimeMinutes: number;
  averageWordLength: number;
  longestWord: string;
}

export function wordCount(text: string): WordCountResult {
  if (!text || !text.trim()) {
    return {
      characters: 0,
      charactersNoSpaces: 0,
      words: 0,
      sentences: 0,
      paragraphs: 0,
      readingTimeMinutes: 0,
      averageWordLength: 0,
      longestWord: '',
    };
  }

  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s/g, '').length;
  
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  
  const wordCount = words.length;

  // Sentences: split on . ? ! (accounting for abbreviations)
  const sentences = text
    .split(/[.!?]+/)
    .filter((s) => s.trim().length > 0).length;

  // Paragraphs: separated by double newlines
  const paragraphs = text
    .split(/\n\s*\n/)
    .filter((p) => p.trim().length > 0).length || 1;

  // Average reading speed: 238 words per minute
  const readingTimeMinutes = Math.round((wordCount / 238) * 10) / 10;

  // Average word length
  const totalWordLength = words.reduce((sum, w) => sum + w.replace(/[^a-zA-Z]/g, '').length, 0);
  const averageWordLength = wordCount > 0 ? Math.round((totalWordLength / wordCount) * 10) / 10 : 0;

  // Longest word
  const longestWord = words.reduce(
    (longest, w) => (w.length > longest.length ? w : longest),
    '',
  );

  return {
    characters,
    charactersNoSpaces,
    words: wordCount,
    sentences,
    paragraphs,
    readingTimeMinutes,
    averageWordLength,
    longestWord: longestWord.replace(/[^a-zA-Z'-]/g, ''),
  };
}

// ─── Tool 2: JSON Transform ─────────────────────────────────────────────

export type TransformOperation = 'pick' | 'filter' | 'sort' | 'flatten' | 'group_by';

export interface FilterCondition {
  field: string;
  operator: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';
  value: unknown;
}

export function jsonTransform(
  data: Record<string, unknown> | unknown[],
  operation: TransformOperation,
  fields: string[] = [],
  condition?: FilterCondition,
): unknown {
  switch (operation) {
    case 'pick':
      return pickFields(data, fields);
    case 'filter':
      return filterData(data, condition);
    case 'sort':
      return sortData(data, fields);
    case 'flatten':
      return flattenData(data);
    case 'group_by':
      return groupByField(data, fields[0]);
    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

function pickFields(data: Record<string, unknown> | unknown[], fields: string[]): unknown {
  if (fields.length === 0) throw new Error('No fields specified for pick operation');

  if (Array.isArray(data)) {
    return data.map((item) => {
      if (typeof item !== 'object' || item === null) return item;
      const picked: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in (item as Record<string, unknown>)) {
          picked[field] = (item as Record<string, unknown>)[field];
        }
      }
      return picked;
    });
  }

  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in data) {
      picked[field] = data[field];
    }
  }
  return picked;
}

function filterData(data: Record<string, unknown> | unknown[], condition?: FilterCondition): unknown {
  if (!condition) throw new Error('No condition specified for filter operation');
  if (!Array.isArray(data)) throw new Error('Filter requires an array');

  return data.filter((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const value = (item as Record<string, unknown>)[condition.field];
    return compare(value, condition.operator, condition.value);
  });
}

function compare(actual: unknown, operator: string, expected: unknown): boolean {
  switch (operator) {
    case 'eq':
      return actual === expected;
    case 'neq':
      return actual !== expected;
    case 'gt':
      return Number(actual) > Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    case 'gte':
      return Number(actual) >= Number(expected);
    case 'lte':
      return Number(actual) <= Number(expected);
    case 'contains':
      return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    default:
      throw new Error(`Unknown operator: ${operator}`);
  }
}

function sortData(data: Record<string, unknown> | unknown[], fields: string[]): unknown {
  if (!Array.isArray(data)) throw new Error('Sort requires an array');
  if (fields.length === 0) throw new Error('No sort field specified');

  const field = fields[0];
  const direction = fields[1]?.toLowerCase() === 'desc' ? -1 : 1;

  return [...data].sort((a, b) => {
    const aVal = typeof a === 'object' && a !== null ? (a as Record<string, unknown>)[field] : a;
    const bVal = typeof b === 'object' && b !== null ? (b as Record<string, unknown>)[field] : b;

    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return aVal.localeCompare(bVal) * direction;
    }
    return (Number(aVal) - Number(bVal)) * direction;
  });
}

function flattenData(data: Record<string, unknown> | unknown[], prefix: string = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (Array.isArray(data)) {
    data.forEach((item, index) => {
      const key = prefix ? `${prefix}.${index}` : `${index}`;
      if (typeof item === 'object' && item !== null) {
        Object.assign(result, flattenData(item as Record<string, unknown>, key));
      } else {
        result[key] = item;
      }
    });
  } else if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null) {
        Object.assign(result, flattenData(value as Record<string, unknown>, fullKey));
      } else {
        result[fullKey] = value;
      }
    }
  }

  return result;
}

function groupByField(data: Record<string, unknown> | unknown[], field?: string): Record<string, unknown[]> {
  if (!Array.isArray(data)) throw new Error('group_by requires an array');
  if (!field) throw new Error('No field specified for group_by');

  const groups: Record<string, unknown[]> = {};
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue;
    const key = String((item as Record<string, unknown>)[field] ?? 'undefined');
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

// ─── Tool 3: Hash Text ──────────────────────────────────────────────────

export interface HashResult {
  algorithm: string;
  hash: string;
  inputLength: number;
}

const SUPPORTED_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512'] as const;

export function hashText(text: string, algorithm: string = 'sha256'): HashResult {
  const algo = algorithm.toLowerCase();
  
  if (!SUPPORTED_ALGORITHMS.includes(algo as typeof SUPPORTED_ALGORITHMS[number])) {
    throw new Error(
      `Unsupported algorithm: ${algorithm}. Supported: ${SUPPORTED_ALGORITHMS.join(', ')}`,
    );
  }

  const hash = createHash(algo).update(text, 'utf-8').digest('hex');

  return {
    algorithm: algo,
    hash,
    inputLength: text.length,
  };
}
