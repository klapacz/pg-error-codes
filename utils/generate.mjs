/// <references types="node" />
// @ts-check

import fs from "node:fs/promises";
import { z } from "zod";
import prettier from "prettier";

const sectionRegex = /^Section:\s(?<description>.*)$/;
const SectionMatchGroups = z.object({ description: z.string().optional() });

/**
 * @param {string} line
 */
function parseSectionLine(line) {
  const matches = sectionRegex.exec(line);
  const section = matches?.groups
    ? SectionMatchGroups.parse(matches.groups).description
    : undefined;
  return section;
}

const errorLineRegex =
  /^(?<sqlstate>[A-Z0-9]*)\s*(?<severity>[EWS])\s*ERRCODE_(?<constant>[A-Z_]*)\s*(?<code>[a-z_]*)$/;
const ErrorLineMatchGroups = z.object({
  sqlstate: z.string(),
  severity: z.string(),
  constant: z.string(),
  code: z.string(),
});

/**
 * @param {string} line
 */
function parseErrorLine(line) {
  const matches = errorLineRegex.exec(line);
  if (!matches?.groups) {
    throw new Error(`Error parsing error line:\n\t"${line}"`);
  }
  return ErrorLineMatchGroups.parse(matches.groups);
}

/**
 * @typedef {[description: string, lines: z.output<typeof ErrorLineMatchGroups>[]]} Section
 * @typedef {Section[]} Sections
 */

/**
 * @param {string} text
 */
async function generateTypescript(text) {
  const entries = text
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .reduce((acc, line) => {
      // if line is a section, add a new section
      const section = parseSectionLine(line);
      if (section) {
        /** @type {Sections} */
        const sections = [...acc, [section, []]];
        return sections;
      }

      // otherwise, line should be error line, add it to last section
      const error = parseErrorLine(line);
      const lastSection = acc.at(-1);
      if (!lastSection) {
        throw new Error(
          `Error found error line before any section:\n\t"${line}"`,
        );
      }

      // TODO: replace with Array.prototype.with when types available
      /** @type {Sections} */
      const result = acc.map((section) => {
        if (section[0] === lastSection[0]) {
          return [section[0], [...section[1], error]];
        }
        return section;
      });
      return result;
    }, /** @type {Sections} */ ([]));

  const unformattedCode = [
    "export const pgErrors = {",
    entries
      .flatMap(([description, errors]) =>
        errors.map(
          (error) =>
            `/** ${description}: [${error.severity}] ${error.code} */\n  ${error.constant}: '${error.sqlstate}',`,
        ),
      )
      .join("\n"),
    "} as const",
    "",
    "export type PgError = keyof typeof pgErrors",
  ].join("\n");

  const code = await prettier.format(unformattedCode, {
    parser: "babel-ts",
  });
  return code;
}

function sourceUrl(branch = "master") {
  return `https://github.com/postgres/postgres/raw/${branch}/src/backend/utils/errcodes.txt`;
}

async function getSourceText() {
  const response = await fetch(sourceUrl());
  if (!response.ok) {
    throw new Error(`Error fetching errcodes.txt: ${response.status}`);
  }
  const text = await response.text();
  return text;
}

const input = await getSourceText();
const code = await generateTypescript(input);

await fs.writeFile("./src/index.ts", code);
console.log("Code generated!");
