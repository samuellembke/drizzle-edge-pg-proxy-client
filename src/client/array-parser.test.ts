import { describe, it, expect } from 'vitest';
import { TypeParser, PgTypeId, isArrayType, getElementTypeId } from './pg-http-client';

// Since the array parsing functions aren't exported directly,
// we'll test them through the TypeParser class which uses them internally
describe('PostgreSQL Array Parser', () => {
  const typeParser = new TypeParser();

  describe('Simple Arrays', () => {
    it('should parse empty arrays', () => {
      const emptyArray = '{}';
      // Create a parser for BOOL_ARRAY type
      const arrayParser = typeParser.getTypeParser(PgTypeId.BOOL_ARRAY);
      const result = arrayParser(emptyArray);
      expect(result).toEqual([]);
    });

    it('should parse boolean arrays', () => {
      const boolArray = '{t,f,t,t,f}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.BOOL_ARRAY);
      const result = arrayParser(boolArray);
      expect(result).toEqual([true, false, true, true, false]);
    });

    it('should parse integer arrays', () => {
      const intArray = '{1,2,3,4,5}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.INT4_ARRAY);
      const result = arrayParser(intArray);
      expect(result).toEqual([1, 2, 3, 4, 5]);
    });

    it('should parse text arrays', () => {
      const textArray = '{foo,bar,"baz, qux",quux}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.TEXT_ARRAY);
      const result = arrayParser(textArray);
      expect(result).toEqual(['foo', 'bar', 'baz, qux', 'quux']);
    });

    it('should handle NULL values', () => {
      const nullArray = '{1,NULL,3,NULL,5}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.INT4_ARRAY);
      const result = arrayParser(nullArray);
      expect(result).toEqual([1, null, 3, null, 5]);
    });
  });

  describe('Multi-dimensional Arrays', () => {
    it('should parse nested integer arrays', () => {
      const nestedArray = '{{1,2,3},{4,5,6},{7,8,9}}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.INT4_ARRAY);
      const result = arrayParser(nestedArray);
      expect(result).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    });

    it('should parse nested text arrays', () => {
      const nestedArray = '{{foo,bar},{baz,qux}}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.TEXT_ARRAY);
      const result = arrayParser(nestedArray);
      expect(result).toEqual([['foo', 'bar'], ['baz', 'qux']]);
    });

    it('should parse 3D arrays', () => {
      const array3D = '{{{1,2},{3,4}},{{5,6},{7,8}}}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.INT4_ARRAY);
      const result = arrayParser(array3D);
      expect(result).toEqual([
        [[1, 2], [3, 4]],
        [[5, 6], [7, 8]]
      ]);
    });
  });

  describe('Complex Array Elements', () => {
    it('should parse arrays with escaped quotes', () => {
      const escapedArray = '{normal,"with ""quotes""",last}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.TEXT_ARRAY);
      const result = arrayParser(escapedArray);
      // In PostgreSQL, double quotes inside a quoted string are escaped by doubling them
      // Our parser should convert "" to " in the final result
      expect(result).toEqual(['normal', 'with quotes', 'last']);
    });

    it('should parse arrays with backslash escapes', () => {
      const escapedArray = '{normal,"with \\\\backslash",last}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.TEXT_ARRAY);
      const result = arrayParser(escapedArray);
      expect(result).toEqual(['normal', 'with \\backslash', 'last']);
    });

    it('should parse date arrays', () => {
      const dateArray = '{2023-01-01,2023-02-01,2023-03-01}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.DATE_ARRAY);
      const result = arrayParser(dateArray);
      
      expect(result).toHaveLength(3);
      expect(result.every((d: Date) => d instanceof Date)).toBe(true);
      expect(result[0].getUTCFullYear()).toBe(2023);
      expect(result[0].getUTCMonth()).toBe(0); // January is 0
      expect(result[1].getUTCMonth()).toBe(1); // February is 1
      expect(result[2].getUTCMonth()).toBe(2); // March is 2
    });

    it('should parse arrays with special characters', () => {
      const specialArray = '{foo,bar baz,"comma, inside",end}';
      const arrayParser = typeParser.getTypeParser(PgTypeId.TEXT_ARRAY);
      const result = arrayParser(specialArray);
      expect(result).toEqual(['foo', 'bar baz', 'comma, inside', 'end']);
    });
  });

  describe('Type Parser Integration', () => {
    it('should parse various typed arrays', () => {
      // Mock array data for different types
      const testData = [
        { type: PgTypeId.BOOL_ARRAY, data: '{t,f,t}', expected: [true, false, true] },
        { type: PgTypeId.INT4_ARRAY, data: '{1,2,3}', expected: [1, 2, 3] },
        { type: PgTypeId.TEXT_ARRAY, data: '{foo,bar,baz}', expected: ['foo', 'bar', 'baz'] },
        { type: PgTypeId.FLOAT8_ARRAY, data: '{1.1,2.2,3.3}', expected: [1.1, 2.2, 3.3] }
      ];
      
      // Test each array type parser
      testData.forEach(test => {
        const parser = typeParser.getTypeParser(test.type);
        const result = parser(test.data);
        expect(result).toEqual(test.expected);
      });
      
      // Test date array separately because of Date object comparison
      const dateParser = typeParser.getTypeParser(PgTypeId.DATE_ARRAY);
      const dateResult = dateParser('{2023-01-01,2023-02-02}');
      expect(dateResult).toHaveLength(2);
      expect(dateResult.every((d: Date) => d instanceof Date)).toBe(true);
      expect(dateResult[0].getUTCFullYear()).toBe(2023);
      expect(dateResult[0].getUTCMonth()).toBe(0);
      expect(dateResult[1].getUTCMonth()).toBe(1);
    });
  });
});
