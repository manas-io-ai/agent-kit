/**
 * Tests for MCP server tools.
 * 
 * Run with: npm test
 */

import { describe, test, expect } from 'vitest';
import { wordCount, jsonTransform, hashText } from '../src/tools.js';

// ─── word_count tests ───────────────────────────────────────────────────

describe('wordCount', () => {
  test('counts a simple sentence', () => {
    const result = wordCount('Hello world, this is a test.');
    expect(result.words).toBe(6);
    expect(result.characters).toBe(28);
    expect(result.sentences).toBe(1);
  });

  test('handles empty string', () => {
    const result = wordCount('');
    expect(result.words).toBe(0);
    expect(result.characters).toBe(0);
    expect(result.sentences).toBe(0);
    expect(result.paragraphs).toBe(0);
    expect(result.readingTimeMinutes).toBe(0);
  });

  test('handles whitespace-only string', () => {
    const result = wordCount('   \n\n\t  ');
    expect(result.words).toBe(0);
  });

  test('counts multiple sentences', () => {
    const result = wordCount('First sentence. Second sentence! Third sentence?');
    expect(result.sentences).toBe(3);
  });

  test('counts paragraphs', () => {
    const result = wordCount('First paragraph.\n\nSecond paragraph.\n\nThird paragraph.');
    expect(result.paragraphs).toBe(3);
  });

  test('calculates reading time', () => {
    // 238 words per minute average
    const words = Array(238).fill('word').join(' ');
    const result = wordCount(words);
    expect(result.readingTimeMinutes).toBe(1);
  });

  test('finds longest word', () => {
    const result = wordCount('short medium extraordinary tiny');
    expect(result.longestWord).toBe('extraordinary');
  });

  test('calculates average word length', () => {
    const result = wordCount('cat dog bat');
    expect(result.averageWordLength).toBe(3);
  });
});

// ─── json_transform tests ───────────────────────────────────────────────

describe('jsonTransform', () => {
  const testData = [
    { name: 'Alice', age: 30, city: 'NYC' },
    { name: 'Bob', age: 25, city: 'LA' },
    { name: 'Charlie', age: 35, city: 'NYC' },
    { name: 'Diana', age: 28, city: 'Chicago' },
  ];

  describe('pick', () => {
    test('picks fields from array of objects', () => {
      const result = jsonTransform(testData, 'pick', ['name', 'age']) as Record<string, unknown>[];
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ name: 'Alice', age: 30 });
      expect(result[0]).not.toHaveProperty('city');
    });

    test('picks fields from single object', () => {
      const result = jsonTransform({ a: 1, b: 2, c: 3 }, 'pick', ['a', 'c']);
      expect(result).toEqual({ a: 1, c: 3 });
    });

    test('ignores non-existent fields', () => {
      const result = jsonTransform({ a: 1 }, 'pick', ['a', 'z']);
      expect(result).toEqual({ a: 1 });
    });

    test('throws on no fields', () => {
      expect(() => jsonTransform(testData, 'pick', [])).toThrow('No fields specified');
    });
  });

  describe('filter', () => {
    test('filters by equality', () => {
      const result = jsonTransform(testData, 'filter', [], {
        field: 'city',
        operator: 'eq',
        value: 'NYC',
      }) as Record<string, unknown>[];
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.city === 'NYC')).toBe(true);
    });

    test('filters by greater than', () => {
      const result = jsonTransform(testData, 'filter', [], {
        field: 'age',
        operator: 'gt',
        value: 28,
      }) as Record<string, unknown>[];
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.name)).toEqual(['Alice', 'Charlie']);
    });

    test('filters by contains', () => {
      const result = jsonTransform(testData, 'filter', [], {
        field: 'name',
        operator: 'contains',
        value: 'li',
      }) as Record<string, unknown>[];
      expect(result).toHaveLength(2); // Alice, Charlie
    });

    test('throws without condition', () => {
      expect(() => jsonTransform(testData, 'filter', [])).toThrow('No condition specified');
    });

    test('throws on non-array', () => {
      expect(() =>
        jsonTransform({ a: 1 }, 'filter', [], { field: 'a', operator: 'eq', value: 1 }),
      ).toThrow('Filter requires an array');
    });
  });

  describe('sort', () => {
    test('sorts ascending by string field', () => {
      const result = jsonTransform(testData, 'sort', ['name']) as Record<string, unknown>[];
      expect(result.map((r) => r.name)).toEqual(['Alice', 'Bob', 'Charlie', 'Diana']);
    });

    test('sorts descending by number field', () => {
      const result = jsonTransform(testData, 'sort', ['age', 'desc']) as Record<string, unknown>[];
      expect(result.map((r) => r.name)).toEqual(['Charlie', 'Alice', 'Diana', 'Bob']);
    });

    test('throws on no sort field', () => {
      expect(() => jsonTransform(testData, 'sort', [])).toThrow('No sort field specified');
    });
  });

  describe('flatten', () => {
    test('flattens nested object', () => {
      const data = { a: { b: { c: 1 } }, d: 2 };
      const result = jsonTransform(data, 'flatten');
      expect(result).toEqual({ 'a.b.c': 1, d: 2 });
    });

    test('flattens array', () => {
      const data = [{ a: 1 }, { a: 2 }];
      const result = jsonTransform(data, 'flatten');
      expect(result).toEqual({ '0.a': 1, '1.a': 2 });
    });
  });

  describe('group_by', () => {
    test('groups by field', () => {
      const result = jsonTransform(testData, 'group_by', ['city']) as Record<string, unknown[]>;
      expect(Object.keys(result)).toHaveLength(3);
      expect(result['NYC']).toHaveLength(2);
      expect(result['LA']).toHaveLength(1);
    });

    test('throws without field', () => {
      expect(() => jsonTransform(testData, 'group_by', [])).toThrow('No field specified');
    });
  });
});

// ─── hash_text tests ────────────────────────────────────────────────────

describe('hashText', () => {
  test('generates sha256 hash by default', () => {
    const result = hashText('hello');
    expect(result.algorithm).toBe('sha256');
    expect(result.hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(result.inputLength).toBe(5);
  });

  test('generates md5 hash', () => {
    const result = hashText('hello', 'md5');
    expect(result.algorithm).toBe('md5');
    expect(result.hash).toBe('5d41402abc4b2a76b9719d911017c592');
  });

  test('generates sha1 hash', () => {
    const result = hashText('hello', 'sha1');
    expect(result.algorithm).toBe('sha1');
    expect(result.hash).toBe('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
  });

  test('generates sha512 hash', () => {
    const result = hashText('hello', 'sha512');
    expect(result.algorithm).toBe('sha512');
    expect(result.hash).toHaveLength(128);
  });

  test('is case-insensitive for algorithm', () => {
    const result = hashText('test', 'SHA256');
    expect(result.algorithm).toBe('sha256');
  });

  test('throws on unsupported algorithm', () => {
    expect(() => hashText('test', 'blake2')).toThrow('Unsupported algorithm');
  });

  test('same input produces same hash', () => {
    const hash1 = hashText('deterministic', 'sha256');
    const hash2 = hashText('deterministic', 'sha256');
    expect(hash1.hash).toBe(hash2.hash);
  });

  test('different input produces different hash', () => {
    const hash1 = hashText('hello', 'sha256');
    const hash2 = hashText('world', 'sha256');
    expect(hash1.hash).not.toBe(hash2.hash);
  });

  test('reports input length', () => {
    const result = hashText('this is a longer string', 'sha256');
    expect(result.inputLength).toBe(23);
  });
});
