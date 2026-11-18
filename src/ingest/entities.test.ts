import { describe, expect, test } from "bun:test";
import { decodeEntities } from "./entities";

describe("decodeEntities", () => {
  test.each([
    ["named entities", "&lt;b&gt; &quot;Tom&quot; &amp; Jerry&apos;s", "<b> \"Tom\" & Jerry's"],
    ["decimal BMP code points", "Line 1&#10;Line 2&#33;", "Line 1\nLine 2!"],
    ["a supplementary-plane code point", "Yes, it is &#128578;", "Yes, it is 🙂"],
    ["a pair of code points", "From &#127468;&#127463;!", "From 🇬🇧!"],
    ["hex code points", "hex &#x1F600; &#x41;", "hex 😀 A"],
    ["an out-of-range code point, left as written", "bad: &#1114112; ok", "bad: &#1114112; ok"],
    ["&amp; last, so an escaped entity decodes once", "&amp;lt; &amp;#33;", "&lt; &#33;"],
    ["text without entities, unchanged", "Hello World", "Hello World"],
  ])("decodes %s", (_name, input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });
});
