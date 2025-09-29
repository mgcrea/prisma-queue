import { describe, expect, it } from "vitest";
import { isValidTimeZone } from "./time";

describe("time utilities", () => {
  describe("isValidTimeZone", () => {
    it("should accept valid IANA timezone names", () => {
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("Europe/London")).toBe(true);
      expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("GMT")).toBe(true);
    });

    it("should accept timezone offsets", () => {
      expect(isValidTimeZone("GMT+8")).toBe(true);
      expect(isValidTimeZone("GMT-5")).toBe(true);
      expect(isValidTimeZone("UTC+00:00")).toBe(true);
      expect(isValidTimeZone("Etc/GMT+12")).toBe(true);
    });

    it("should reject empty strings", () => {
      expect(isValidTimeZone("")).toBe(false);
    });

    it("should reject strings with SQL injection attempts", () => {
      expect(isValidTimeZone("UTC'; DROP TABLE queue_jobs; --")).toBe(false);
      expect(isValidTimeZone("America/New_York; DELETE FROM users;")).toBe(false);
      expect(isValidTimeZone("UTC' OR '1'='1")).toBe(false);
    });

    it("should reject strings with special characters", () => {
      expect(isValidTimeZone("America/New York")).toBe(false); // space
      expect(isValidTimeZone("UTC;")).toBe(false); // semicolon
      expect(isValidTimeZone("America/New'York")).toBe(false); // single quote
      expect(isValidTimeZone('America/New"York')).toBe(false); // double quote
      expect(isValidTimeZone("America/New\nYork")).toBe(false); // newline
    });

    it("should reject overly long strings", () => {
      const longString = "A".repeat(100);
      expect(isValidTimeZone(longString)).toBe(false);
    });

    it("should accept edge case valid timezones", () => {
      expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
      expect(isValidTimeZone("America/Indiana/Indianapolis")).toBe(true);
      expect(isValidTimeZone("Pacific/Port_Moresby")).toBe(true);
    });
  });
});