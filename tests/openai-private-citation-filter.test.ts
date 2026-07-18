import { describe, expect, test } from "bun:test";

import {
  filterOpenAiPrivateCitations,
  OpenAiPrivateCitationStreamFilter,
} from "../src/runtimes/openai/private-citation-filter";

const CITATION_ONE = "\uE200cite\uE202turn7search12\uE201";
const CITATION_MANY = "\uE200cite\uE202turn2view0\uE202turn8view0\uE201";

describe("OpenAI private citation filter", () => {
  test("removes complete private citation markup without changing surrounding text", () => {
    expect(filterOpenAiPrivateCitations(`before${CITATION_ONE}after`)).toEqual({
      privateCitationCount: 1,
      text: "beforeafter",
    });
  });

  test("counts citation envelopes rather than provider references", () => {
    expect(filterOpenAiPrivateCitations(`a${CITATION_MANY}b${CITATION_ONE}`)).toEqual({
      privateCitationCount: 2,
      text: "ab",
    });
  });

  test("preserves unrelated private-use characters and malformed markup", () => {
    expect(filterOpenAiPrivateCitations("before\uE200other\uE201after")).toEqual({
      privateCitationCount: 0,
      text: "before\uE200other\uE201after",
    });
    expect(filterOpenAiPrivateCitations("before\uE200cite\uE202turn7search12")).toEqual({
      privateCitationCount: 0,
      text: "before\uE200cite\uE202turn7search12",
    });
  });

  test("holds citation markup split across streaming deltas", () => {
    const filter = new OpenAiPrivateCitationStreamFilter();

    expect(filter.push("before\uE200ci")).toEqual({
      privateCitationCount: 0,
      text: "before",
    });
    expect(filter.push("te\uE202turn7search")).toEqual({
      privateCitationCount: 0,
      text: "",
    });
    expect(filter.push("12\uE201after")).toEqual({
      privateCitationCount: 1,
      text: "after",
    });
    expect(filter.finish()).toEqual({
      privateCitationCount: 0,
      text: "",
    });
  });

  test("flushes incomplete markup when the stream ends", () => {
    const filter = new OpenAiPrivateCitationStreamFilter();

    expect(filter.push("before\uE200cite\uE202turn7search12")).toEqual({
      privateCitationCount: 0,
      text: "before",
    });
    expect(filter.finish()).toEqual({
      privateCitationCount: 0,
      text: "\uE200cite\uE202turn7search12",
    });
  });

  test("bounds an unclosed private citation without exposing its payload", () => {
    const filter = new OpenAiPrivateCitationStreamFilter();

    expect(filter.push(`before\uE200cite\uE202${"x".repeat(5_000)}`)).toEqual({
      privateCitationCount: 0,
      text: "before",
    });
    expect(filter.push("\uE201after")).toEqual({
      privateCitationCount: 1,
      text: "after",
    });
  });
});
