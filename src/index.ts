#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ─── Error pattern library ───────────────────────────────────────────────────

const ERROR_PATTERNS: Array<{ regex: RegExp; label: string; severity: "CRITICAL" | "ERROR" | "WARNING" }> = [
  { regex: /\bBUILD FAILURE\b/i,               label: "Build Failure",            severity: "CRITICAL" },
  { regex: /\bBUILD FAILED\b/i,                label: "Build Failed",             severity: "CRITICAL" },
  { regex: /\bFATAL\b/,                         label: "Fatal Error",              severity: "CRITICAL" },
  { regex: /\bOOM\b|OutOfMemoryError/i,         label: "Out of Memory",            severity: "CRITICAL" },
  { regex: /\bNullPointerException\b/,          label: "NPE",                      severity: "ERROR" },
  { regex: /\bException\b.*\n?.*at\s+[\w.$]+\(/, label: "Stack Trace",            severity: "ERROR" },
  { regex: /\bERROR\b/,                         label: "Generic Error",            severity: "ERROR" },
  { regex: /\bFailed to\b/i,                    label: "Failure",                  severity: "ERROR" },
  { regex: /\bConnection refused\b/i,           label: "Connection Refused",       severity: "ERROR" },
  { regex: /\bTimeout\b|\btimed out\b/i,        label: "Timeout",                  severity: "ERROR" },
  { regex: /\bPermission denied\b/i,            label: "Permission Denied",        severity: "ERROR" },
  { regex: /\bNo such file or directory\b/i,    label: "Missing File/Directory",   severity: "ERROR" },
  { regex: /\bCannot find\b/i,                  label: "Missing Dependency",       severity: "ERROR" },
  { regex: /\bpanic:\b/i,                       label: "Go Panic",                 severity: "CRITICAL" },
  { regex: /\bsegmentation fault\b/i,           label: "Segfault",                 severity: "CRITICAL" },
  { regex: /\bWARN(ING)?\b/i,                   label: "Warning",                  severity: "WARNING" },
  { regex: /\bDeprecated\b/i,                   label: "Deprecation Warning",      severity: "WARNING" },
  { regex: /exit code [^0]/i,                   label: "Non-zero Exit Code",       severity: "ERROR" },
  { regex: /\btest.*FAIL(ED)?\b/i,              label: "Test Failure",             severity: "ERROR" },
  { regex: /\bAssertionError\b/i,               label: "Assertion Error",          severity: "ERROR" },
];

// ─── Jenkins log fetcher ──────────────────────────────────────────────────────

/** "my-ci" → "MY_CI" for env keys like JENKINS_PROFILE_MY_CI_API_TOKEN */
function profileToSuffix(profile: string): string {
  const s = profile
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) {
    throw new Error("jenkins_profile must contain at least one letter or digit.");
  }
  return s.toUpperCase();
}

function resolveJenkinsCredentials(jenkinsProfile?: string | null): string {
  const profile = jenkinsProfile?.trim();
  if (profile) {
    const suffix = profileToSuffix(profile);
    const keyBase = `JENKINS_PROFILE_${suffix}_`;
    const token =
      process.env[`${keyBase}API_TOKEN`] ?? process.env[`${keyBase}TOKEN`];
    if (!token) {
      throw new Error(
        `Profile "${profile}" has no API token: set ${keyBase}API_TOKEN (or ${keyBase}TOKEN)`
      );
    }
    const username =
      process.env[`${keyBase}USERNAME`]?.trim() ??
      process.env[`${keyBase}USER`]?.trim();
    if (username) {
      return `${username}:${token}`;
    }
    if (token.includes(":")) {
      return token;
    }
    return `:${token}`;
  }

  const apiToken = process.env.JENKINS_API_TOKEN;
  if (!apiToken) {
    throw new Error(
      "JENKINS_API_TOKEN is not set, or pass jenkins_profile for a named profile (see README)."
    );
  }
  const jenkinsUser = process.env.JENKINS_USERNAME?.trim();
  if (jenkinsUser) {
    return `${jenkinsUser}:${apiToken}`;
  }
  if (apiToken.includes(":")) {
    return apiToken;
  }
  return `:${apiToken}`;
}

