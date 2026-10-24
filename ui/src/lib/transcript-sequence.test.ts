import { expect, it } from "vitest";
import { TranscriptSequence } from "./transcript-sequence";

it("keeps a second gap pending when it arrives during the first history read", () => {
  const cursor = new TranscriptSequence();
  cursor.confirm(1);
  expect(cursor.observe(3)).toBe(true);
  expect(cursor.observe(5)).toBe(true);
  cursor.confirm(3);
  expect(cursor.needsCatchup).toBe(true);
  cursor.confirm(5);
  expect(cursor.needsCatchup).toBe(false);
  expect(cursor.observe(6)).toBe(false);
  expect(cursor.persisted).toBe(5);
});

it("accepts out-of-order and duplicate stream rows without advancing the history cursor", () => {
  const cursor = new TranscriptSequence();
  cursor.confirm(20);
  expect(cursor.observe(19)).toBe(false);
  expect(cursor.observe(21)).toBe(false);
  expect(cursor.observe(21)).toBe(false);
  expect(cursor.persisted).toBe(20);
});