async function fetchJenkinsLog(
  consoleUrl: string,
  jenkinsProfile?: string | null
): Promise<string> {
  const userPass = resolveJenkinsCredentials(jenkinsProfile);

  // Normalize to .../consoleText (Jenkins API). Handles build URLs, trailing
  // slashes, /console UI paths, and avoids .../console/consoleText.
  let logUrl = consoleUrl.trim().replace(/\/+$/, "");
  if (!/\/consoleText$/.test(logUrl)) {
    if (/\/console$/i.test(logUrl)) {
      logUrl = logUrl.replace(/\/console$/i, "");
    }
    logUrl += "/consoleText";
  }

  const authHeader = "Basic " + Buffer.from(userPass).toString("base64");

  const response = await fetch(logUrl, {
    headers: {
      Authorization: authHeader,
      "User-Agent": "jenkins-log-mcp/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Jenkins log: HTTP ${response.status} ${response.statusText} — ${logUrl}`
    );
  }

  return response.text();
}

// ─── Log analyser ─────────────────────────────────────────────────────────────

interface MatchedLine {
  lineNumber: number;
  line: string;
  label: string;
  severity: "CRITICAL" | "ERROR" | "WARNING";
}

interface AnalysisResult {
  totalLines: number;
  criticalCount: number;
  errorCount: number;
  warningCount: number;
  matches: MatchedLine[];
  summary: string;
  highlighted: string;
}

function analyzeLog(logContent: string): AnalysisResult {
  const lines = logContent.split("\n");
  const matches: MatchedLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.regex.test(line)) {
        matches.push({
          lineNumber: i + 1,
          line: line.trimEnd(),
          label: pattern.label,
          severity: pattern.severity,
        });
        break; // one label per line (highest-priority match)
      }
    }
  }

  const criticalCount = matches.filter((m) => m.severity === "CRITICAL").length;
  const errorCount    = matches.filter((m) => m.severity === "ERROR").length;
  const warningCount  = matches.filter((m) => m.severity === "WARNING").length;

  // Build a concise summary
  const summaryParts: string[] = [];
  if (criticalCount > 0) summaryParts.push(`${criticalCount} critical issue(s)`);
  if (errorCount    > 0) summaryParts.push(`${errorCount} error(s)`);
  if (warningCount  > 0) summaryParts.push(`${warningCount} warning(s)`);

  let summary: string;
  if (summaryParts.length === 0) {
    summary = "No significant errors or warnings detected. The build appears clean.";
  } else {
    summary = `Found ${summaryParts.join(", ")} in ${lines.length} log lines.\n\n`;

    // Group matches by label
    const grouped = new Map<string, MatchedLine[]>();
    for (const m of matches) {
      const bucket = grouped.get(m.label) ?? [];
      bucket.push(m);
      grouped.set(m.label, bucket);
    }

    const sections: string[] = [];
    for (const [label, items] of grouped) {
      const sev = items[0].severity;
      const prefix = sev === "CRITICAL" ? "🔴" : sev === "ERROR" ? "🟠" : "🟡";
      const lineRefs = items
        .slice(0, 5)
        .map((m) => `  Line ${m.lineNumber}: ${m.line.slice(0, 200)}`)
        .join("\n");
      const more = items.length > 5 ? `\n  … and ${items.length - 5} more` : "";
      sections.push(`${prefix} [${sev}] ${label} (${items.length} occurrence(s)):\n${lineRefs}${more}`);
    }
    summary += sections.join("\n\n");
  }

  // Build highlighted excerpt (up to 50 notable lines with context)
  const highlightLines: string[] = [];
  const contextRadius = 2;
  const notableIndexes = new Set(matches.map((m) => m.lineNumber - 1));
  const includedIndexes = new Set<number>();

  for (const idx of notableIndexes) {
    for (let c = Math.max(0, idx - contextRadius); c <= Math.min(lines.length - 1, idx + contextRadius); c++) {
      includedIndexes.add(c);
    }
  }

  const sortedIndexes = Array.from(includedIndexes).sort((a, b) => a - b);
  let lastIdx = -1;
  for (const idx of sortedIndexes) {
    if (lastIdx !== -1 && idx > lastIdx + 1) {
      highlightLines.push(`  … (${idx - lastIdx - 1} lines omitted) …`);
    }
    const match = matches.find((m) => m.lineNumber === idx + 1);
    const marker = match
      ? match.severity === "CRITICAL" ? ">>>>> "
        : match.severity === "ERROR"  ? ">>>   "
        : ">>    "
      : "      ";
    highlightLines.push(`${marker}${String(idx + 1).padStart(6)}: ${lines[idx]}`);
    lastIdx = idx;
    if (highlightLines.length >= 300) {
      highlightLines.push("  … (output truncated) …");
      break;
    }
  }

  return {
    totalLines: lines.length,
    criticalCount,
    errorCount,
    warningCount,
    matches,
    summary,
    highlighted: highlightLines.join("\n"),
  };
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "jenkins-log-mcp",
  version: "1.0.0",
});

// Tool 1: fetch_jenkins_log
server.tool(
  "fetch_jenkins_log",
  "Fetch the raw console log from a Jenkins build URL. " +
  "Auth: default JENKINS_USERNAME + JENKINS_API_TOKEN, or optional jenkins_profile " +
  "for per-server credentials (see README).",
  {
    console_url: z
      .string()
      .url()
      .describe(
        "The Jenkins build URL or direct consoleText URL, e.g. " +
        "https://jenkins.example.com/job/my-job/42/ or .../42/consoleText"
      ),
    jenkins_profile: z
      .string()
      .optional()
      .describe(
        "Named credential profile. Loads JENKINS_PROFILE_<NAME>_USERNAME and " +
        "JENKINS_PROFILE_<NAME>_API_TOKEN where NAME is this string uppercased " +
        "with non-alphanumerics replaced by _. Omit for default env credentials."
      ),
  },
  async ({ console_url, jenkins_profile }) => {
    const log = await fetchJenkinsLog(console_url, jenkins_profile);
    return {
      content: [
        {
          type: "text",
          text: log,
        },
      ],
    };
  }
);

// Tool 2: analyze_jenkins_log
server.tool(
  "analyze_jenkins_log",
  "Analyze a Jenkins console log (raw text) for errors and warnings. " +
  "Returns a structured summary with highlighted important lines.",
  {
    log_content: z
      .string()
      .describe("The raw Jenkins console log text to analyze."),
  },
  async ({ log_content }) => {
    const result = analyzeLog(log_content);
    const output = [
      `## Jenkins Log Analysis`,
      ``,
      `**Total lines:** ${result.totalLines}`,
      `**Critical:** ${result.criticalCount}  |  **Errors:** ${result.errorCount}  |  **Warnings:** ${result.warningCount}`,
      ``,
      `### Summary`,
      result.summary,
      ``,
      ...(result.highlighted
        ? [`### Highlighted Log Excerpt`, "```", result.highlighted, "```"]
        : []),
    ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  }
);

// Tool 3: fetch_and_analyze_jenkins_log (convenience combo)
server.tool(
  "fetch_and_analyze_jenkins_log",
  "Fetch the console log from a Jenkins build URL and immediately analyze it for errors and warnings. " +
  "Same auth as fetch_jenkins_log (default env or jenkins_profile).",
  {
    console_url: z
      .string()
      .url()
      .describe(
        "The Jenkins build URL or direct consoleText URL, e.g. " +
        "https://jenkins.example.com/job/my-job/42/"
      ),
    jenkins_profile: z
      .string()
      .optional()
      .describe(
        "Named credential profile (same as fetch_jenkins_log). " +
        "Omit to use JENKINS_USERNAME / JENKINS_API_TOKEN."
      ),
  },
  async ({ console_url, jenkins_profile }) => {
    const log = await fetchJenkinsLog(console_url, jenkins_profile);
    const result = analyzeLog(log);

    const output = [
      `## Jenkins Log Analysis`,
      `**Source:** ${console_url}`,
      ...(jenkins_profile ? [`**Profile:** ${jenkins_profile}`] : []),
      ``,
      `**Total lines:** ${result.totalLines}`,
      `**Critical:** ${result.criticalCount}  |  **Errors:** ${result.errorCount}  |  **Warnings:** ${result.warningCount}`,
      ``,
      `### Summary`,
      result.summary,
      ``,
      ...(result.highlighted
        ? [`### Highlighted Log Excerpt`, "```", result.highlighted, "```"]
        : []),
    ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: output,
        },
      ],
    };
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
